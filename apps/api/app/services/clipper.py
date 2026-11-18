"""Servicio de corte de clips multimedia (video MP4, audio MP3 y captura JPEG) con ffmpeg (Fase 6)."""

import asyncio
import logging
from pathlib import Path
from uuid import uuid4

from sqlalchemy import Engine, or_
from sqlmodel import Session, col, select

from app.config import Settings
from app.models import ClipStatus, Phrase, Video
from app.services.storage import delete_file_safe, resolve_data_path

logger = logging.getLogger("app.services.clipper")

_CLIP_SEMAPHORE = asyncio.Semaphore(2)


class ClipGenerationError(RuntimeError):
    """Error cuando ffmpeg falla al generar alguno de los derivados del clip."""


async def _run_ffmpeg_cmd(cmd: list[str], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    process = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0 or not output_path.is_file():
        await delete_file_safe(output_path)
        err_text = stderr.decode("utf-8", errors="replace").strip()
        raise ClipGenerationError(
            f"ffmpeg falló ({output_path.name}): {err_text or 'código de salida != 0'}"
        )


async def cut_phrase_clips(
    phrase_id: int,
    engine: Engine,
    settings: Settings,
) -> bool:
    """Tarea en segundo plano que corta el clip MP4, el audio MP3 y la miniatura JPEG de una `Phrase`.

    Usa siempre `Video.original_path` como archivo de entrada para preservar calidad y precisión.
    """
    async with _CLIP_SEMAPHORE:
        with Session(engine) as session:
            phrase = session.get(Phrase, phrase_id)
            if phrase is None:
                return False
            video = session.get(Video, phrase.video_id)
            if video is None:
                return False

            original_rel = video.original_path
            video_duration = video.duration
            start_ms = max(0, phrase.start_ms)
            end_ms = max(start_ms + 200, phrase.end_ms)
            if video_duration is not None and video_duration > 0:
                max_ms = int(video_duration * 1000)
                if start_ms >= max_ms:
                    start_ms = max(0, max_ms - 500)
                end_ms = min(max(start_ms + 200, end_ms), max_ms)

            old_paths = [
                phrase.clip_video_path,
                phrase.clip_audio_path,
                phrase.clip_thumb_path,
            ]
            phrase.clip_status = ClipStatus.PROCESSING.value
            phrase.clip_error = None
            session.add(phrase)
            session.commit()

        start_sec = start_ms / 1000.0
        end_sec = end_ms / 1000.0
        duration_sec = max(0.2, end_sec - start_sec)
        mid_sec = (start_sec + end_sec) / 2.0

        token = f"clip_{phrase_id}_{uuid4().hex[:8]}"
        video_rel = f"clips/{token}.mp4"
        audio_rel = f"clips/{token}.mp3"
        thumb_rel = f"clips/{token}.jpg"

        original_abs = resolve_data_path(settings, original_rel)
        video_abs = resolve_data_path(settings, video_rel)
        audio_abs = resolve_data_path(settings, audio_rel)
        thumb_abs = resolve_data_path(settings, thumb_rel)

        try:
            # 1. Clip de video H.264 + AAC (480p, faststart, compatible con Anki y navegadores)
            cmd_video = [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{start_sec:.3f}",
                "-i",
                str(original_abs),
                "-t",
                f"{duration_sec:.3f}",
                "-vf",
                "scale=-2:480",
                "-c:v",
                "libx264",
                "-crf",
                "28",
                "-preset",
                "veryfast",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "96k",
                "-movflags",
                "+faststart",
                str(video_abs),
            ]
            await _run_ffmpeg_cmd(cmd_video, video_abs)

            # 2. Clip solo audio MP3
            cmd_audio = [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{start_sec:.3f}",
                "-i",
                str(original_abs),
                "-t",
                f"{duration_sec:.3f}",
                "-vn",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "4",
                str(audio_abs),
            ]
            await _run_ffmpeg_cmd(cmd_audio, audio_abs)

            # 3. Captura de pantalla en el punto medio del clip
            cmd_thumb = [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{mid_sec:.3f}",
                "-i",
                str(original_abs),
                "-frames:v",
                "1",
                "-vf",
                "scale=480:-2",
                str(thumb_abs),
            ]
            await _run_ffmpeg_cmd(cmd_thumb, thumb_abs)

            with Session(engine) as session:
                phrase = session.get(Phrase, phrase_id)
                if phrase is None:
                    # La frase fue eliminada mientras ffmpeg corría: borrar archivos nuevos
                    await delete_file_safe(video_abs)
                    await delete_file_safe(audio_abs)
                    await delete_file_safe(thumb_abs)
                    return False

                phrase.clip_video_path = video_rel
                phrase.clip_audio_path = audio_rel
                phrase.clip_thumb_path = thumb_rel
                phrase.clip_status = ClipStatus.READY.value
                phrase.clip_error = None
                session.add(phrase)
                session.commit()

            # Limpiar clips previos si fue un recorte re-ajustado
            for old_rel in old_paths:
                if old_rel and old_rel not in {video_rel, audio_rel, thumb_rel}:
                    try:
                        await delete_file_safe(resolve_data_path(settings, old_rel))
                    except ValueError:
                        pass

            logger.info(
                "Clips generados para Phrase id=%s (%.2fs - %.2fs).",
                phrase_id,
                start_sec,
                end_sec,
            )
            return True

        except Exception as exc:
            logger.exception("Error al cortar clips para Phrase id=%s", phrase_id)
            await delete_file_safe(video_abs)
            await delete_file_safe(audio_abs)
            await delete_file_safe(thumb_abs)

            with Session(engine) as session:
                phrase = session.get(Phrase, phrase_id)
                if phrase is not None:
                    phrase.clip_status = ClipStatus.ERROR.value
                    phrase.clip_error = str(exc)[:500]
                    session.add(phrase)
                    session.commit()
            return False


def prepare_phrases_for_startup_recovery(engine: Engine) -> list[int]:
    """Devuelve a `pending` las frases cuyo corte de clip quedó interrumpido al reiniciar."""
    with Session(engine) as session:
        stmt = select(Phrase).where(
            or_(
                col(Phrase.clip_status) == ClipStatus.PROCESSING.value,
                col(Phrase.clip_status) == ClipStatus.PENDING.value,
            )
        )
        phrases = list(session.exec(stmt).all())
        if not phrases:
            return []

        to_enqueue: list[int] = []
        for phrase in phrases:
            if phrase.id is None:
                continue
            phrase.clip_status = ClipStatus.PENDING.value
            phrase.clip_error = None
            session.add(phrase)
            to_enqueue.append(phrase.id)

        session.commit()
        return to_enqueue
