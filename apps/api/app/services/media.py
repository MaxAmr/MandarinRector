import asyncio
from dataclasses import dataclass
import json
import logging
from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import Session

from app.config import Settings
from app.models import Video, VideoStatus
from app.services.storage import delete_file_safe, resolve_data_path

logger = logging.getLogger("app.services.media")

COMPATIBLE_CONTAINERS = frozenset({"mp4", "mov", "m4v", "webm"})
COMPATIBLE_VIDEO_CODECS = frozenset({"h264", "vp8", "vp9", "av1"})
COMPATIBLE_AUDIO_CODECS = frozenset({"aac", "mp3", "opus", "vorbis", None})


class InvalidMediaError(ValueError):
    """Error cuando el archivo no contiene un stream de video válido o ffprobe falla."""


class MediaProcessingError(RuntimeError):
    """Error al ejecutar ffmpeg para transcodificación o generación de thumbnail."""


@dataclass(slots=True)
class MediaMetadata:
    duration: float | None
    width: int
    height: int
    video_codec: str
    audio_codec: str | None
    container: str


def _normalize_container(format_name: str, file_path: Path) -> str:
    tokens = {part.strip().lower() for part in format_name.split(",") if part.strip()}
    ext = file_path.suffix.lower().lstrip(".")

    if "matroska" in tokens and "webm" in tokens:
        if ext == "webm":
            return "webm"
        return "mkv"
    if ext in {"mp4", "mov", "m4v"} and (tokens & {"mp4", "mov", "m4a"}):
        return ext
    if "avi" in tokens:
        return "avi"
    if ext and ext in tokens:
        return ext
    if tokens:
        return sorted(tokens)[0]
    return ext or "unknown"


