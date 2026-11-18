import asyncio
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
from typing import Annotated

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import insert
from sqlmodel import Session, col, select

from app.config import Settings
from app.db import get_session
from app.models import Cue, SubtitleTrack, TokensStatus, Video
from app.schemas import (
    SubtitlePairResponse,
    SubtitleTrackRead,
    SubtitleTrackUpdate,
    SubtitleUploadResponse,
    TrackCuesResponse,
)
from app.services.chinese import TOKENS_SCHEMA_VERSION
from app.services.subtitles import (
    SubtitleParseError,
    SubtitleTooLargeError,
    decode_subtitle_bytes,
    detect_language,
    parse_subtitles,
)
from app.services.tokenizer_job import clear_track_tokens_sync, tokenize_track
from app.services.translator import pair_video_subtitle_tracks_sync

router = APIRouter(tags=["subtitles"])


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def _normalize_lang_code(raw_lang: str, allowed_langs: frozenset[str]) -> str:
    cleaned = raw_lang.strip().lower()
    if cleaned.startswith("zh"):
        cleaned = "zh"
    elif cleaned.startswith("es"):
        cleaned = "es"
    elif cleaned.startswith("en"):
        cleaned = "en"
    elif cleaned.startswith("ja"):
        cleaned = "ja"
    elif cleaned.startswith("ko"):
        cleaned = "ko"

    if cleaned not in allowed_langs:
        allowed_str = ", ".join(sorted(allowed_langs))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Idioma '{raw_lang}' no soportado. Valores permitidos: {allowed_str}",
        )
    return cleaned


def _build_track_etag(track: SubtitleTrack) -> str:
    updated_iso = (
        track.tokens_updated_at.isoformat() if track.tokens_updated_at else "none"
    )
    raw_token = (
        f"{track.id}:{track.cue_count}:{track.created_at.isoformat()}:"
        f"{track.tokens_version}:{track.tokens_status}:{updated_iso}"
    )
    digest = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()[:16]
    return f'"{track.id}-{track.cue_count}-{digest}"'


@router.post(
    "/api/videos/{video_id}/subtitles",
    response_model=SubtitleUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_subtitle_track(
    video_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    file: Annotated[UploadFile, File(...)],
    lang: Annotated[str | None, Form()] = None,
    label: Annotated[str | None, Form()] = None,
    is_primary: Annotated[bool | None, Form()] = None,
) -> SubtitleUploadResponse:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )

    original_filename = Path(file.filename or "subtitles.srt").name
    ext = Path(original_filename).suffix.lower()
    if ext not in settings.ALLOWED_SUBTITLE_EXTENSIONS:
        allowed_str = ", ".join(sorted(settings.ALLOWED_SUBTITLE_EXTENSIONS))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"Extensión de subtítulo '{ext or '(sin extensión)'}' no soportada. Permitidas: {allowed_str}",
        )

    raw_bytes = await file.read(settings.MAX_SUBTITLE_BYTES + 1)
    try:
        decoded_text, detected_encoding = decode_subtitle_bytes(
            raw_bytes,
            max_bytes=settings.MAX_SUBTITLE_BYTES,
        )
        parsed = parse_subtitles(
            decoded_text,
            filename=original_filename,
            max_cues=settings.MAX_CUES,
        )
    except SubtitleTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except SubtitleParseError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    raw_lang = (lang or "").strip()
    if not raw_lang or raw_lang.lower() == "auto":
        resolved_lang = detect_language(parsed.cues)
        lang_detected = True
    else:
        resolved_lang = _normalize_lang_code(raw_lang, settings.SUPPORTED_SUBTITLE_LANGS)
        lang_detected = False

    clean_label = (label or "").strip()
    if not clean_label:
        clean_label = Path(original_filename).stem or f"Subtítulo ({resolved_lang})"

    existing_tracks_stmt = select(SubtitleTrack).where(
        SubtitleTrack.video_id == video_id
    )
    existing_tracks = list(session.exec(existing_tracks_stmt).all())

    if not existing_tracks:
        make_primary = True
    elif is_primary is True:
        make_primary = True
    else:
        make_primary = False

    if make_primary:
        for existing in existing_tracks:
            if existing.is_primary:
                existing.is_primary = False
                session.add(existing)

    initial_tokens_status = (
        TokensStatus.PENDING.value
        if resolved_lang == "zh"
        else TokensStatus.NOT_APPLICABLE.value
    )

    track = SubtitleTrack(
        video_id=video_id,
        lang=resolved_lang,
        label=clean_label,
        is_primary=make_primary,
        source_format=parsed.source_format,
        original_filename=original_filename,
        detected_encoding=detected_encoding,
        cue_count=len(parsed.cues),
        offset_ms=0,
        script=None,
        tokens_status=initial_tokens_status,
        tokens_version=None,
        tokens_error=None,
        tokens_updated_at=datetime.now(timezone.utc),
    )
    session.add(track)
    session.flush()
    assert track.id is not None

    cue_mappings = [
        {
            "track_id": track.id,
            "idx": cue.idx,
            "start_ms": cue.start_ms,
            "end_ms": cue.end_ms,
            "text": cue.text,
            "tokens_json": None,
        }
        for cue in parsed.cues
    ]
    session.execute(insert(Cue), cue_mappings)
    session.commit()

    if existing_tracks:
        pair_video_subtitle_tracks_sync(video_id, session)

    session.refresh(track)

    if resolved_lang == "zh":
        background_tasks.add_task(
            tokenize_track,
            track_id=track.id,
            engine=request.app.state.engine,
            settings=settings,
            force=False,
        )

    base_dto = SubtitleTrackRead.model_validate(track)
    return SubtitleUploadResponse(
        **base_dto.model_dump(),
        warnings=parsed.warnings,
        skipped=parsed.skipped,
        lang_detected=lang_detected,
    )


