"""Servicio de emparejado persistido de pistas y traducción bajo demanda con caché (Fase 5)."""

from bisect import bisect_right
from datetime import datetime, timezone
import json
import logging

import httpx
from sqlalchemy import update
from sqlmodel import Session, col, select

from app.config import Settings, get_settings
from app.models import Cue, SubtitleTrack, TranslationCache
from app.services.chinese import tokenize_cue
from app.services.dictionary import lookup_word

logger = logging.getLogger("app.services.translator")


def find_best_overlap_cue_text(
    primary_start_ms: int,
    primary_end_ms: int,
    sec_starts: list[int],
    sec_ends: list[int],
    sec_texts: list[str],
) -> str | None:
    """Encuentra el texto del cue secundario con mayor solapamiento temporal contra `[primary_start_ms, primary_end_ms]`."""
    n = len(sec_starts)
    if n == 0 or primary_end_ms <= primary_start_ms:
        return None

    # Índice del último cue secundario con start <= primary_end_ms - 1
    max_idx = bisect_right(sec_starts, primary_end_ms - 1) - 1
    if max_idx < 0:
        return None

    first_after_start = bisect_right(sec_starts, primary_start_ms - 1)
    scan_start = max(0, first_after_start - 16)

    best_idx: int | None = None
    best_overlap = 0
    best_start_dist = float("inf")

    for i in range(scan_start, max_idx + 1):
        ov_start = max(primary_start_ms, sec_starts[i])
        ov_end = min(primary_end_ms, sec_ends[i])
        overlap = ov_end - ov_start
        if overlap <= 0:
            continue
        dist = abs(sec_starts[i] - primary_start_ms)
        if overlap > best_overlap or (
            overlap == best_overlap and dist < best_start_dist
        ):
            best_overlap = overlap
            best_start_dist = dist
            best_idx = i

    return sec_texts[best_idx] if best_idx is not None else None


def pair_video_subtitle_tracks_sync(
    video_id: int,
    session: Session,
    secondary_track_id: int | None = None,
) -> int:
    """Empareja los cues de la pista primaria del video con una pista secundaria y persiste `Cue.translation_text`.

    Retorna la cantidad de cues primarios que recibieron traducción emparejada.
    """
    tracks_stmt = (
        select(SubtitleTrack)
        .where(SubtitleTrack.video_id == video_id)
        .order_by(
            col(SubtitleTrack.is_primary).desc(),
            col(SubtitleTrack.created_at).asc(),
            col(SubtitleTrack.id).asc(),
        )
    )
    tracks = list(session.exec(tracks_stmt).all())
    if not tracks:
        return 0

    primary = next((t for t in tracks if t.is_primary), tracks[0])
    if primary.id is None:
        return 0

    secondary: SubtitleTrack | None = None
    if secondary_track_id is not None:
        secondary = next(
            (t for t in tracks if t.id == secondary_track_id and t.id != primary.id),
            None,
        )
    else:
        # Elegir automáticamente una pista que sea traducción real: distinto idioma
        # que la primaria (variantes del mismo idioma, p. ej. zh-TW, no cuentan).
        # Preferencia: español > inglés > cualquier otro idioma.
        candidates = [
            t for t in tracks if t.id != primary.id and t.lang != primary.lang
        ]
        lang_rank = {"es": 0, "en": 1}
        candidates.sort(key=lambda t: lang_rank.get(t.lang, 2))
        secondary = candidates[0] if candidates else None

    if secondary is None or secondary.id is None:
        session.execute(
            update(Cue)
            .where(col(Cue.track_id) == primary.id)
            .values(translation_text=None)
        )
        primary.tokens_updated_at = datetime.now(timezone.utc)
        session.add(primary)
        session.commit()
        return 0

    primary_cues = list(
        session.exec(
            select(Cue)
            .where(Cue.track_id == primary.id)
            .order_by(col(Cue.idx).asc())
        ).all()
    )
    secondary_cues = list(
        session.exec(
            select(Cue)
            .where(Cue.track_id == secondary.id)
            .order_by(col(Cue.idx).asc())
        ).all()
    )

    p_offset = primary.offset_ms
    s_offset = secondary.offset_ms

    sec_starts = [c.start_ms + s_offset for c in secondary_cues]
    sec_ends = [c.end_ms + s_offset for c in secondary_cues]
    sec_texts = [c.text for c in secondary_cues]

    matched_count = 0
    mappings: list[dict[str, object]] = []

    for p_cue in primary_cues:
        if p_cue.id is None:
            continue
        matched_text = find_best_overlap_cue_text(
            p_cue.start_ms + p_offset,
            p_cue.end_ms + p_offset,
            sec_starts,
            sec_ends,
            sec_texts,
        )
        if matched_text:
            matched_count += 1
        mappings.append({"id": p_cue.id, "translation_text": matched_text})

    if mappings:
        session.execute(update(Cue), mappings)

    primary.tokens_updated_at = datetime.now(timezone.utc)
    session.add(primary)
    session.commit()
    return matched_count


