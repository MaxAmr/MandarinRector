"""Servicio de ingesta de video y subtítulos desde YouTube, Bilibili y plataformas vía `yt-dlp`."""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
import tempfile
from urllib.parse import urlparse

from sqlalchemy import Engine, insert
from sqlmodel import Session
import yt_dlp

from app.config import Settings
from app.models import Cue, SubtitleTrack, TokensStatus, Video, VideoStatus
from app.services.media import probe_video, process_video_pipeline
from app.services.storage import delete_file_safe, resolve_data_path
from app.services.subtitles import (
    SubtitleError,
    decode_subtitle_bytes,
    detect_language,
    parse_subtitles,
)
from app.services.tokenizer_job import tokenize_track
from app.services.translator import pair_video_subtitle_tracks_sync

logger = logging.getLogger("app.services.ytdlp_ingest")

SUBTITLE_EXTS = {".srt", ".vtt", ".ass", ".ssa"}


class InvalidVideoUrlError(ValueError):
    """La URL proporcionada no tiene un esquema o host HTTP(S) válido."""


@dataclass(slots=True)
class DownloadedSubFile:
    path: Path
    lang_tag: str
    resolved_lang: str
    label: str
    priority: int


@dataclass(slots=True)
class YtdlpDownloadResult:
    video_path: Path
    title: str
    webpage_url: str
    subtitles: list[DownloadedSubFile]


def validate_video_url(raw_url: str) -> str:
    """Valida que la URL sea HTTP o HTTPS con un hostname no vacío."""
    cleaned = raw_url.strip()
    if not cleaned:
        raise InvalidVideoUrlError("La URL no puede estar vacía.")

    parsed = urlparse(cleaned)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise InvalidVideoUrlError(
            "La URL debe comenzar con http:// o https:// y tener un dominio válido."
        )

    hostname = (parsed.hostname or "").lower()
    if hostname in {"localhost", "127.0.0.1", "0.0.0.0", "::1"}:
        raise InvalidVideoUrlError("No se permiten URLs hacia localhost.")

    return cleaned


def _classify_subtitle_lang_tag(lang_tag: str) -> tuple[str, str, int] | None:
    """Mapea un tag de idioma de yt-dlp (p. ej. `zh-Hans`, `es-419`) a `(lang_code, label, priority)`."""
    lower = lang_tag.lower().strip()
    if lower in {"live_chat", "danmaku"}:
        return None

    if lower.startswith(("zh", "cmn", "yue")):
        if "hant" in lower or "tw" in lower or "hk" in lower:
            return "zh", f"Chino Tradicional ({lang_tag})", 1
        if "hans" in lower or "cn" in lower or "sg" in lower:
            return "zh", f"Chino Simplificado ({lang_tag})", 0
        return "zh", f"Chino ({lang_tag})", 2

    if lower.startswith("es"):
        return "es", f"Español ({lang_tag})", 10

    if lower.startswith("en"):
        return "en", f"English ({lang_tag})", 20

    if lower.startswith("ja"):
        return "ja", f"Japonés ({lang_tag})", 30

    if lower.startswith("ko"):
        return "ko", f"Coreano ({lang_tag})", 40

    return None


