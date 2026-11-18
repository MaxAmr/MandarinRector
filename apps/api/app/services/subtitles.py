"""Servicio puro de decodificación, parseo, limpieza y detección de idioma de subtítulos."""

from dataclasses import dataclass, field
from pathlib import Path
import re
import warnings

from charset_normalizer import from_bytes
import pysubs2

MAX_SUBTITLE_BYTES_DEFAULT = 5 * 1024 * 1024  # 5 MiB
MAX_CUES_DEFAULT = 20_000
LANGUAGE_SAMPLE_LIMIT = 200

ASS_OVERRIDE_TAG_RE = re.compile(r"\{[^}]*\}")
ASS_DRAWING_TAG_RE = re.compile(r"\{[^}]*\\p[1-9]\d*[^}]*\}")
VTT_INLINE_TIMESTAMP_RE = re.compile(r"<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>")
HTML_VOICE_TAG_RE = re.compile(r"<v(?:\.[^>\s]+)?\s+[^>]*>", re.IGNORECASE)
HTML_GENERIC_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")
ZERO_WIDTH_CHARS_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

# Conjunto de caracteres frecuentes en subtítulos chinos (simplificado y tradicional)
# para desempatar heurísticamente entre GB18030 y Big5 cuando ambos decodifican sin error.
COMMON_HANZI = frozenset(
    "的一是不了人我在有他这为之大来以个中上们到说国和地也子时道出而要于就下得可你年生"
    "自会那后能对着事其里所去行过家十用发天如然作方成者多日都三小军二无同么经法当起与"
    "好看学进种将还分此心前面又定见只主没公从知什些现想民那正实把被给听话儿点真全才"
    "已明友愛說這們個來時會過對裡後發當與進種將還見只沒從現點話兒頭開長門問間樣動"
    "體機電實聽關師學語漢國台灣香港世界朋友謝再見你好嗎請對不起謝謝老師學生電影字幕測試"
)


class SubtitleError(ValueError):
    """Error base del servicio de subtítulos."""


class SubtitleTooLargeError(SubtitleError):
    """El archivo de subtítulos supera el límite de bytes permitido."""


class SubtitleParseError(SubtitleError):
    """El archivo de subtítulos no se pudo parsear o no contiene cues válidos."""


@dataclass(slots=True)
class CueData:
    idx: int
    start_ms: int
    end_ms: int
    text: str


@dataclass(slots=True)
class ParsedSubtitles:
    cues: list[CueData]
    source_format: str
    warnings: list[str] = field(default_factory=list)
    skipped: int = 0


def _is_cjk_ideograph(codepoint: int) -> bool:
    return (0x4E00 <= codepoint <= 0x9FFF) or (0x3400 <= codepoint <= 0x4DBF)


def _is_cjk_punctuation(codepoint: int) -> bool:
    return (
        (0x3000 <= codepoint <= 0x303F)
        or (0xFF00 <= codepoint <= 0xFFEF)
        or (0x2010 <= codepoint <= 0x2027)
    )


def _score_cjk_candidate(text: str) -> float:
    """Calcula un puntaje de calidad CJK sobre un texto decodificado sin U+FFFD."""
    if not text or "\ufffd" in text:
        return -1.0

    total_non_space = 0
    cjk_count = 0
    common_count = 0
    suspicious_count = 0

    for ch in text:
        if ch.isspace():
            continue
        total_non_space += 1
        cp = ord(ch)
        if cp < 0x80:
            continue
        if _is_cjk_ideograph(cp):
            cjk_count += 1
            if ch in COMMON_HANZI:
                common_count += 1
        elif _is_cjk_punctuation(cp):
            cjk_count += 0.5
        elif (0x3040 <= cp <= 0x30FF) or (0xAC00 <= cp <= 0xD7AF):
            # Kana o Hangul legítimos
            cjk_count += 0.5
        else:
            # Caracteres no ASCII fuera de bloques CJK (típico mojibake al decodificar Big5 como GB18030 o viceversa)
            suspicious_count += 1

    if total_non_space == 0 or cjk_count == 0:
        return 0.0

    cjk_ratio = cjk_count / total_non_space
    common_ratio = common_count / max(1.0, cjk_count)
    suspicious_penalty = (suspicious_count / total_non_space) * 2.5
    return cjk_ratio + (common_ratio * 0.75) - suspicious_penalty


