"""Servicio puro de segmentación china (jieba), conversión de script (OpenCC) y lectura pinyin (pypinyin).

Decisiones de diseño documentadas:
1. Tonos de citación por defecto (`PINYIN_TONE_SANDHI = False`): se entregan los tonos léxicos de
   citación (p. ej. 你好 → nǐ hǎo [3, 3]) porque el estudiante necesita identificar el tono propio
   de cada carácter; el sandhi fonético (不/一/3+3) es opcional mediante configuración.
2. Heurística `detect_script`: evalúa hasta 200 líneas tomando únicamente los caracteres Han y
   comparándolos con su conversión `t2s` de OpenCC. Si la proporción de caracteres que cambian es
   > 5 % devuelve `"hant"`, si es <= 1 % devuelve `"hans"`, y entre 1 % y 5 % devuelve `"mixed"`.
"""

from functools import lru_cache
import json
import logging
from pathlib import Path
import re
from typing import Any, Callable, TypedDict

import jieba
from opencc import OpenCC
from pypinyin import Style, lazy_pinyin, load_phrases_dict
from pypinyin.contrib.tone_convert import to_tone

logger = logging.getLogger("app.services.chinese")

TOKENS_SCHEMA_VERSION = 1
SCRIPT_SAMPLE_LIMIT = 200

SYLLABLE_TONE3_RE = re.compile(r"^([a-züv]+)([1-5])?$", re.IGNORECASE)

# Frases polifónicas frecuentes cuyo valor por defecto en pypinyin requiere refuerzo contextual
BASELINE_POLYPHONE_PHRASES: dict[str, list[list[str]]] = {
    "很长": [["hěn"], ["cháng"]],
    "多长": [["duō"], ["cháng"]],
    "太长": [["tài"], ["cháng"]],
    "真长": [["zhēn"], ["cháng"]],
    "长大": [["zhǎng"], ["dà"]],
    "银行": [["yín"], ["háng"]],
    "不行": [["bù"], ["xíng"]],
    "重要": [["zhòng"], ["yào"]],
    "重新": [["chóng"], ["xīn"]],
}

TONE_MARK_VOWELS: dict[str, tuple[str, str, str, str]] = {
    "a": ("ā", "á", "ǎ", "à"),
    "e": ("ē", "é", "ě", "è"),
    "i": ("ī", "í", "ǐ", "ì"),
    "o": ("ō", "ó", "ǒ", "ò"),
    "u": ("ū", "ú", "ǔ", "ù"),
    "ü": ("ǖ", "ǘ", "ǚ", "ǜ"),
}

_opencc_t2s: OpenCC | None = None
_baseline_phrases_loaded = False


class WordTokenDict(TypedDict):
    w: str
    p: list[str | None]
    n: list[int | None]
    k: str


class SimpleTokenDict(TypedDict):
    w: str
    k: str


TokenDict = WordTokenDict | SimpleTokenDict


def _get_opencc_t2s() -> OpenCC:
    global _opencc_t2s
    if _opencc_t2s is None:
        _opencc_t2s = OpenCC("t2s")
    return _opencc_t2s


def convert_t2s(text: str) -> str:
    """Convierte texto chino tradicional a simplificado mediante OpenCC (`t2s`)."""
    if not text:
        return text
    return _get_opencc_t2s().convert(text)


def _ensure_baseline_pinyin_loaded() -> None:
    global _baseline_phrases_loaded
    if not _baseline_phrases_loaded:
        load_phrases_dict(BASELINE_POLYPHONE_PHRASES)
        _baseline_phrases_loaded = True


def is_han_char(ch: str) -> bool:
    """Evalúa si un carácter pertenece a los rangos Han especificados (incluyendo Ext. A/B y 〇)."""
    if len(ch) != 1:
        return False
    cp = ord(ch)
    return (
        (0x4E00 <= cp <= 0x9FFF)
        or (0x3400 <= cp <= 0x4DBF)
        or (0x20000 <= cp <= 0x2A6DF)
        or (0xF900 <= cp <= 0xFAFF)
        or cp == 0x3007
    )


def _classify_non_han_char(ch: str) -> str:
    """Clasifica un carácter no-Han en `'b'`, `'s'`, `'l'` o `'p'`."""
    if ch == "\n":
        return "b"
    if ch.isspace():
        return "s"
    cp = ord(ch)
    # Alfanumérico latino / ASCII o dígitos
    if (
        (0x0030 <= cp <= 0x0039)
        or (0x0041 <= cp <= 0x005A)
        or (0x0061 <= cp <= 0x007A)
        or (0x00C0 <= cp <= 0x024F and ch.isalnum())
    ):
        return "l"
    return "p"