@router.get(
    "/api/videos/{video_id}/subtitles",
    response_model=list[SubtitleTrackRead],
)
async def list_video_subtitle_tracks(
    video_id: int,
    session: Annotated[Session, Depends(get_session)],
) -> list[SubtitleTrackRead]:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )

    stmt = (
        select(SubtitleTrack)
        .where(SubtitleTrack.video_id == video_id)
        .order_by(
            col(SubtitleTrack.is_primary).desc(),
            col(SubtitleTrack.created_at).asc(),
            col(SubtitleTrack.id).asc(),
        )
    )
    tracks = list(session.exec(stmt).all())
    return [SubtitleTrackRead.model_validate(track) for track in tracks]


@router.get(
    "/api/subtitles/{track_id}/cues",
    response_model=TrackCuesResponse,
)
async def get_subtitle_track_cues(
    track_id: int,
    request: Request,
    session: Annotated[Session, Depends(get_session)],
) -> Response:
    track = session.get(SubtitleTrack, track_id)
    if track is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pista de subtítulos con id={track_id} no encontrada.",
        )

    etag = _build_track_etag(track)
    cache_headers = {
        "ETag": etag,
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Vary": "Accept-Encoding",
    }

    if_none_match = request.headers.get("if-none-match")
    if if_none_match:
        candidates = [token.strip() for token in if_none_match.split(",")]
        if "*" in candidates or etag in candidates or etag.removeprefix("W/") in [
            c.removeprefix("W/") for c in candidates
        ]:
            return Response(
                status_code=status.HTTP_304_NOT_MODIFIED,
                headers=cache_headers,
            )

    cues_stmt = (
        select(Cue)
        .where(Cue.track_id == track_id)
        .order_by(col(Cue.idx).asc())
    )
    cues = list(session.exec(cues_stmt).all())

    include_tokens = track.tokens_status == TokensStatus.READY.value
    serialized_cues = []
    for cue in cues:
        parsed_tokens = None
        if include_tokens and cue.tokens_json:
            try:
                parsed_tokens = json.loads(cue.tokens_json)
            except ValueError:
                parsed_tokens = None
        serialized_cues.append(
            {
                "idx": cue.idx,
                "start_ms": cue.start_ms,
                "end_ms": cue.end_ms,
                "text": cue.text,
                "tokens": parsed_tokens,
                "translation_text": cue.translation_text,
            }
        )

    payload_dict = {
        "track_id": track.id,
        "cues": serialized_cues,
    }
    raw_json_bytes = json.dumps(
        payload_dict,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")

    accept_encoding = request.headers.get("accept-encoding", "").lower()
    if "gzip" in accept_encoding:
        compressed_bytes = await asyncio.to_thread(
            gzip.compress, raw_json_bytes, 6
        )
        return Response(
            content=compressed_bytes,
            status_code=status.HTTP_200_OK,
            media_type="application/json",
            headers={
                **cache_headers,
                "Content-Encoding": "gzip",
                "Content-Length": str(len(compressed_bytes)),
            },
        )

    return Response(
        content=raw_json_bytes,
        status_code=status.HTTP_200_OK,
        media_type="application/json",
        headers={
            **cache_headers,
            "Content-Length": str(len(raw_json_bytes)),
        },
    )


@router.patch(
    "/api/subtitles/{track_id}",
    response_model=SubtitleTrackRead,
)
async def update_subtitle_track(
    track_id: int,
    payload: SubtitleTrackUpdate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> SubtitleTrackRead:
    track = session.get(SubtitleTrack, track_id)
    if track is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pista de subtítulos con id={track_id} no encontrada.",
        )

    if payload.label is not None:
        clean_label = payload.label.strip()
        if not clean_label:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="El nombre de la pista (label) no puede estar vacío.",
            )
        track.label = clean_label

    enqueue_tokenization = False
    if payload.lang is not None:
        new_lang = _normalize_lang_code(
            payload.lang, settings.SUPPORTED_SUBTITLE_LANGS
        )
        old_lang = track.lang
        track.lang = new_lang
        if old_lang != "zh" and new_lang == "zh":
            track.tokens_status = TokensStatus.PENDING.value
            track.tokens_error = None
            track.tokens_updated_at = datetime.now(timezone.utc)
            enqueue_tokenization = True
        elif old_lang == "zh" and new_lang != "zh":
            assert track.id is not None
            clear_track_tokens_sync(track.id, session, track)

    if payload.offset_ms is not None:
        if abs(payload.offset_ms) > settings.MAX_OFFSET_MS:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"El offset_ms debe estar entre -{settings.MAX_OFFSET_MS} y +{settings.MAX_OFFSET_MS} ms."
                ),
            )
        track.offset_ms = payload.offset_ms

    if payload.is_primary is not None:
        if payload.is_primary is True:
            if not track.is_primary:
                sibling_stmt = select(SubtitleTrack).where(
                    SubtitleTrack.video_id == track.video_id,
                    SubtitleTrack.id != track.id,
                )
                for sibling in session.exec(sibling_stmt).all():
                    if sibling.is_primary:
                        sibling.is_primary = False
                        session.add(sibling)
                track.is_primary = True
        else:
            if track.is_primary:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="No se puede desmarcar la pista primaria directamente; marcá otra pista como primaria.",
                )

    session.add(track)
    session.commit()

    if payload.is_primary is not None or payload.offset_ms is not None:
        pair_video_subtitle_tracks_sync(track.video_id, session)

    session.refresh(track)

    if enqueue_tokenization and track.id is not None:
        background_tasks.add_task(
            tokenize_track,
            track_id=track.id,
            engine=request.app.state.engine,
            settings=settings,
            force=True,
        )

    return SubtitleTrackRead.model_validate(track)


