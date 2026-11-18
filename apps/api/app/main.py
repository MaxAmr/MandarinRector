import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
import shutil

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import Settings, get_settings
from app.db import build_engine, init_db, recover_interrupted_videos
from app.routers.dictionary import router as dictionary_router
from app.routers.export import router as export_router
from app.routers.phrases import router as phrases_router
from app.routers.subtitles import router as subtitles_router
from app.routers.videos import router as videos_router
from app.services.chinese import init_segmenter
from app.services.clipper import (
    cut_phrase_clips,
    prepare_phrases_for_startup_recovery,
)
from app.services.dictionary import auto_import_cedict_if_present
from app.services.tokenizer_job import (
    prepare_tracks_for_startup_recovery,
    tokenize_track,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("app.main")


def verify_ffmpeg_binaries() -> None:
    """Verifica que ffmpeg y ffprobe estén disponibles en PATH al arrancar."""
    missing = [
        binary for binary in ("ffmpeg", "ffprobe") if shutil.which(binary) is None
    ]
    if missing:
        missing_str = ", ".join(missing)
        error_msg = (
            f"Binarios multimedia requeridos no encontrados en PATH: {missing_str}. "
            "Instalá ffmpeg (que incluye ffprobe) antes de iniciar el servidor."
        )
        logger.critical(error_msg)
        raise RuntimeError(error_msg)


def create_app(settings_override: Settings | None = None) -> FastAPI:
    """Application factory de FastAPI."""
    settings = settings_override or get_settings()
    engine = build_engine(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        verify_ffmpeg_binaries()
        settings.ensure_directories()
        await asyncio.to_thread(init_db, app.state.engine)
        await asyncio.to_thread(
            init_segmenter,
            settings.resolved_userdict_path,
            settings.resolved_pinyin_overrides_path,
        )
        await asyncio.to_thread(
            auto_import_cedict_if_present,
            settings.resolved_cedict_path,
            app.state.engine,
        )
        await asyncio.to_thread(recover_interrupted_videos, app.state.engine)

        tracks_to_recover = await asyncio.to_thread(
            prepare_tracks_for_startup_recovery,
            app.state.engine,
        )
        phrases_to_recover = await asyncio.to_thread(
            prepare_phrases_for_startup_recovery,
            app.state.engine,
        )
        recovery_tasks: list[asyncio.Task[bool]] = [
            asyncio.create_task(
                tokenize_track(
                    track_id=tid,
                    engine=app.state.engine,
                    settings=settings,
                    force=True,
                )
            )
            for tid in tracks_to_recover
        ] + [
            asyncio.create_task(
                cut_phrase_clips(
                    phrase_id=pid,
                    engine=app.state.engine,
                    settings=settings,
                )
            )
            for pid in phrases_to_recover
        ]
        app.state.recovery_tasks = recovery_tasks

        logger.info(
            "Iniciando backend Mandarin Reactor v0.3.0 (DATA_DIR=%s)",
            settings.DATA_DIR.resolve(),
        )
        yield
        if recovery_tasks:
            await asyncio.gather(*recovery_tasks, return_exceptions=True)
        app.state.engine.dispose()
        logger.info("Cerrando backend Mandarin Reactor")

    app = FastAPI(
        title="Mandarin Reactor API",
        version="0.3.0",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Range", "Accept-Ranges", "Content-Length", "ETag"],
    )

    @app.get("/api/health", tags=["health"])
    async def health_check() -> dict[str, str | bool]:
        has_ffmpeg = (
            shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
        )
        return {"status": "ok", "ffmpeg": has_ffmpeg}

    app.include_router(videos_router)
    app.include_router(subtitles_router)
    app.include_router(dictionary_router)
    app.include_router(phrases_router)
    app.include_router(export_router)

    return app