def _char_kind(ch: str) -> str:
    if is_han_char(ch):
        return "w"
    return _classify_non_han_char(ch)


def _place_tone_mark_fallback(base: str, tone: int) -> str:
    """Coloca manualmente la marca tonal según la regla estándar (a/e > ou > última vocal)."""
    if tone not in (1, 2, 3, 4):
        return base
    idx_to_mark = -1
    if "a" in base:
        idx_to_mark = base.index("a")
    elif "e" in base:
        idx_to_mark = base.index("e")
    elif "ou" in base:
        idx_to_mark = base.index("o")
    else:
        for i in range(len(base) - 1, -1, -1):
            if base[i] in TONE_MARK_VOWELS:
                idx_to_mark = i
                break
    if idx_to_mark == -1:
        return base
    vowel = base[idx_to_mark]
    marked_vowel = TONE_MARK_VOWELS[vowel][tone - 1]
    return base[:idx_to_mark] + marked_vowel + base[idx_to_mark + 1 :]


def _parse_tone3_syllable(raw_syllable: str) -> tuple[str | None, int | None]:
    """Deriva `(pinyin_con_marca, numero_de_tono)` desde una sílaba TONE3 de pypinyin."""
    cleaned = raw_syllable.strip()
    match = SYLLABLE_TONE3_RE.match(cleaned)
    if not match:
        return None, None

    base = match.group(1).lower().replace("v", "ü")
    tone_str = match.group(2)
    tone_num = int(tone_str) if tone_str else 5

    if tone_num == 5:
        return base, 5

    marked = to_tone(f"{base}{tone_num}")
    if marked and marked[-1].isdigit():
        marked = _place_tone_mark_fallback(base, tone_num)
    return marked, tone_num


def init_segmenter(
    userdict_path: Path | None = None,
    pinyin_overrides_path: Path | None = None,
) -> None:
    """Inicializa jieba, carga diccionarios opcionales de usuario y limpia el caché de pinyin."""
    jieba.initialize()
    _ensure_baseline_pinyin_loaded()

    if userdict_path is not None and userdict_path.is_file():
        jieba.load_userdict(str(userdict_path))
        logger.info("Diccionario de usuario jieba cargado desde %s", userdict_path)

    if pinyin_overrides_path is not None and pinyin_overrides_path.is_file():
        custom_phrases: dict[str, list[list[str]]] = {}
        for raw_line in pinyin_overrides_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "\t" not in line:
                continue
            word_part, pinyin_part = line.split("\t", 1)
            word = word_part.strip()
            syllables = [s.strip() for s in pinyin_part.strip().split() if s.strip()]
            if not word or len(syllables) != len(word):
                continue
            marked_list: list[list[str]] = []
            valid = True
            for syl in syllables:
                marked, _ = _parse_tone3_syllable(syl)
                if marked is None:
                    valid = False
                    break
                marked_list.append([marked])
            if valid:
                custom_phrases[word] = marked_list

        if custom_phrases:
            load_phrases_dict(custom_phrases)
            logger.info(
                "Cargados %d overrides de pinyin desde %s",
                len(custom_phrases),
                pinyin_overrides_path,
            )

    _cached_pinyin_for_word.cache_clear()


def detect_script(
    texts: list[str],
    t2s_converter: Callable[[str], str] = convert_t2s,
) -> str | None:
    """Detecta si un conjunto de textos chinos está en `'hans'`, `'hant'`, `'mixed'` o `None`.

    Heurística:
    - Toma hasta 200 textos y extrae todos los caracteres Han.
    - Si no hay ningún carácter Han, devuelve `None`.
    - Convierte la secuencia de caracteres Han con OpenCC `t2s`. Si la longitud convertida
      difiere (caso raro), compara carácter a carácter.
    - Calcula `changed / total_han`:
      * `> 0.05` (5 %) → `"hant"`
      * `<= 0.01` (1 %) → `"hans"`
      * en otro caso → `"mixed"`
    """
    sample = texts[:SCRIPT_SAMPLE_LIMIT]
    han_chars: list[str] = []
    for text in sample:
        for ch in text:
            if is_han_char(ch):
                han_chars.append(ch)

    total_han = len(han_chars)
    if total_han == 0:
        return None

    joined_han = "".join(han_chars)
    converted = t2s_converter(joined_han)

    changed = 0
    if len(converted) == total_han:
        for orig_ch, simp_ch in zip(joined_han, converted):
            if orig_ch != simp_ch:
                changed += 1
    else:
        for orig_ch in han_chars:
            simp_ch = t2s_converter(orig_ch)
            if simp_ch != orig_ch:
                changed += 1

    ratio = changed / total_han
    if ratio > 0.05:
        return "hant"
    if ratio <= 0.01:
        return "hans"
    return "mixed"


