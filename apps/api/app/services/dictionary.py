"""Servicio de diccionario CC-CEDICT: parseo, importación masiva en SQLite y búsqueda."""

import argparse
from dataclasses import dataclass
import gzip
import json
import logging
from pathlib import Path
import re
import shutil
import urllib.request

from pypinyin.contrib.tone_convert import to_tone
from sqlalchemy import Engine, delete, func, insert
from sqlmodel import Session, col, or_, select

from app.config import get_settings
from app.db import build_engine, init_db
from app.models import DictionaryEntry
from app.services.chinese import convert_t2s, is_han_char

logger = logging.getLogger("app.services.dictionary")

CEDICT_LINE_RE = re.compile(r"^(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+/(.+)/\s*$")
CEDICT_SYLLABLE_RE = re.compile(r"^([A-Za-züÜ:]+)([1-5])$")
IMPORT_BATCH_SIZE = 5000

TONE_MARK_VOWELS_LOWER: dict[str, tuple[str, str, str, str]] = {
    "a": ("ā", "á", "ǎ", "à"),
    "e": ("ē", "é", "ě", "è"),
    "i": ("ī", "í", "ǐ", "ì"),
    "o": ("ō", "ó", "ǒ", "ò"),
    "u": ("ū", "ú", "ǔ", "ù"),
    "ü": ("ǖ", "ǘ", "ǚ", "ǜ"),
}


@dataclass(slots=True)
class ParsedCedictEntry:
    traditional: str
    simplified: str
    pinyin_numeric: str
    pinyin_marks: str
    definitions: list[str]
    classifiers: list[str]
    rank: int


@dataclass(slots=True)
class CharBreakdownResult:
    char: str
    entries: list[DictionaryEntry]


@dataclass(slots=True)
class DictionaryLookupResult:
    query: str
    normalized_simplified: str
    entries: list[DictionaryEntry]
    char_entries: list[CharBreakdownResult]


def _place_tone_mark_preserve_case(base: str, tone: int) -> str:
    """Coloca marca tonal sobre sílabas CC-CEDICT preservando mayúscula inicial si existe."""
    if tone == 5 or tone not in (1, 2, 3, 4):
        return base

    lower = base.lower()
    idx_to_mark = -1
    if "a" in lower:
        idx_to_mark = lower.index("a")
    elif "e" in lower:
        idx_to_mark = lower.index("e")
    elif "ou" in lower:
        idx_to_mark = lower.index("o")
    else:
        for i in range(len(lower) - 1, -1, -1):
            if lower[i] in TONE_MARK_VOWELS_LOWER:
                idx_to_mark = i
                break

    if idx_to_mark == -1:
        return base

    ch = base[idx_to_mark]
    marked_lower = TONE_MARK_VOWELS_LOWER[ch.lower()][tone - 1]
    marked_char = marked_lower.upper() if ch.isupper() else marked_lower
    return base[:idx_to_mark] + marked_char + base[idx_to_mark + 1 :]


def cedict_pinyin_to_marks(raw_pinyin: str) -> tuple[str, str]:
    """Convierte pinyin de CC-CEDICT (`lu:4`, `yin2 hang2`) a `(numeric_clean, marks)`.

    - Reemplaza `u:` / `U:` por `ü` / `Ü`.
    - Convierte cada sílaba con dígito de tono `[1-5]` a su forma con diacrítico.
    """
    tokens = raw_pinyin.strip().split()
    clean_numeric_tokens: list[str] = []
    marked_tokens: list[str] = []

    for token in tokens:
        norm_token = token.replace("u:", "ü").replace("U:", "Ü")
        clean_numeric_tokens.append(norm_token)

        match = CEDICT_SYLLABLE_RE.match(norm_token)
        if not match:
            marked_tokens.append(norm_token)
            continue

        base, tone_str = match.group(1), match.group(2)
        tone = int(tone_str)
        if tone == 5:
            marked_tokens.append(base)
            continue

        if base[0].isupper():
            marked_tokens.append(_place_tone_mark_preserve_case(base, tone))
        else:
            converted = to_tone(f"{base}{tone}")
            if converted and converted[-1].isdigit():
                converted = _place_tone_mark_preserve_case(base, tone)
            marked_tokens.append(converted)

    return " ".join(clean_numeric_tokens), " ".join(marked_tokens)


