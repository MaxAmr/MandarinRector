import asyncio
import json
from pathlib import Path
from typing import Annotated

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from sqlmodel import Session, col, or_, select

from app.config import Settings
from app.db import get_session
from app.models import ClipStatus, Cue, Phrase, SubtitleTrack, Video
from app.schemas import (
    PhraseCreate,
    PhraseRead,
    PhraseUpdate,
    TranslateRequest,
    TranslateResponse,
)
from app.services.chinese import tokenize_cue, tokens_to_pinyin_string
from app.services.clipper import cut_phrase_clips
from app.services.storage import delete_file_safe, resolve_data_path
from app.services.streaming import build_range_streaming_response
from app.services.translator import translate_text_cached

router = APIRouter(tags=["phrases"])


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


@router.post("/api/translate", response_model=TranslateResponse)
async def translate_text_endpoint(
    payload: TranslateRequest,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> TranslateResponse:
    clean_text = payload.text.strip()
    if not clean_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="El texto a traducir no puede estar vacío.",
        )

    translated, provider, cached = await translate_text_cached(
        session=session,
        text=clean_text,
        target_lang=payload.target_lang,
        settings=settings,
    )
    return TranslateResponse(
        source_text=clean_text,
        target_lang=payload.target_lang,
        translated_text=translated,
        provider=provider,
        cached=cached,
    )


@router.post(
    "/api/phrases",
    response_model=PhraseRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_phrase(
    payload: PhraseCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PhraseRead:
    video = session.get(Video, payload.video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={payload.video_id} no encontrado.",
        )

    track: SubtitleTrack | None = None
    cue: Cue | None = None
    if payload.track_id is not None:
        track = session.get(SubtitleTrack, payload.track_id)
        if track is None or track.video_id != payload.video_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Pista id={payload.track_id} no encontrada para este video.",
            )
        if payload.cue_idx is not None:
            cue = session.exec(
                select(Cue).where(
                    Cue.track_id == payload.track_id,
                    Cue.idx == payload.cue_idx,
                )
            ).first()

    # 1. Resolver hanzi
    hanzi = (payload.hanzi or "").strip()
    if not hanzi and cue is not None:
        hanzi = cue.text.strip()
    if not hanzi:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Se requiere 'hanzi' o un (track_id, cue_idx) válido.",
        )

    # 2. Resolver pinyin (reutilizando tokens_json de Fase 3 sin recalcular cuando exista)
    pinyin = (payload.pinyin or "").strip()
    if not pinyin:
        if cue is not None and cue.tokens_json:
            try:
                pinyin = tokens_to_pinyin_string(json.loads(cue.tokens_json))
            except ValueError:
                pinyin = ""
        if not pinyin:
            pinyin = tokens_to_pinyin_string(tokenize_cue(hanzi))

    # 3. Resolver traducción (pista secundaria emparejada -> input -> traducción con caché)
    translation = (payload.translation or "").strip()
    if not translation and cue is not None and cue.translation_text:
        translation = cue.translation_text.strip()
    if not translation:
        translation, _, _ = await translate_text_cached(
            session=session,
            text=hanzi,
            target_lang="es",
            tokens_json=cue.tokens_json if cue else None,
            settings=settings,
        )

    # 4. Resolver tiempos start_ms y end_ms aplicando offset_ms de la pista y margen ±pad_ms
    if payload.start_ms is not None and payload.end_ms is not None:
        start_ms = payload.start_ms
        end_ms = payload.end_ms
    elif cue is not None:
        offset_ms = (
            track.offset_ms if (track is not None and payload.apply_track_offset) else 0
        )
        start_ms = max(0, cue.start_ms + offset_ms - payload.pad_ms)
        end_ms = max(start_ms + 200, cue.end_ms + offset_ms + payload.pad_ms)
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Debés indicar start_ms/end_ms o un cue_idx válido.",
        )

    if start_ms < 0 or end_ms <= start_ms:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Rango de tiempo inválido (end_ms debe ser mayor que start_ms >= 0).",
        )

    phrase = Phrase(
        video_id=payload.video_id,
        track_id=payload.track_id,
        cue_idx=payload.cue_idx,
        hanzi=hanzi,
        focus_word=(payload.focus_word or "").strip() or None,
        pinyin=pinyin,
        translation=translation,
        notes=(payload.notes or "").strip() or None,
        start_ms=start_ms,
        end_ms=end_ms,
        clip_status=ClipStatus.PENDING.value,
    )
    session.add(phrase)
    session.commit()
    session.refresh(phrase)

    assert phrase.id is not None
    background_tasks.add_task(
        cut_phrase_clips,
        phrase_id=phrase.id,
        engine=request.app.state.engine,
        settings=settings,
    )
    return PhraseRead.from_phrase(phrase)


