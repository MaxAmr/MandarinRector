import asyncio
from pathlib import Path
from typing import Annotated
from uuid import uuid4

import aiofiles
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    status,
)
from sqlalchemy import func
from sqlmodel import Session, col, select

from app.config import Settings
from app.db import get_session
from app.models import Phrase, SubtitleTrack, Video, VideoStatus
from app.schemas import VideoFromUrlCreate, VideoListItem, VideoRead, VideoUpdate
from app.services.media import InvalidMediaError, probe_video, process_video_pipeline
from app.services.storage import (
    StorageValidationError,
    UploadTooLargeError,
    delete_file_safe,
    resolve_data_path,
    save_upload_streaming,
)
from app.services.streaming import build_range_streaming_response
from app.services.ytdlp_ingest import (
    InvalidVideoUrlError,
    ingest_video_from_url_pipeline,
    validate_video_url,
)

router = APIRouter(prefix="/api/videos", tags=["videos"])


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


@router.post(
    "",
    response_model=VideoRead,
    status_code=status.HTTP_201_CREATED,
)
async def upload_video(
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    file: Annotated[UploadFile, File(...)],
    title: Annotated[str | None, Form()] = None,
) -> VideoRead:
    try:
        saved = await save_upload_streaming(file, settings)
    except UploadTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=str(exc),
        ) from exc
    except StorageValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    try:
        meta = await probe_video(saved.absolute_path)
    except InvalidMediaError as exc:
        await delete_file_safe(saved.absolute_path)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    clean_title = (title or "").strip()
    if not clean_title:
        clean_title = Path(saved.original_filename).stem or "Video sin título"

    video = Video(
        title=clean_title,
        original_filename=saved.original_filename,
        original_path=saved.relative_path,
        playback_path=None,
        thumbnail_path=None,
        duration=meta.duration,
        width=meta.width,
        height=meta.height,
        video_codec=meta.video_codec,
        audio_codec=meta.audio_codec,
        container=meta.container,
        size_bytes=saved.size_bytes,
        status=VideoStatus.PROCESSING,
        error_message=None,
    )
    session.add(video)
    session.commit()
    session.refresh(video)

    assert video.id is not None
    background_tasks.add_task(
        process_video_pipeline,
        video_id=video.id,
        file_uuid=saved.file_uuid,
        engine=request.app.state.engine,
        settings=settings,
    )

    return VideoRead.from_video(video, tracks=[])


@router.post(
    "/from-url",
    response_model=VideoRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_video_from_url(
    payload: VideoFromUrlCreate,
    request: Request,
    background_tasks: BackgroundTasks,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> VideoRead:
    try:
        clean_url = validate_video_url(payload.url)
    except InvalidVideoUrlError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc

    file_uuid = uuid4().hex
    clean_title = (payload.title or "").strip()
    initial_title = clean_title or "Descargando desde URL..."

    video = Video(
        title=initial_title,
        original_filename=clean_url[:250],
        original_path=f"videos/original/{file_uuid}.mp4",
        playback_path=None,
        thumbnail_path=None,
        duration=None,
        width=None,
        height=None,
        video_codec=None,
        audio_codec=None,
        container="mp4",
        size_bytes=0,
        status=VideoStatus.PROCESSING,
        error_message=None,
    )
    session.add(video)
    session.commit()
    session.refresh(video)

    assert video.id is not None
    background_tasks.add_task(
        ingest_video_from_url_pipeline,
        video_id=video.id,
        url=clean_url,
        custom_title=clean_title or None,
        file_uuid=file_uuid,
        auto_subtitles=payload.auto_subtitles,
        max_height=payload.max_height,
        engine=request.app.state.engine,
        settings=settings,
    )

    return VideoRead.from_video(video, tracks=[])


@router.get("", response_model=list[VideoListItem])
async def list_videos(
    session: Annotated[Session, Depends(get_session)],
) -> list[VideoListItem]:
    videos_stmt = select(Video).order_by(col(Video.created_at).desc(), col(Video.id).desc())
    videos = list(session.exec(videos_stmt).all())
    if not videos:
        return []

    counts_stmt = select(
        SubtitleTrack.video_id,
        func.count(col(SubtitleTrack.id)),
    ).group_by(col(SubtitleTrack.video_id))
    subtitle_counts = {
        video_id: int(count) for video_id, count in session.exec(counts_stmt).all()
    }

    return [
        VideoListItem.from_video(
            video,
            subtitle_count=subtitle_counts.get(video.id or -1, 0),
        )
        for video in videos
    ]


@router.get("/{video_id}", response_model=VideoRead)
async def get_video(
    video_id: int,
    session: Annotated[Session, Depends(get_session)],
) -> VideoRead:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )
    tracks_stmt = select(SubtitleTrack).where(SubtitleTrack.video_id == video_id)
    tracks = list(session.exec(tracks_stmt).all())
    return VideoRead.from_video(video, tracks=tracks)


@router.patch("/{video_id}", response_model=VideoRead)
async def update_video(
    video_id: int,
    payload: VideoUpdate,
    session: Annotated[Session, Depends(get_session)],
) -> VideoRead:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )
    clean_title = payload.title.strip()
    if not clean_title:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="El título no puede estar vacío.",
        )
    video.title = clean_title
    session.add(video)
    session.commit()
    session.refresh(video)

    tracks_stmt = select(SubtitleTrack).where(SubtitleTrack.video_id == video_id)
    tracks = list(session.exec(tracks_stmt).all())
    return VideoRead.from_video(video, tracks=tracks)