def _canonical_encoding_name(enc: str) -> str:
    lower = enc.lower().replace("_", "-")
    if lower in {"gbk", "gb2312", "gb18030"}:
        return "gb18030"
    if lower in {"big5", "big5hkscs", "big5-tw", "cp950"}:
        return "big5"
    if lower in {"utf-8", "ascii"}:
        return "utf-8"
    return lower


def decode_subtitle_bytes(
    raw: bytes,
    max_bytes: int = MAX_SUBTITLE_BYTES_DEFAULT,
) -> tuple[str, str]:
    """Decodifica bytes crudos de un archivo de subtítulos devolviendo `(texto, encoding)`.

    Orden de detección:
    a. BOM (utf-8-sig, utf-16-le, utf-16-be, utf-32).
    b. UTF-8 estricto.
    c. `charset-normalizer` (`from_bytes`) evaluado junto con heurística CJK.
    d. Prueba explícita de `gb18030` y `big5`/`big5hkscs` eligiendo mayor proporción CJK limpia.
    e. Último recurso: `cp1252`/`latin-1` con `errors="replace"`.
    """
    if len(raw) > max_bytes:
        raise SubtitleTooLargeError(
            f"El archivo de subtítulos excede el tamaño máximo permitido ({max_bytes} bytes)."
        )
    if not raw:
        raise SubtitleParseError("El archivo de subtítulos está vacío.")

    # a. Detección explícita de BOM
    if raw.startswith(b"\xff\xfe\x00\x00"):
        return raw[4:].decode("utf-32-le", errors="strict"), "utf-32-le"
    if raw.startswith(b"\x00\x00\xfe\xff"):
        return raw[4:].decode("utf-32-be", errors="strict"), "utf-32-be"
    if raw.startswith(b"\xef\xbb\xbf"):
        return raw.decode("utf-8-sig", errors="strict"), "utf-8-sig"
    if raw.startswith(b"\xff\xfe"):
        return raw[2:].decode("utf-16-le", errors="strict"), "utf-16-le"
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", errors="strict"), "utf-16-be"

    # b. UTF-8 estricto (siempre que no contenga bytes nulos de un UTF-16 sin BOM)
    if b"\x00" not in raw:
        try:
            decoded_utf8 = raw.decode("utf-8", errors="strict")
            return decoded_utf8, "utf-8"
        except UnicodeDecodeError:
            pass

    # d. Evaluar candidatos CJK (gb18030 y big5/big5hkscs) sin U+FFFD
    cjk_candidates: list[tuple[float, str, str]] = []
    for enc_try, canonical_label in (
        ("gb18030", "gb18030"),
        ("big5", "big5"),
        ("big5hkscs", "big5"),
    ):
        try:
            decoded_cjk = raw.decode(enc_try, errors="strict")
        except UnicodeDecodeError:
            continue
        score = _score_cjk_candidate(decoded_cjk)
        if score > 0:
            cjk_candidates.append((score, canonical_label, decoded_cjk))

    # c. charset-normalizer
    cn_matches = from_bytes(raw)
    cn_best = cn_matches.best()

    if cjk_candidates:
        cjk_candidates.sort(key=lambda item: item[0], reverse=True)
        best_cjk_score, best_cjk_enc, best_cjk_text = cjk_candidates[0]
        if best_cjk_score >= 0.12:
            return best_cjk_text, best_cjk_enc

    if cn_best is not None and cn_best.chaos < 0.4:
        cn_text = str(cn_best)
        cn_enc = _canonical_encoding_name(cn_best.encoding)
        if "\ufffd" not in cn_text:
            return cn_text, cn_enc

    if cjk_candidates:
        _, best_cjk_enc, best_cjk_text = cjk_candidates[0]
        return best_cjk_text, best_cjk_enc

    if cn_best is not None:
        return str(cn_best), _canonical_encoding_name(cn_best.encoding)

    # e. Último recurso: cp1252 / latin-1 con errors="replace"
    try:
        return raw.decode("cp1252", errors="replace"), "cp1252"
    except Exception:
        return raw.decode("latin-1", errors="replace"), "latin-1"


def _strip_vtt_non_cue_blocks(vtt_text: str) -> str:
    """Elimina bloques NOTE, STYLE, REGION e identificadores alfanuméricos de cue en WebVTT."""
    lines = vtt_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out_lines: list[str] = []
    in_ignored_block = False
    n = len(lines)

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if in_ignored_block:
            if stripped == "":
                in_ignored_block = False
                out_lines.append("")
            continue

        if (
            stripped.startswith("NOTE")
            and (len(stripped) == 4 or stripped[4].isspace())
        ) or stripped in {"STYLE", "REGION"}:
            in_ignored_block = True
            continue

        # Si la línea actual no contiene '-->', la anterior estaba vacía y la siguiente es un timestamp '-->',
        # es un identificador de cue WebVTT (si no es numérico, pysubs2 lo concatena al cue previo).
        prev_empty = not out_lines or out_lines[-1].strip() == ""
        next_is_timing = (idx + 1 < n) and ("-->" in lines[idx + 1])
        if stripped and "-->" not in stripped and prev_empty and next_is_timing and not stripped.isdigit():
            continue

        out_lines.append(line)

    return "\n".join(out_lines)