def parse_cedict_line(line: str) -> ParsedCedictEntry | None:
    """Parsea una línea de CC-CEDICT. Retorna `None` si es comentario o inválida."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None

    match = CEDICT_LINE_RE.match(stripped)
    if not match:
        return None

    traditional, simplified, raw_pinyin, raw_defs = match.groups()
    pinyin_numeric, pinyin_marks = cedict_pinyin_to_marks(raw_pinyin)

    raw_parts = [part.strip() for part in raw_defs.split("/") if part.strip()]
    if not raw_parts:
        return None

    definitions: list[str] = []
    classifiers: list[str] = []

    for part in raw_parts:
        if part.startswith("CL:"):
            cl_body = part[3:].strip()
            if cl_body:
                classifiers.extend(
                    [item.strip() for item in cl_body.split(",") if item.strip()]
                )
        else:
            definitions.append(part)

    if not definitions and classifiers:
        definitions = [f"CL: {', '.join(classifiers)}"]

    # Priorizar palabras comunes en minúscula sobre apellidos/nombres propios y variantes arcaicas
    first_def_lower = definitions[0].lower() if definitions else ""
    is_variant_only = first_def_lower.startswith(
        ("variant of ", "old variant of ", "see ", "erhua variant of ")
    )
    is_proper_noun = bool(pinyin_numeric and pinyin_numeric[0].isupper())

    if is_variant_only:
        rank = 2
    elif is_proper_noun:
        rank = 1
    else:
        rank = 0

    return ParsedCedictEntry(
        traditional=traditional,
        simplified=simplified,
        pinyin_numeric=pinyin_numeric,
        pinyin_marks=pinyin_marks,
        definitions=definitions,
        classifiers=classifiers,
        rank=rank,
    )


def _open_cedict_text(cedict_path: Path):
    if cedict_path.suffix.lower() == ".gz":
        return gzip.open(cedict_path, mode="rt", encoding="utf-8", errors="replace")
    return cedict_path.open(mode="r", encoding="utf-8", errors="replace")


def import_cedict_file(
    cedict_path: Path,
    engine: Engine,
    replace: bool = True,
) -> int:
    """Importa un archivo CC-CEDICT en lotes dentro de la tabla `dictionaryentry`."""
    if not cedict_path.is_file():
        raise FileNotFoundError(f"Archivo CC-CEDICT no encontrado: {cedict_path}")

    if replace:
        with Session(engine) as session:
            session.execute(delete(DictionaryEntry))
            session.commit()

    inserted_count = 0
    batch: list[dict[str, object]] = []

    with _open_cedict_text(cedict_path) as fh:
        for line in fh:
            parsed = parse_cedict_line(line)
            if parsed is None:
                continue
            batch.append(
                {
                    "traditional": parsed.traditional,
                    "simplified": parsed.simplified,
                    "pinyin_numeric": parsed.pinyin_numeric,
                    "pinyin_marks": parsed.pinyin_marks,
                    "definitions_json": json.dumps(
                        parsed.definitions, ensure_ascii=False, separators=(",", ":")
                    ),
                    "classifiers_json": (
                        json.dumps(
                            parsed.classifiers,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        if parsed.classifiers
                        else None
                    ),
                    "rank": parsed.rank,
                }
            )

            if len(batch) >= IMPORT_BATCH_SIZE:
                with Session(engine) as session:
                    session.execute(insert(DictionaryEntry), batch)
                    session.commit()
                inserted_count += len(batch)
                batch.clear()

    if batch:
        with Session(engine) as session:
            session.execute(insert(DictionaryEntry), batch)
            session.commit()
        inserted_count += len(batch)

    logger.info(
        "Importadas %d entradas de CC-CEDICT desde %s",
        inserted_count,
        cedict_path,
    )
    return inserted_count


def get_dictionary_entry_count(session: Session) -> int:
    stmt = select(func.count(col(DictionaryEntry.id)))
    return int(session.exec(stmt).one() or 0)


def auto_import_cedict_if_present(cedict_path: Path, engine: Engine) -> int:
    """Importa CC-CEDICT automáticamente al arrancar si existe el archivo y la tabla está vacía."""
    if not cedict_path.is_file():
        return 0
    with Session(engine) as session:
        existing = get_dictionary_entry_count(session)
        if existing > 0:
            return existing
    return import_cedict_file(cedict_path, engine, replace=False)


def download_cedict_file(dest_path: Path, url: str) -> Path:
    """Descarga el archivo CC-CEDICT gzipped desde MDBG y lo descomprime en `dest_path`."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_gz = dest_path.with_suffix(dest_path.suffix + ".gz.part")
    tmp_out = dest_path.with_suffix(dest_path.suffix + ".part")

    logger.info("Descargando CC-CEDICT desde %s ...", url)
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "MandarinReactor/0.4 (+https://localhost)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp, tmp_gz.open("wb") as out_gz:
            shutil.copyfileobj(resp, out_gz)

        with gzip.open(tmp_gz, "rb") as gz_in, tmp_out.open("wb") as out_plain:
            shutil.copyfileobj(gz_in, out_plain)

        tmp_out.replace(dest_path)
    finally:
        tmp_gz.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)

    logger.info("CC-CEDICT guardado en %s", dest_path)
    return dest_path