@router.delete("/{video_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_video(
    video_id: int,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )

    paths_to_delete: set[Path] = set()
    for rel_path in (video.original_path, video.playback_path, video.thumbnail_path):
        if rel_path:
            try:
                paths_to_delete.add(resolve_data_path(settings, rel_path))
            except ValueError:
                pass

    phrases_stmt = select(Phrase).where(Phrase.video_id == video_id)
    for phrase in session.exec(phrases_stmt).all():
        for clip_rel in (
            phrase.clip_video_path,
            phrase.clip_audio_path,
            phrase.clip_thumb_path,
        ):
            if clip_rel:
                try:
                    paths_to_delete.add(resolve_data_path(settings, clip_rel))
                except ValueError:
                    pass

    # Gracias a PRAGMA foreign_keys=ON y ondelete="CASCADE" en SubtitleTrack y Cue,
    # eliminar el registro de Video borra en cascada todas sus pistas y cues asociados.
    session.delete(video)
    session.commit()

    for file_path in paths_to_delete:
        await delete_file_safe(file_path)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{video_id}/thumbnail")
async def get_video_thumbnail(
    video_id: int,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    video = session.get(Video, video_id)
    if video is None or not video.thumbnail_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Miniatura no disponible para este video.",
        )

    thumb_path = resolve_data_path(settings, video.thumbnail_path)
    exists = await asyncio.to_thread(thumb_path.is_file)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Archivo de miniatura no encontrado en disco.",
        )

    async with aiofiles.open(thumb_path, mode="rb") as thumb_file:
        data = await thumb_file.read()

    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.api_route("/{video_id}/stream", methods=["GET", "HEAD"])
async def stream_video(
    video_id: int,
    request: Request,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> Response:
    video = session.get(Video, video_id)
    if video is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Video con id={video_id} no encontrado.",
        )

    if video.status != VideoStatus.READY or not video.playback_path:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"El video no está listo para reproducirse (estado actual: '{video.status.value}')."
            ),
        )

    playback_abs = resolve_data_path(settings, video.playback_path)
    exists = await asyncio.to_thread(playback_abs.is_file)
    if not exists:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="El archivo de reproducción no se encuentra en disco.",
        )

    range_header = request.headers.get("range")
    return await build_range_streaming_response(
        file_path=playback_abs,
        range_header=range_header,
        method=request.method,
        chunk_size=settings.STREAM_CHUNK_SIZE,
    )