@router.post(
    "/api/subtitles/{track_id}/tokenize",
    response_model=SubtitleTrackRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_subtitle_tokenization(
    track_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    force: Annotated[bool, Query()] = False,
) -> SubtitleTrackRead:
    track = session.get(SubtitleTrack, track_id)
    if track is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pista de subtítulos con id={track_id} no encontrada.",
        )

    if track.lang != "zh":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Solo se pueden tokenizar pistas cuyo idioma sea chino ('zh').",
        )

    if track.tokens_status == TokensStatus.PROCESSING.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="La pista ya se encuentra en proceso de tokenización.",
        )

    if (
        not force
        and track.tokens_status == TokensStatus.READY.value
        and track.tokens_version == TOKENS_SCHEMA_VERSION
    ):
        return SubtitleTrackRead.model_validate(track)

    track.tokens_status = TokensStatus.PENDING.value
    track.tokens_error = None
    track.tokens_updated_at = datetime.now(timezone.utc)
    session.add(track)
    session.commit()
    session.refresh(track)

    assert track.id is not None
    background_tasks.add_task(
        tokenize_track,
        track_id=track.id,
        engine=request.app.state.engine,
        settings=settings,
        force=force,
    )
    return SubtitleTrackRead.model_validate(track)


@router.delete(
    "/api/subtitles/{track_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_subtitle_track(
    track_id: int,
    session: Annotated[Session, Depends(get_session)],
) -> Response:
    track = session.get(SubtitleTrack, track_id)
    if track is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pista de subtítulos con id={track_id} no encontrada.",
        )

    video_id = track.video_id
    was_primary = track.is_primary

    session.delete(track)
    session.flush()

    if was_primary:
        remaining_stmt = (
            select(SubtitleTrack)
            .where(SubtitleTrack.video_id == video_id)
            .order_by(
                col(SubtitleTrack.created_at).asc(),
                col(SubtitleTrack.id).asc(),
            )
        )
        oldest_remaining = session.exec(remaining_stmt).first()
        if oldest_remaining is not None:
            oldest_remaining.is_primary = True
            session.add(oldest_remaining)

    session.commit()
    pair_video_subtitle_tracks_sync(video_id, session)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/api/videos/{video_id}/subtitles/pair",
    response_model=SubtitlePairResponse,
)
async def pair_video_subtitle_tracks(
    video_id: int,
    session: Annotated[Session, Depends(get_session)],
    secondary_track_id: Annotated[int | None, Query()] = None,
) -> SubtitlePairResponse:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )

    matched = pair_video_subtitle_tracks_sync(
        video_id=video_id,
        session=session,
        secondary_track_id=secondary_track_id,
    )
    return SubtitlePairResponse(video_id=video_id, matched_cues=matched)