async def probe_video(file_path: Path) -> MediaMetadata:
    """Inspecciona el archivo multimedia con ffprobe de forma asíncrona y sin shell."""
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(file_path),
    ]
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()

    if process.returncode != 0:
        err_text = stderr.decode("utf-8", errors="replace").strip()
        raise InvalidMediaError(
            f"ffprobe no pudo leer el archivo multimedia: {err_text or 'formato inválido'}"
        )

    try:
        payload = json.loads(stdout.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        raise InvalidMediaError("Salida JSON inválida desde ffprobe.") from exc

    streams = payload.get("streams") or []
    format_info = payload.get("format") or {}

    video_stream = None
    for stream in streams:
        if stream.get("codec_type") != "video":
            continue
        disposition = stream.get("disposition") or {}
        if disposition.get("attached_pic") == 1:
            continue
        video_stream = stream
        break

    if video_stream is None:
        raise InvalidMediaError("El archivo no contiene ningún stream de video válido.")

    video_codec = (video_stream.get("codec_name") or "").strip().lower()
    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    if not video_codec or width <= 0 or height <= 0:
        raise InvalidMediaError(
            "El stream de video no posee codec o dimensiones válidas."
        )

    audio_stream = next(
        (s for s in streams if s.get("codec_type") == "audio"),
        None,
    )
    audio_codec: str | None = None
    if audio_stream is not None:
        raw_acodec = (audio_stream.get("codec_name") or "").strip().lower()
        audio_codec = raw_acodec or None

    raw_duration = format_info.get("duration") or video_stream.get("duration")
    duration: float | None = None
    if raw_duration is not None:
        try:
            parsed_duration = float(raw_duration)
            if parsed_duration >= 0:
                duration = parsed_duration
        except (TypeError, ValueError):
            duration = None

    format_name = str(format_info.get("format_name") or "")
    container = _normalize_container(format_name, file_path)

    return MediaMetadata(
        duration=duration,
        width=width,
        height=height,
        video_codec=video_codec,
        audio_codec=audio_codec,
        container=container,
    )


def is_browser_compatible(
    container: str | None,
    video_codec: str | None,
    audio_codec: str | None,
) -> bool:
    """Evalúa si el contenedor y codecs son reproducibles directamente en navegadores HTML5."""
    norm_container = (container or "").lower()
    norm_vcodec = (video_codec or "").lower()
    norm_acodec = audio_codec.lower() if audio_codec else None

    return (
        norm_container in COMPATIBLE_CONTAINERS
        and norm_vcodec in COMPATIBLE_VIDEO_CODECS
        and norm_acodec in COMPATIBLE_AUDIO_CODECS
    )


async def transcode_for_playback(
    input_path: Path,
    output_path: Path,
    video_codec: str | None,
) -> None:
    """Genera un archivo MP4 compatible con navegador (copy de video si ya es H.264, o libx264)."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    norm_vcodec = (video_codec or "").lower()

    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(input_path)]
    if norm_vcodec == "h264":
        cmd.extend(["-c:v", "copy"])
    else:
        cmd.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
            ]
        )

    cmd.extend(
        [
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output_path),
        ]
    )

    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0:
        await delete_file_safe(output_path)
        err_text = stderr.decode("utf-8", errors="replace").strip()
        raise MediaProcessingError(
            f"Error al transcodificar video para reproducción: {err_text}"
        )


async def generate_thumbnail(
    input_path: Path,
    output_path: Path,
    duration: float | None,
) -> None:
    """Extrae un cuadro JPEG de 480px de ancho en el segundo min(duration * 0.1, 10)."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    seek_seconds = min((duration or 0.0) * 0.1, 10.0)
    if seek_seconds < 0:
        seek_seconds = 0.0

    cmd = [
        "ffmpeg",
        "-y",
        "-v",
        "error",
        "-ss",
        f"{seek_seconds:.3f}",
        "-i",
        str(input_path),
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        str(output_path),
    ]
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0 or not output_path.exists():
        await delete_file_safe(output_path)
        err_text = stderr.decode("utf-8", errors="replace").strip()
        raise MediaProcessingError(
            f"Error al generar thumbnail con ffmpeg: {err_text}"
        )


async def process_video_pipeline(
    video_id: int,
    file_uuid: str,
    engine: Engine,
    settings: Settings,
) -> None:
    """Tarea en segundo plano que genera copia de reproducción (si hace falta) y thumbnail.

    Abre su propia Session de base de datos, independiente del ciclo de vida de la request.
    """
    with Session(engine) as session:
        video = session.get(Video, video_id)
        if video is None:
            logger.warning(
                "Video id=%s ya no existe al iniciar el procesamiento de fondo.",
                video_id,
            )
            return

        original_rel = video.original_path
        video_codec = video.video_codec
        audio_codec = video.audio_codec
        container = video.container
        duration = video.duration

    try:
        original_abs = resolve_data_path(settings, original_rel)

        if is_browser_compatible(container, video_codec, audio_codec):
            playback_rel = original_rel
        else:
            playback_rel = f"videos/playback/{file_uuid}.mp4"
            playback_abs = resolve_data_path(settings, playback_rel)
            await transcode_for_playback(
                input_path=original_abs,
                output_path=playback_abs,
                video_codec=video_codec,
            )

        thumb_rel = f"thumbs/{file_uuid}.jpg"
        thumb_abs = resolve_data_path(settings, thumb_rel)
        await generate_thumbnail(
            input_path=original_abs,
            output_path=thumb_abs,
            duration=duration,
        )

        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is None:
                # Si el video fue eliminado mientras procesaba, limpiamos derivados
                if playback_rel != original_rel:
                    await delete_file_safe(resolve_data_path(settings, playback_rel))
                await delete_file_safe(thumb_abs)
                return
            video.playback_path = playback_rel
            video.thumbnail_path = thumb_rel
            video.status = VideoStatus.READY
            video.error_message = None
            session.add(video)
            session.commit()
            logger.info("Video id=%s procesado correctamente (status=ready).", video_id)

    except Exception as exc:
        logger.exception("Fallo en el procesamiento en segundo plano del video id=%s", video_id)
        truncated_msg = str(exc)[:500] or "Error interno durante el procesamiento multimedia."
        with Session(engine) as session:
            video = session.get(Video, video_id)
            if video is not None:
                video.status = VideoStatus.ERROR
                video.error_message = truncated_msg
                session.add(video)
                session.commit()
