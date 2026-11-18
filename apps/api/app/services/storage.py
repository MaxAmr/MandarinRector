import asyncio
from dataclasses import dataclass
import logging
from pathlib import Path
from uuid import uuid4

import aiofiles
from fastapi import UploadFile

from app.config import Settings

logger = logging.getLogger("app.services.storage")


class StorageValidationError(ValueError):
    """Error cuando la extensión o el MIME declarado no son válidos."""


class UploadTooLargeError(ValueError):
    """Error cuando el archivo subido excede MAX_UPLOAD_BYTES."""


@dataclass(slots=True)
class SavedUpload:
    file_uuid: str
    original_filename: str
    extension: str
    relative_path: str
    absolute_path: Path
    size_bytes: int


def extract_safe_extension(filename: str | None, allowed_extensions: frozenset[str]) -> str:
    if not filename:
        raise StorageValidationError("El archivo subido no tiene nombre.")
    clean_name = Path(filename).name
    ext = Path(clean_name).suffix.lower()
    if not ext or ext not in allowed_extensions:
        allowed_str = ", ".join(sorted(allowed_extensions))
        raise StorageValidationError(
            f"Extensión '{ext or '(sin extensión)'}' no permitida. Extensiones válidas: {allowed_str}"
        )
    return ext


def validate_declared_mime(content_type: str | None, settings: Settings) -> None:
    if not content_type:
        return
    normalized = content_type.split(";")[0].strip().lower()
    if normalized.startswith("video/") or normalized in settings.ALLOWED_MIME_TYPES:
        return
    raise StorageValidationError(
        f"Tipo MIME declarado no permitido: '{normalized}'."
    )


def resolve_data_path(settings: Settings, relative_path: str) -> Path:
    """Resuelve un path relativo a DATA_DIR garantizando que no escape del directorio raíz."""
    base_dir = settings.DATA_DIR.resolve()
    candidate = (base_dir / relative_path).resolve()
    try:
        candidate.relative_to(base_dir)
    except ValueError as exc:
        raise ValueError(f"Intento de path traversal detectado: {relative_path!r}") from exc
    return candidate


async def delete_file_safe(path: Path | None) -> None:
    """Elimina un archivo en disco de forma no bloqueante e idempotente."""
    if path is None:
        return
    try:
        await asyncio.to_thread(path.unlink, True)
    except OSError as exc:
        logger.warning("No se pudo eliminar el archivo %s: %s", path, exc)


async def save_upload_streaming(
    upload_file: UploadFile,
    settings: Settings,
) -> SavedUpload:
    """Guarda un UploadFile en disco por chunks de 1 MiB con aiofiles sin cargarlo en memoria."""
    ext = extract_safe_extension(upload_file.filename, settings.ALLOWED_EXTENSIONS)
    validate_declared_mime(upload_file.content_type, settings)

    settings.ensure_directories()
    file_uuid = uuid4().hex
    stored_filename = f"{file_uuid}{ext}"
    relative_path = f"videos/original/{stored_filename}"
    abs_path = resolve_data_path(settings, relative_path)

    total_bytes = 0
    chunk_size = settings.UPLOAD_CHUNK_SIZE
    max_bytes = settings.MAX_UPLOAD_BYTES

    try:
        async with aiofiles.open(abs_path, mode="wb") as out_file:
            while True:
                chunk = await upload_file.read(chunk_size)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise UploadTooLargeError(
                        f"El archivo supera el límite máximo permitido de {max_bytes} bytes."
                    )
                await out_file.write(chunk)
    except Exception:
        await delete_file_safe(abs_path)
        raise

    if total_bytes == 0:
        await delete_file_safe(abs_path)
        raise StorageValidationError("El archivo subido está vacío.")

    clean_original_name = Path(upload_file.filename or stored_filename).name
    return SavedUpload(
        file_uuid=file_uuid,
        original_filename=clean_original_name,
        extension=ext,
        relative_path=relative_path,
        absolute_path=abs_path,
        size_bytes=total_bytes,
    )
