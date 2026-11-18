import asyncio
from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlmodel import Session, col, select

from app.config import Settings
from app.db import get_session
from app.models import Phrase, Video
from app.schemas import AnkiConnectExportResponse, AnkiExportRequest
from app.services.anki_export import (
    CardType,
    build_anki_apkg_bytes,
    push_phrases_to_ankiconnect,
)

router = APIRouter(prefix="/api/export", tags=["export"])

VALID_CARD_TYPES = {"listening", "reading", "production"}


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def _select_phrases_and_videos(
    session: Session,
    video_id: int | None,
    phrase_ids: list[int] | None,
) -> tuple[list[Phrase], dict[int, Video]]:
    stmt = select(Phrase)
    if video_id is not None:
        stmt = stmt.where(Phrase.video_id == video_id)
    if phrase_ids:
        stmt = stmt.where(col(Phrase.id).in_(phrase_ids))
    stmt = stmt.order_by(col(Phrase.created_at).asc(), col(Phrase.id).asc())

    phrases = list(session.exec(stmt).all())
    if not phrases:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No hay frases guardadas que coincidan con el filtro para exportar.",
        )

    video_ids = {p.video_id for p in phrases}
    videos = list(
        session.exec(select(Video).where(col(Video.id).in_(video_ids))).all()
    )
    videos_by_id = {v.id: v for v in videos if v.id is not None}
    return phrases, videos_by_id


def _validate_card_types(raw_types: list[str]) -> list[CardType]:
    cleaned = [t.strip().lower() for t in raw_types if t.strip()]
    invalid = [t for t in cleaned if t not in VALID_CARD_TYPES]
    if invalid or not cleaned:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                f"Tipos de tarjeta inválidos ({invalid}). "
                "Permitidos: listening, reading, production."
            ),
        )
    return cast(list[CardType], cleaned)


@router.get("/anki")
async def export_anki_apkg_get(
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    video_id: Annotated[int | None, Query()] = None,
    deck_name: Annotated[str, Query()] = "Mandarín - Clips",
    include_video: Annotated[bool, Query()] = False,
) -> Response:
    phrases, videos_by_id = _select_phrases_and_videos(session, video_id, None)
    apkg_bytes = await asyncio.to_thread(
        build_anki_apkg_bytes,
        phrases,
        videos_by_id,
        settings,
        deck_name,
        include_video,
        ["listening", "reading"],
    )
    return Response(
        content=apkg_bytes,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": 'attachment; filename="mandarin_clips.apkg"',
            "Content-Length": str(len(apkg_bytes)),
        },
    )


@router.post("/anki")
async def export_anki_apkg_post(
    payload: AnkiExportRequest,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    card_types = _validate_card_types(payload.card_types)
    phrases, videos_by_id = _select_phrases_and_videos(
        session, payload.video_id, payload.phrase_ids
    )
    apkg_bytes = await asyncio.to_thread(
        build_anki_apkg_bytes,
        phrases,
        videos_by_id,
        settings,
        payload.deck_name,
        payload.include_video,
        card_types,
    )
    return Response(
        content=apkg_bytes,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": 'attachment; filename="mandarin_clips.apkg"',
            "Content-Length": str(len(apkg_bytes)),
        },
    )


@router.post("/ankiconnect", response_model=AnkiConnectExportResponse)
async def export_via_ankiconnect(
    payload: AnkiExportRequest,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> AnkiConnectExportResponse:
    phrases, videos_by_id = _select_phrases_and_videos(
        session, payload.video_id, payload.phrase_ids
    )
    try:
        result = await push_phrases_to_ankiconnect(
            phrases=phrases,
            videos_by_id=videos_by_id,
            settings=settings,
            deck_name=payload.deck_name,
            anki_connect_url=payload.anki_connect_url,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "No se pudo conectar con AnkiConnect. Asegurate de tener Anki abierto "
                f"con el complemento AnkiConnect (2055492159) activo: {exc}"
            ),
        ) from exc

    return AnkiConnectExportResponse(
        deck_name=payload.deck_name,
        added=result["added"],
        skipped=result["skipped"],
    )