def _pinyin_single_char(
    ch: str,
    tone_sandhi: bool,
) -> tuple[str | None, int | None]:
    raw_list = lazy_pinyin(
        ch,
        style=Style.TONE3,
        neutral_tone_with_five=True,
        v_to_u=True,
        tone_sandhi=tone_sandhi,
        errors=lambda x: [c for c in x],
    )
    if len(raw_list) != 1:
        return None, None
    return _parse_tone3_syllable(raw_list[0])


@lru_cache(maxsize=4096)
def _cached_pinyin_for_word(
    word: str,
    script: str | None,
    tone_sandhi: bool,
) -> tuple[tuple[str | None, ...], tuple[int | None, ...]]:
    _ensure_baseline_pinyin_loaded()

    target_word = word
    if script in ("hant", "mixed"):
        simp_word = convert_t2s(word)
        if len(simp_word) == len(word):
            target_word = simp_word
        else:
            logger.debug(
                "Conversión t2s no 1:1 en pinyin_for_word (len %d != %d); usando original.",
                len(simp_word),
                len(word),
            )

    raw_syllables = lazy_pinyin(
        target_word,
        style=Style.TONE3,
        neutral_tone_with_five=True,
        v_to_u=True,
        tone_sandhi=tone_sandhi,
        errors=lambda x: [c for c in x],
    )

    p_list: list[str | None] = []
    n_list: list[int | None] = []

    if len(raw_syllables) == len(word):
        for syl in raw_syllables:
            marked, tone = _parse_tone3_syllable(syl)
            p_list.append(marked)
            n_list.append(tone)
    else:
        # Fallback defensivo carácter por carácter si pypinyin altera la cantidad de elementos
        for ch in target_word:
            marked, tone = _pinyin_single_char(ch, tone_sandhi)
            p_list.append(marked)
            n_list.append(tone)

    return tuple(p_list), tuple(n_list)


def pinyin_for_word(
    word: str,
    script: str | None = None,
    tone_sandhi: bool = False,
    t2s_converter: Callable[[str], str] | None = None,
) -> tuple[list[str | None], list[int | None]]:
    """Calcula `(lista_pinyin, lista_tonos)` para una palabra formada por caracteres Han."""
    if not word:
        return [], []

    if t2s_converter is not None and t2s_converter is not convert_t2s:
        # Camino sin caché cuando un test inyecta un conversor simulado no estándar
        _ensure_baseline_pinyin_loaded()
        target_word = word
        if script in ("hant", "mixed"):
            simp = t2s_converter(word)
            if len(simp) == len(word):
                target_word = simp
            else:
                logger.debug("Conversión t2s inyectada no es 1:1; usando original.")
        raw_syllables = lazy_pinyin(
            target_word,
            style=Style.TONE3,
            neutral_tone_with_five=True,
            v_to_u=True,
            tone_sandhi=tone_sandhi,
            errors=lambda x: [c for c in x],
        )
        if len(raw_syllables) == len(word):
            pairs = [_parse_tone3_syllable(s) for s in raw_syllables]
        else:
            pairs = [_pinyin_single_char(c, tone_sandhi) for c in target_word]
        return [p for p, _ in pairs], [n for _, n in pairs]

    p_tuple, n_tuple = _cached_pinyin_for_word(word, script, tone_sandhi)
    return list(p_tuple), list(n_tuple)


def _split_span_by_kind(span: str) -> list[tuple[str, str]]:
    """Parte un span en corridas contiguas del mismo tipo (`w`, `l`, `s`, `p`, `b`)."""
    if not span:
        return []
    runs: list[tuple[str, str]] = []
    current_kind = _char_kind(span[0])
    start_idx = 0

    for idx in range(1, len(span)):
        kind = _char_kind(span[idx])
        if kind != current_kind or current_kind == "b":
            runs.append((span[start_idx:idx], current_kind))
            current_kind = kind
            start_idx = idx

    runs.append((span[start_idx:], current_kind))
    return runs