def _query_exact_entries(session: Session, term: str) -> list[DictionaryEntry]:
    stmt = (
        select(DictionaryEntry)
        .where(
            or_(
                col(DictionaryEntry.simplified) == term,
                col(DictionaryEntry.traditional) == term,
            )
        )
        .order_by(col(DictionaryEntry.rank).asc(), col(DictionaryEntry.id).asc())
    )
    return list(session.exec(stmt).all())


def lookup_word(session: Session, raw_word: str) -> DictionaryLookupResult:
    """Busca una palabra en CC-CEDICT (simplificado/tradicional) con desglose por carácter."""
    query = raw_word.strip()
    if not query:
        return DictionaryLookupResult(
            query="",
            normalized_simplified="",
            entries=[],
            char_entries=[],
        )

    normalized_simplified = convert_t2s(query)
    entries = _query_exact_entries(session, query)

    if not entries and normalized_simplified != query:
        entries = _query_exact_entries(session, normalized_simplified)

    han_chars = [ch for ch in query if is_han_char(ch)]
    char_entries: list[CharBreakdownResult] = []

    # Desglose por carácter para palabras de >= 2 hanzi o cuando la palabra completa no está en CEDICT
    if len(han_chars) > 1 or (len(han_chars) == 1 and not entries):
        seen_chars: set[str] = set()
        for ch in han_chars[:12]:
            if ch in seen_chars:
                continue
            seen_chars.add(ch)
            ch_entries = _query_exact_entries(session, ch)
            if not ch_entries:
                simp_ch = convert_t2s(ch)
                if simp_ch != ch:
                    ch_entries = _query_exact_entries(session, simp_ch)
            if ch_entries:
                char_entries.append(CharBreakdownResult(char=ch, entries=ch_entries))

    return DictionaryLookupResult(
        query=query,
        normalized_simplified=normalized_simplified,
        entries=entries,
        char_entries=char_entries,
    )


def _cli() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    parser = argparse.ArgumentParser(
        description="Herramienta CLI para descargar e importar CC-CEDICT en SQLite."
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Descarga cedict_ts.u8 desde MDBG si no existe o para actualizarlo.",
    )
    parser.add_argument(
        "--import-db",
        action="store_true",
        help="Importa el archivo CC-CEDICT a la base de datos SQLite.",
    )
    args = parser.parse_args()

    settings = get_settings()
    settings.ensure_directories()
    cedict_path = settings.resolved_cedict_path

    if args.download:
        download_cedict_file(cedict_path, settings.CEDICT_DOWNLOAD_URL)

    if args.import_db or not args.download:
        engine = build_engine(settings)
        init_db(engine)
        count = import_cedict_file(cedict_path, engine, replace=True)
        engine.dispose()
        print(f"Importadas {count} entradas en {settings.db_path}")


if __name__ == "__main__":
    _cli()