def clean_cue_text(raw_text: str) -> str:
    """Limpia tags ASS, HTML/VTT, espacios de ancho cero y normaliza saltos de línea sin usar NFKC."""
    text = ZERO_WIDTH_CHARS_RE.sub("", raw_text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Convertir saltos de línea ASS (\N y \n) y espacio duro (\h) antes de eliminar tags
    text = text.replace("\\N", "\n").replace("\\n", "\n").replace("\\h", " ")
    # Eliminar override tags ASS {\...}
    text = ASS_OVERRIDE_TAG_RE.sub("", text)
    # Eliminar timestamps inline de VTT <00:00:01.000>
    text = VTT_INLINE_TIMESTAMP_RE.sub("", text)
    # Eliminar tags <v Speaker> y cualquier otro tag HTML/VTT (<i>, <b>, <c.yellow>, </c>, etc.)
    text = HTML_VOICE_TAG_RE.sub("", text)
    text = HTML_GENERIC_TAG_RE.sub("", text)
    text = CONTROL_CHARS_RE.sub("", text)

    # Normalizar por línea: strip() y colapsar líneas vacías
    cleaned_lines = [line.strip() for line in text.split("\n")]
    non_empty_lines = [line for line in cleaned_lines if line]
    return "\n".join(non_empty_lines)


def _infer_format_from_filename(filename: str) -> str | None:
    ext = Path(filename).suffix.lower().lstrip(".")
    if ext in {"srt", "ass", "ssa", "vtt"}:
        return ext
    return None


def _normalize_source_format(pysubs_format: str | None, filename: str) -> str:
    ext_fmt = _infer_format_from_filename(filename)
    fmt = (pysubs_format or "").lower()
    if fmt == "subrip":
        return "srt"
    if fmt == "webvtt":
        return "vtt"
    if fmt in {"srt", "ass", "ssa", "vtt"}:
        if fmt == "ass" and ext_fmt == "ssa":
            return "ssa"
        return fmt
    return ext_fmt or "srt"


def parse_subtitles(
    text: str,
    filename: str = "subtitles.srt",
    max_cues: int = MAX_CUES_DEFAULT,
) -> ParsedSubtitles:
    """Parsea el contenido de un archivo de subtítulos usando pysubs2 y normaliza sus eventos."""
    cleaned_input = ZERO_WIDTH_CHARS_RE.sub("", text)
    if not cleaned_input or not cleaned_input.strip():
        raise SubtitleParseError("El archivo de subtítulos no contiene texto válido.")

    # Si hay proporción excesiva de caracteres de control nulos/binarios, rechazar temprano
    control_count = len(CONTROL_CHARS_RE.findall(text))
    if control_count > max(10, len(text) // 10):
        raise SubtitleParseError(
            "El archivo parece ser binario o estar corrupto y no es un subtítulo válido."
        )

    ext_format = _infer_format_from_filename(filename)
    looks_like_vtt = cleaned_input.lstrip().startswith("WEBVTT") or ext_format == "vtt"

    parse_input = (
        _strip_vtt_non_cue_blocks(cleaned_input) if looks_like_vtt else cleaned_input
    )

    subs: pysubs2.SSAFile | None = None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if looks_like_vtt:
            try:
                subs = pysubs2.SSAFile.from_string(parse_input, format_="vtt")
            except Exception:
                subs = None

        if subs is None:
            try:
                subs = pysubs2.SSAFile.from_string(parse_input)
            except Exception:
                if ext_format:
                    try:
                        subs = pysubs2.SSAFile.from_string(
                            parse_input, format_=ext_format
                        )
                    except Exception as exc:
                        raise SubtitleParseError(
                            f"No se pudo parsear el archivo de subtítulos ({ext_format}): {exc}"
                        ) from exc
                else:
                    raise SubtitleParseError(
                        "Formato de subtítulos irreconocible o archivo corrupto."
                    )

    source_format = _normalize_source_format(getattr(subs, "format", None), filename)

    raw_cues: list[tuple[int, int, str]] = []
    skipped_comments = 0
    skipped_drawings = 0
    skipped_invalid_time = 0
    skipped_empty = 0

    for event in subs.events:
        if getattr(event, "is_comment", False):
            skipped_comments += 1
            continue

        raw_event_text = getattr(event, "text", "") or ""
        if getattr(event, "is_drawing", False) or ASS_DRAWING_TAG_RE.search(
            raw_event_text
        ):
            skipped_drawings += 1
            continue

        start_ms = int(event.start)
        end_ms = int(event.end)
        if start_ms < 0 or end_ms <= start_ms:
            skipped_invalid_time += 1
            continue

        normalized_text = clean_cue_text(raw_event_text)
        if not normalized_text:
            skipped_empty += 1
            continue

        raw_cues.append((start_ms, end_ms, normalized_text))

    parse_warnings: list[str] = []
    if skipped_invalid_time > 0:
        parse_warnings.append(
            f"Se descartaron {skipped_invalid_time} cue(s) con tiempos inválidos (end <= start o start < 0)."
        )
    if skipped_empty > 0:
        parse_warnings.append(
            f"Se descartaron {skipped_empty} cue(s) vacíos tras limpiar etiquetas."
        )
    if skipped_drawings > 0:
        parse_warnings.append(
            f"Se descartaron {skipped_drawings} evento(s) ASS de dibujo vectorial."
        )
    if skipped_comments > 0:
        parse_warnings.append(
            f"Se ignoraron {skipped_comments} evento(s) de comentario."
        )

    total_skipped = (
        skipped_invalid_time + skipped_empty + skipped_drawings + skipped_comments
    )

    if not raw_cues:
        raise SubtitleParseError(
            "El archivo no contiene ningún cue válido tras el parseo y limpieza."
        )

    if len(raw_cues) > max_cues:
        raise SubtitleParseError(
            f"El archivo contiene {len(raw_cues)} cues, superando el máximo permitido de {max_cues}."
        )

    # Ordenar por (start_ms, end_ms) preservando solapamientos sin fusionar
    raw_cues.sort(key=lambda item: (item[0], item[1]))

    cues = [
        CueData(idx=idx, start_ms=start_ms, end_ms=end_ms, text=cue_text)
        for idx, (start_ms, end_ms, cue_text) in enumerate(raw_cues)
    ]

    return ParsedSubtitles(
        cues=cues,
        source_format=source_format,
        warnings=parse_warnings,
        skipped=total_skipped,
    )


def detect_language(cues: list[CueData]) -> str:
    """Detecta heurísticamente el idioma sobre una muestra de hasta 200 cues.

    Heurística Unicode:
    - Se inspeccionan los caracteres alfabéticos/ideográficos (`char.isalpha()`) de hasta 200 cues:
      * CJK Unified Ideographs: U+4E00–U+9FFF y U+3400–U+4DBF
      * Kana (Hiragana + Katakana): U+3040–U+30FF
      * Hangul Syllables: U+AC00–U+D7AF
    - Reglas de decisión:
      1. Si `kana / total_alpha > 0.05` (5 %) → `"ja"`
      2. Si `hangul / total_alpha > 0.20` (20 %) → `"ko"`
      3. Si `cjk / total_alpha > 0.30` (30 %) → `"zh"`
      4. Caso contrario → `"und"` (el cliente solicitará al usuario elegir el idioma).
    Nota: La distinción entre chino simplificado y tradicional queda fuera del alcance de Fase 2
    (extensión futura mediante OpenCC).
    """
    sample = cues[:LANGUAGE_SAMPLE_LIMIT]
    total_alpha = 0
    cjk_count = 0
    kana_count = 0
    hangul_count = 0

    for cue in sample:
        for ch in cue.text:
            cp = ord(ch)
            is_cjk = _is_cjk_ideograph(cp)
            is_kana = 0x3040 <= cp <= 0x30FF
            is_hangul = 0xAC00 <= cp <= 0xD7AF
            if is_cjk or is_kana or is_hangul or ch.isalpha():
                total_alpha += 1
                if is_cjk:
                    cjk_count += 1
                elif is_kana:
                    kana_count += 1
                elif is_hangul:
                    hangul_count += 1

    if total_alpha == 0:
        return "und"

    if (kana_count / total_alpha) > 0.05:
        return "ja"
    if (hangul_count / total_alpha) > 0.20:
        return "ko"
    if (cjk_count / total_alpha) > 0.30:
        return "zh"
    return "und"