def _build_offline_cedict_gloss(
    session: Session,
    text: str,
    tokens_json: str | None = None,
) -> str:
    """Construye una glosa palabra por palabra usando jieba + CC-CEDICT cuando no hay API externa configurada."""
    words: list[str] = []
    if tokens_json:
        try:
            parsed = json.loads(tokens_json)
            if isinstance(parsed, dict) and isinstance(parsed.get("t"), list):
                words = [
                    str(tok["w"])
                    for tok in parsed["t"]
                    if isinstance(tok, dict) and tok.get("k") == "w" and tok.get("w")
                ]
        except ValueError:
            words = []

    if not words:
        tokenized = tokenize_cue(text)
        words = [
            str(tok["w"])
            for tok in tokenized.get("t", [])
            if tok.get("k") == "w" and tok.get("w")
        ]

    gloss_parts: list[str] = []
    seen: set[str] = set()
    for word in words:
        if word in seen:
            continue
        seen.add(word)
        res = lookup_word(session, word)
        if res.entries:
            try:
                parsed_defs = json.loads(res.entries[0].definitions_json)
            except ValueError:
                parsed_defs = []
            top_defs = [str(d) for d in parsed_defs[:2] if d]
            if top_defs:
                gloss_parts.append(f"{word}: {' / '.join(top_defs)}")
        elif res.char_entries:
            char_defs: list[str] = []
            for c in res.char_entries:
                if not c.entries:
                    continue
                try:
                    c_defs = json.loads(c.entries[0].definitions_json)
                except ValueError:
                    c_defs = []
                if c_defs:
                    char_defs.append(f"{c.char} ({c_defs[0]})")
            if char_defs:
                gloss_parts.append(" + ".join(char_defs))

    if gloss_parts:
        return " · ".join(gloss_parts)
    return text


async def translate_text_cached(
    session: Session,
    text: str,
    target_lang: str = "es",
    tokens_json: str | None = None,
    settings: Settings | None = None,
) -> tuple[str, str, bool]:
    """Traduce `text` hacia `target_lang` consultando primero `TranslationCache`.

    Retorna `(translated_text, provider, was_cached)`.
    """
    clean_text = text.strip()
    if not clean_text:
        return "", "none", True

    norm_lang = target_lang.strip().lower() or "es"
    cached_stmt = select(TranslationCache).where(
        TranslationCache.source_text == clean_text,
        TranslationCache.target_lang == norm_lang,
    )
    existing = session.exec(cached_stmt).first()
    if existing is not None:
        return existing.translated_text, existing.provider, True

    active_settings = settings or get_settings()
    translated = ""
    provider = "offline_cedict"

    if active_settings.TRANSLATION_API_URL:
        try:
            headers: dict[str, str] = {"Content-Type": "application/json"}
            if active_settings.TRANSLATION_API_KEY:
                headers["Authorization"] = (
                    f"Bearer {active_settings.TRANSLATION_API_KEY}"
                )
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    active_settings.TRANSLATION_API_URL,
                    json={
                        "q": clean_text,
                        "source": "zh",
                        "target": norm_lang,
                        "text": clean_text,
                        "target_lang": norm_lang,
                    },
                    headers=headers,
                )
                if resp.status_code == 200:
                    body = resp.json()
                    candidate = (
                        body.get("translatedText")
                        or body.get("translated_text")
                        or body.get("translation")
                    )
                    if isinstance(candidate, str) and candidate.strip():
                        translated = candidate.strip()
                        provider = "external_api"
        except Exception as exc:
            logger.warning(
                "Fallo en API externa de traducción (%s), usando glosa offline CC-CEDICT.",
                exc,
            )

    if not translated:
        translated = _build_offline_cedict_gloss(session, clean_text, tokens_json)
        provider = "offline_cedict"

    cache_entry = TranslationCache(
        source_text=clean_text,
        target_lang=norm_lang,
        translated_text=translated,
        provider=provider,
    )
    session.add(cache_entry)
    session.commit()
    return translated, provider, False