def _run_ytdlp_download_sync(
    url: str,
    file_uuid: str,
    auto_subtitles: bool,
    max_height: int,
    settings: Settings,
) -> YtdlpDownloadResult:
    """Ejecuta `yt-dlp` en un directorio temporal y mueve el archivo de video final a `original_dir`."""
    settings.ensure_directories()

    with tempfile.TemporaryDirectory(prefix="clip_sniper_ytdlp_") as tmp_str:
        tmp_dir = Path(tmp_str)
        outtmpl = str(tmp_dir / f"{file_uuid}.%(ext)s")

        format_selector = (
            f"bestvideo[height<={max_height}][vcodec^=avc1]+bestaudio[acodec^=mp4a]/"
            f"bestvideo[height<={max_height}][ext=mp4]+bestaudio[ext=m4a]/"
            f"best[height<={max_height}][ext=mp4]/"
            f"best[height<={max_height}]/best"
        )

        ydl_opts: dict[str, object] = {
            "format": format_selector,
            "merge_output_format": "mp4",
            "outtmpl": outtmpl,
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "max_filesize": settings.MAX_UPLOAD_BYTES,
            "writesubtitles": auto_subtitles,
            "writeautomaticsub": auto_subtitles,
            "subtitleslangs": [
                "zh-Hans",
                "zh-CN",
                "zh",
                "zh-Hant",
                "zh-TW",
                "zh-HK",
                "es",
                "es-419",
                "es-ES",
                "en",
                "en-US",
            ],
            "subtitlesformat": "srt/vtt/ass/best",
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not isinstance(info, dict):
                raise RuntimeError("yt-dlp no devolvió metadatos válidos del video.")

        # Localizar el archivo de video descargado en tmp_dir
        video_candidates: list[Path] = []
        sub_candidates: list[Path] = []

        for path in tmp_dir.iterdir():
            if not path.is_file():
                continue
            ext = path.suffix.lower()
            if ext in SUBTITLE_EXTS:
                sub_candidates.append(path)
            elif ext in settings.ALLOWED_EXTENSIONS:
                video_candidates.append(path)

        if not video_candidates:
            raise RuntimeError(
                "yt-dlp finalizó pero no se encontró un archivo de video compatible."
            )

        # Elegir el archivo de video de mayor tamaño (en caso de residuos)
        video_candidates.sort(key=lambda p: p.stat().st_size, reverse=True)
        downloaded_video = video_candidates[0]
        final_ext = downloaded_video.suffix.lower() or ".mp4"
        dest_video_path = settings.original_dir / f"{file_uuid}{final_ext}"
        shutil.move(str(downloaded_video), str(dest_video_path))

        # Copiar archivos de subtítulos descargados a una subcarpeta persistente temporal para importarlos
        extracted_subs: list[DownloadedSubFile] = []
        seen_langs: set[str] = set()

        # Los archivos de subtítulos de yt-dlp tienen nombre `{file_uuid}.{lang}.{ext}`
        sub_candidates.sort(key=lambda p: p.name)
        for sub_file in sub_candidates:
            # Extraer lang_tag entre `{file_uuid}.` y `.{ext}`
            stem = sub_file.stem
            prefix = f"{file_uuid}."
            lang_tag = stem[len(prefix) :] if stem.startswith(prefix) else stem
            classified = _classify_subtitle_lang_tag(lang_tag)
            if classified is None:
                continue
            resolved_lang, label, priority = classified
            # Evitar importar 4 variantes del mismo idioma (ej. en, en-US, en-orig) salvo zh-Hans y zh-Hant
            dedup_key = (
                f"zh:{priority}" if resolved_lang == "zh" else resolved_lang
            )
            if dedup_key in seen_langs:
                continue
            seen_langs.add(dedup_key)

            persisted_sub = settings.DATA_DIR / f"_tmp_sub_{file_uuid}_{sub_file.name}"
            shutil.move(str(sub_file), str(persisted_sub))
            extracted_subs.append(
                DownloadedSubFile(
                    path=persisted_sub,
                    lang_tag=lang_tag,
                    resolved_lang=resolved_lang,
                    label=label,
                    priority=priority,
                )
            )

        extracted_subs.sort(key=lambda s: s.priority)
        raw_title = str(info.get("title") or "").strip() or "Video importado"
        webpage_url = str(info.get("webpage_url") or url)

        return YtdlpDownloadResult(
            video_path=dest_video_path,
            title=raw_title,
            webpage_url=webpage_url,
            subtitles=extracted_subs,
        )


def _import_downloaded_subtitles_sync(
    video_id: int,
    sub_files: list[DownloadedSubFile],
    engine: Engine,
    settings: Settings,
) -> list[int]:
    """Parsea e inserta en la DB los subtítulos descargados por yt-dlp. Retorna IDs de pistas 'zh'."""
    zh_track_ids: list[int] = []
    primary_assigned = False

    with Session(engine) as session:
        for sub in sub_files:
            try:
                raw_bytes = sub.path.read_bytes()
                decoded_text, detected_enc = decode_subtitle_bytes(
                    raw_bytes, max_bytes=settings.MAX_SUBTITLE_BYTES
                )
                parsed = parse_subtitles(
                    decoded_text,
                    filename=sub.path.name,
                    max_cues=settings.MAX_CUES,
                )
            except (OSError, SubtitleError) as exc:
                logger.warning(
                    "Subtítulo descargado %s omitido (%s)",
                    sub.path.name,
                    exc,
                )
                continue
            finally:
                sub.path.unlink(missing_ok=True)

            resolved_lang = sub.resolved_lang
            if resolved_lang not in settings.SUPPORTED_SUBTITLE_LANGS:
                resolved_lang = detect_language(parsed.cues)

            make_primary = False
            if not primary_assigned and (
                resolved_lang == "zh" or sub == sub_files[-1]
            ):
                make_primary = True
                primary_assigned = True

            tokens_status = (
                TokensStatus.PENDING.value
                if resolved_lang == "zh"
                else TokensStatus.NOT_APPLICABLE.value
            )

            track = SubtitleTrack(
                video_id=video_id,
                lang=resolved_lang,
                label=sub.label,
                is_primary=make_primary,
                source_format=parsed.source_format,
                original_filename=sub.path.name,
                detected_encoding=detected_enc,
                cue_count=len(parsed.cues),
                offset_ms=0,
                script=None,
                tokens_status=tokens_status,
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
                    "idx": c.idx,
                    "start_ms": c.start_ms,
                    "end_ms": c.end_ms,
                    "text": c.text,
                    "tokens_json": None,
                }
                for c in parsed.cues
            ]
            session.execute(insert(Cue), cue_mappings)
            session.commit()

            if resolved_lang == "zh":
                zh_track_ids.append(track.id)

        pair_video_subtitle_tracks_sync(video_id, session)

    return zh_track_ids