@router.get("/api/phrases", response_model=list[PhraseRead])
async def list_phrases(
    session: Annotated[Session, Depends(get_session)],
    video_id: Annotated[int | None, Query()] = None,
    q: Annotated[str | None, Query()] = None,
) -> list[PhraseRead]:
    stmt = select(Phrase)
    if video_id is not None:
        stmt = stmt.where(Phrase.video_id == video_id)
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                col(Phrase.hanzi).like(pattern),
                col(Phrase.pinyin).like(pattern),
                col(Phrase.translation).like(pattern),
                col(Phrase.focus_word).like(pattern),
                col(Phrase.notes).like(pattern),
            )
        )
    stmt = stmt.order_by(col(Phrase.created_at).desc(), col(Phrase.id).desc())
    phrases = list(session.exec(stmt).all())
    return [PhraseRead.from_phrase(p) for p in phrases]


@router.get("/api/phrases/{phrase_id}", response_model=PhraseRead)
async def get_phrase(
    phrase_id: int,
    session: Annotated[Session, Depends(get_session)],
) -> PhraseRead:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Frase con id={phrase_id} no encontrada.",
        )
    return PhraseRead.from_phrase(phrase)


@router.patch("/api/phrases/{phrase_id}", response_model=PhraseRead)
async def update_phrase(
    phrase_id: int,
    payload: PhraseUpdate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> PhraseRead:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Frase con id={phrase_id} no encontrada.",
        )

    if payload.hanzi is not None:
        clean_hanzi = payload.hanzi.strip()
        if not clean_hanzi:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="El campo hanzi no puede estar vacío.",
            )
        phrase.hanzi = clean_hanzi

    if payload.focus_word is not None:
        phrase.focus_word = payload.focus_word.strip() or None

    if payload.pinyin is not None:
        phrase.pinyin = payload.pinyin.strip()

    if payload.translation is not None:
        phrase.translation = payload.translation.strip()

    if payload.notes is not None:
        phrase.notes = payload.notes.strip() or None

    recut_needed = False
    new_start = payload.start_ms if payload.start_ms is not None else phrase.start_ms
    new_end = payload.end_ms if payload.end_ms is not None else phrase.end_ms
    if new_start < 0 or new_end <= new_start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Rango de tiempo inválido (end_ms debe ser mayor que start_ms >= 0).",
        )

    if new_start != phrase.start_ms or new_end != phrase.end_ms:
        phrase.start_ms = new_start
        phrase.end_ms = new_end
        phrase.clip_status = ClipStatus.PENDING.value
        phrase.clip_error = None
        recut_needed = True

    session.add(phrase)
    session.commit()
    session.refresh(phrase)

    if recut_needed and phrase.id is not None:
        background_tasks.add_task(
            cut_phrase_clips,
            phrase_id=phrase.id,
            engine=request.app.state.engine,
            settings=settings,
        )

    return PhraseRead.from_phrase(phrase)


@router.delete("/api/phrases/{phrase_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_phrase(
    phrase_id: int,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Frase con id={phrase_id} no encontrada.",
        )

    paths: list[Path] = []
    for rel in (
        phrase.clip_video_path,
        phrase.clip_audio_path,
        phrase.clip_thumb_path,
    ):
        if rel:
            try:
                paths.append(resolve_data_path(settings, rel))
            except ValueError:
                pass

    session.delete(phrase)
    session.commit()

    for p in paths:
        await delete_file_safe(p)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.api_route("/api/phrases/{phrase_id}/video", methods=["GET", "HEAD"])
async def stream_phrase_video_clip(
    phrase_id: int,
    request: Request,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Frase con id={phrase_id} no encontrada.",
        )
    if phrase.clip_status != ClipStatus.READY.value or not phrase.clip_video_path:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El clip de video aún no está listo (estado: {phrase.clip_status}).",
        )

    clip_abs = resolve_data_path(settings, phrase.clip_video_path)
    exists = await asyncio.to_thread(clip_abs.is_file)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Archivo de clip de video no encontrado en disco.",
        )

    return await build_range_streaming_response(
        file_path=clip_abs,
        range_header=request.headers.get("range"),
        method=request.method,
        chunk_size=settings.STREAM_CHUNK_SIZE,
    )


@router.get("/api/phrases/{phrase_id}/audio")
async def get_phrase_audio_clip(
    phrase_id: int,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Frase con id={phrase_id} no encontrada.",
        )
    if phrase.clip_status != ClipStatus.READY.value or not phrase.clip_audio_path:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"El clip de audio aún no está listo (estado: {phrase.clip_status}).",
        )

    audio_abs = resolve_data_path(settings, phrase.clip_audio_path)
    exists = await asyncio.to_thread(audio_abs.is_file)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Archivo de audio no encontrado en disco.",
        )

    async with aiofiles.open(audio_abs, mode="rb") as fh:
        data = await fh.read()

    return Response(
        content=data,
        media_type="audio/mpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.get("/api/phrases/{phrase_id}/thumbnail")
async def get_phrase_thumbnail(
    phrase_id: int,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    phrase = session.get(Phrase, phrase_id)
    if phrase is None or not phrase.clip_thumb_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Miniatura del clip no disponible.",
        )

    thumb_abs = resolve_data_path(settings, phrase.clip_thumb_path)
    exists = await asyncio.to_thread(thumb_abs.is_file)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Archivo de miniatura del clip no encontrado en disco.",
        )

    async with aiofiles.open(thumb_abs, mode="rb") as fh:
        data = await fh.read()

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )
