"""Pipeline en segundo plano para tokenización jieba + pypinyin por pista de subtítulos."""

import asyncio
from datetime import datetime, timezone
import logging

from sqlalchemy import Engine, or_, update
from sqlmodel import Session, col, select

from app.config import Settings
from app.models import Cue, SubtitleTrack, TokensStatus
from app.services.chinese import (
    TOKENS_SCHEMA_VERSION,
    detect_script,
    tokenize_cue_text,
)

logger = logging.getLogger("app.services.tokenizer_job")

BATCH_SIZE = 500
_TOKENIZE_SEMAPHORE = asyncio.Semaphore(1)


def _claim_track_sync(
    track_id: int,
    engine: Engine,
    force: bool,
) -> str:
    """Reclama atómicamente la pista para procesamiento.

    Retorna:
    - `'claimed'` si esta ejecución adquirió el reclamo (`rowcount == 1`).
    - `'skip_ready'` si ya estaba en `'ready'` con la versión actual y `force=False`.
    - `'not_applicable'` si `lang != 'zh'` (limpia tokens y marca `not_applicable`).
    - `'already_processing'` si otra tarea ya la tiene en `'processing'`.
    - `'not_found'` si la pista no existe.
    """
    with Session(engine) as session:
        track = session.get(SubtitleTrack, track_id)
        if track is None:
            return "not_found"

        if track.lang != "zh":
            track.tokens_status = TokensStatus.NOT_APPLICABLE.value
            track.script = None
            track.tokens_version = None
            track.tokens_error = None
            track.tokens_updated_at = datetime.now(timezone.utc)
            session.add(track)
            session.execute(
                update(Cue)
                .where(col(Cue.track_id) == track_id)
                .values(tokens_json=None)
            )
            session.commit()
            return "not_applicable"

        if (
            not force
            and track.tokens_status == TokensStatus.READY.value
            and track.tokens_version == TOKENS_SCHEMA_VERSION
        ):
            return "skip_ready"

        claim_stmt = (
            update(SubtitleTrack)
            .where(
                col(SubtitleTrack.id) == track_id,
                col(SubtitleTrack.tokens_status) != TokensStatus.PROCESSING.value,
            )
            .values(
                tokens_status=TokensStatus.PROCESSING.value,
                tokens_error=None,
                tokens_updated_at=datetime.now(timezone.utc),
            )
        )
        result = session.execute(claim_stmt)
        session.commit()
        if (result.rowcount or 0) == 0:
            return "already_processing"
        return "claimed"


def _process_track_batches_sync(
    track_id: int,
    engine: Engine,
    settings: Settings,
) -> None:
    """Ejecuta la detección de script y tokenización en lotes de 500 cues."""
    with Session(engine) as session:
        track = session.get(SubtitleTrack, track_id)
        if track is None:
            return
        if track.lang != "zh":
            track.tokens_status = TokensStatus.NOT_APPLICABLE.value
            track.script = None
            track.tokens_version = None
            track.tokens_error = None
            track.tokens_updated_at = datetime.now(timezone.utc)
            session.add(track)
            session.execute(
                update(Cue)
                .where(col(Cue.track_id) == track_id)
                .values(tokens_json=None)
            )
            session.commit()
            return

        cues_stmt = (
            select(Cue.id, Cue.text)
            .where(Cue.track_id == track_id)
            .order_by(col(Cue.idx).asc())
        )
        cue_rows = list(session.exec(cues_stmt).all())

    texts = [row[1] for row in cue_rows]
    detected_script = detect_script(texts)
    tone_sandhi = settings.PINYIN_TONE_SANDHI

    total = len(cue_rows)
    for start in range(0, total, BATCH_SIZE):
        batch = cue_rows[start : start + BATCH_SIZE]
        mappings = [
            {
                "id": cue_id,
                "tokens_json": tokenize_cue_text(
                    cue_text,
                    script=detected_script,
                    tone_sandhi=tone_sandhi,
                ),
            }
            for cue_id, cue_text in batch
        ]
        with Session(engine) as batch_session:
            batch_session.execute(update(Cue), mappings)
            batch_session.commit()

    with Session(engine) as final_session:
        track = final_session.get(SubtitleTrack, track_id)
        if track is None:
            return
        # Si durante el procesamiento el idioma cambió a no-zh, limpiamos por consistencia
        if track.lang != "zh":
            track.tokens_status = TokensStatus.NOT_APPLICABLE.value
            track.script = None
            track.tokens_version = None
            track.tokens_error = None
            track.tokens_updated_at = datetime.now(timezone.utc)
            final_session.add(track)
            final_session.execute(
                update(Cue)
                .where(col(Cue.track_id) == track_id)
                .values(tokens_json=None)
            )
            final_session.commit()
            return

        track.script = detected_script
        track.tokens_status = TokensStatus.READY.value
        track.tokens_version = TOKENS_SCHEMA_VERSION
        track.tokens_error = None
        track.tokens_updated_at = datetime.now(timezone.utc)
        final_session.add(track)
        final_session.commit()
        logger.info(
            "Tokenización completada para pista id=%s (%d cues, script=%s).",
            track_id,
            total,
            detected_script,
        )


def _mark_track_error_sync(
    track_id: int,
    engine: Engine,
    error_msg: str,
) -> None:
    with Session(engine) as session:
        track = session.get(SubtitleTrack, track_id)
        if track is not None:
            track.tokens_status = TokensStatus.ERROR.value
            track.tokens_error = error_msg[:500]
            track.tokens_updated_at = datetime.now(timezone.utc)
            session.add(track)
            session.commit()


async def tokenize_track(
    track_id: int,
    engine: Engine,
    settings: Settings,
    force: bool = False,
) -> bool:
    """Ejecuta en segundo plano la tokenización de una pista con reclamo atómico y semáforo."""
    claim_status = await asyncio.to_thread(
        _claim_track_sync,
        track_id,
        engine,
        force,
    )
    if claim_status != "claimed":
        logger.debug(
            "Tokenización omitida para pista id=%s (motivo=%s).",
            track_id,
            claim_status,
        )
        return False

    async with _TOKENIZE_SEMAPHORE:
        try:
            await asyncio.to_thread(
                _process_track_batches_sync,
                track_id,
                engine,
                settings,
            )
            return True
        except Exception as exc:
            logger.exception(
                "Error al tokenizar la pista de subtítulos id=%s",
                track_id,
            )
            truncated = (
                str(exc)[:500] or "Error interno durante la tokenización china."
            )
            await asyncio.to_thread(
                _mark_track_error_sync,
                track_id,
                engine,
                truncated,
            )
            return False


def clear_track_tokens_sync(track_id: int, session: Session, track: SubtitleTrack) -> None:
    """Limpia tokens_json y restablece metadatos de tokenización cuando una pista deja de ser 'zh'."""
    track.script = None
    track.tokens_status = TokensStatus.NOT_APPLICABLE.value
    track.tokens_version = None
    track.tokens_error = None
    track.tokens_updated_at = datetime.now(timezone.utc)
    session.add(track)
    session.execute(
        update(Cue)
        .where(col(Cue.track_id) == track_id)
        .values(tokens_json=None)
    )


def prepare_tracks_for_startup_recovery(engine: Engine) -> list[int]:
    """Al iniciar la app, devuelve a 'pending' las pistas colgadas en 'processing' o con versión vieja."""
    with Session(engine) as session:
        stmt = select(SubtitleTrack).where(
            or_(
                col(SubtitleTrack.tokens_status) == TokensStatus.PROCESSING.value,
                col(SubtitleTrack.tokens_status) == TokensStatus.PENDING.value,
                (col(SubtitleTrack.lang) == "zh")
                & (
                    col(SubtitleTrack.tokens_version).is_(None)
                    | (col(SubtitleTrack.tokens_version) < TOKENS_SCHEMA_VERSION)
                ),
            )
        )
        tracks = list(session.exec(stmt).all())
        if not tracks:
            return []

        to_enqueue: list[int] = []
        now = datetime.now(timezone.utc)
        for track in tracks:
            if track.id is None:
                continue
            if track.lang != "zh":
                track.tokens_status = TokensStatus.NOT_APPLICABLE.value
                track.tokens_updated_at = now
                session.add(track)
                continue
            track.tokens_status = TokensStatus.PENDING.value
            track.tokens_error = None
            track.tokens_updated_at = now
            session.add(track)
            to_enqueue.append(track.id)

        session.commit()
        if to_enqueue:
            logger.info(
                "Se encolarán %d pista(s) zh pendientes/interrumpidas al iniciar: %s",
                len(to_enqueue),
                to_enqueue,
            )
        return to_enqueue