async def ingest_video_from_url_pipeline(
    video_id: int,
    url: str,
    custom_title: str | None,
    file_uuid: str,
    auto_subtitles: bool,
    max_height: int,
    engine: Engine,
    settings: Settings,
) -> None:
    """Pipeline asíncrono completo para descargar video + subtítulos desde una URL con `yt-dlp`."""
    downloaded_video_abs: Path | None = None
    try:
        dl_result = await asyncio.to_thread(
            _run_ytdlp_download_sync,
            url,
            file_uuid,
            auto_subtitles,
            max_height,
            settings,
        )
        downloaded_video_abs = dl_result.video_path
        rel_path = str(
            downloaded_video_abs.resolve().relative_to(settings.DATA_DIR.resolve())
        )
        stat_res = await asyncio.to_thread(downloaded_video_abs.stat)
        meta = await probe_video(downloaded_video_abs)

        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is None:
                await delete_file_safe(downloaded_video_abs)
                for s in dl_result.subtitles:
                    await delete_file_safe(s.path)
                return

            if not (custom_title or "").strip():
                video.title = dl_result.title[:300]
            video.original_filename = dl_result.webpage_url[:250]
            video.original_path = rel_path
            video.duration = meta.duration
            video.width = meta.width
            video.height = meta.height
            video.video_codec = meta.video_codec
            video.audio_codec = meta.audio_codec
            video.container = meta.container
            video.size_bytes = stat_res.st_size
            session.add(video)
            session.commit()

        # Importar subtítulos descargados y emparejarlos
        zh_track_ids: list[int] = []
        if dl_result.subtitles:
            zh_track_ids = await asyncio.to_thread(
                _import_downloaded_subtitles_sync,
                video_id,
                dl_result.subtitles,
                engine,
                settings,
            )

        # Generar copia de reproducción (si hace falta), miniatura JPEG y marcar status="ready"
        await process_video_pipeline(
            video_id=video_id,
            file_uuid=file_uuid,
            engine=engine,
            settings=settings,
        )

        # Tokenizar con jieba + pypinyin todas las pistas chinas importadas
        for tid in zh_track_ids:
            await tokenize_track(
                track_id=tid,
                engine=engine,
                settings=settings,
                force=True,
            )

    except Exception as exc:
        logger.exception(
            "Error al descargar/importar video id=%s desde URL %s",
            video_id,
            url,
        )
        if downloaded_video_abs is not None:
            try:
                resolved_orig = resolve_data_path(
                    settings,
                    str(
                        downloaded_video_abs.resolve().relative_to(
                            settings.DATA_DIR.resolve()
                        )
                    ),
                )
                await delete_file_safe(resolved_orig)
            except Exception:
                pass

        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is not None:
                video.status = VideoStatus.ERROR
                video.error_message = (
                    f"Error al descargar desde URL: {str(exc)[:450]}"
                )
                session.add(video)
                session.commit()