def tokenize_line(
    line: str,
    script: str | None = None,
    tone_sandhi: bool = False,
    t2s_converter: Callable[[str], str] = convert_t2s,
) -> list[TokenDict]:
    """Segmenta una línea (sin `\\n`) garantizando las invariantes lossless y de caracteres Han."""
    if not line:
        return []

    seg_input = line
    if script in ("hant", "mixed"):
        simp_line = t2s_converter(line)
        if len(simp_line) == len(line):
            seg_input = simp_line
        else:
            logger.debug(
                "Conversión t2s de línea no es 1:1 (%d != %d); segmentando original.",
                len(simp_line),
                len(line),
            )

    raw_pieces: list[tuple[str, str]] = []
    cursor = 0
    line_len = len(line)

    for _word, start, end in jieba.tokenize(seg_input, mode="default", HMM=True):
        if start > cursor:
            gap = line[cursor:start]
            raw_pieces.extend(_split_span_by_kind(gap))
        if end > start:
            original_slice = line[start:end]
            raw_pieces.extend(_split_span_by_kind(original_slice))
            cursor = end

    if cursor < line_len:
        tail = line[cursor:line_len]
        raw_pieces.extend(_split_span_by_kind(tail))

    # Fusionar piezas contiguas NO-Han del mismo tipo (`l`, `s`, `p`), pero preservar
    # estrictamente los límites de palabra de jieba para `k == "w"`.
    merged_pieces: list[tuple[str, str]] = []
    for sub_text, kind in raw_pieces:
        if (
            merged_pieces
            and kind in ("l", "s", "p")
            and merged_pieces[-1][1] == kind
        ):
            prev_text, _ = merged_pieces[-1]
            merged_pieces[-1] = (prev_text + sub_text, kind)
        else:
            merged_pieces.append((sub_text, kind))

    tokens: list[TokenDict] = []
    for piece_text, kind in merged_pieces:
        if kind == "w":
            p_list, n_list = pinyin_for_word(
                piece_text,
                script=script,
                tone_sandhi=tone_sandhi,
                t2s_converter=t2s_converter,
            )
            tokens.append(
                {
                    "w": piece_text,
                    "p": p_list,
                    "n": n_list,
                    "k": "w",
                }
            )
        else:
            tokens.append(
                {
                    "w": piece_text,
                    "k": kind,
                }
            )

    return tokens


def tokenize_cue(
    text: str,
    script: str | None = None,
    tone_sandhi: bool = False,
    t2s_converter: Callable[[str], str] = convert_t2s,
) -> dict[str, Any]:
    """Tokeniza un cue completo (posiblemente multilínea) y retorna el dict del contrato v1."""
    lines = text.split("\n")
    all_tokens: list[TokenDict] = []

    for idx, line in enumerate(lines):
        if line:
            all_tokens.extend(
                tokenize_line(
                    line,
                    script=script,
                    tone_sandhi=tone_sandhi,
                    t2s_converter=t2s_converter,
                )
            )
        if idx < len(lines) - 1:
            all_tokens.append({"w": "\n", "k": "b"})

    return {
        "v": TOKENS_SCHEMA_VERSION,
        "t": all_tokens,
    }


def tokenize_cue_text(
    text: str,
    script: str | None = None,
    tone_sandhi: bool = False,
    t2s_converter: Callable[[str], str] = convert_t2s,
) -> str:
    """Serializa el resultado de `tokenize_cue` en JSON compacto."""
    payload = tokenize_cue(
        text,
        script=script,
        tone_sandhi=tone_sandhi,
        t2s_converter=t2s_converter,
    )
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def tokens_to_pinyin_string(tokens_data: dict[str, Any] | list[dict[str, Any]]) -> str:
    """Convierte los tokens de un cue en una cadena de pinyin separada por espacios (p. ej. `'nǐ hǎo ma'`).

    Punto de extensión (Fase 6): permite copiar el pinyin a una `Phrase` guardada sin recalcular.
    """
    token_list = (
        tokens_data.get("t", [])
        if isinstance(tokens_data, dict)
        else tokens_data
    )
    syllables: list[str] = []
    for token in token_list:
        if token.get("k") == "w":
            for syl in token.get("p") or []:
                if syl:
                    syllables.append(syl)
    return " ".join(syllables)
