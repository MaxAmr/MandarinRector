"""Servicio de streaming de video con soporte explícito de HTTP Range (RFC 9110).

Decisiones de diseño sobre el header Range:
1. Rangos múltiples (p. ej. `Range: bytes=0-1,5-9`): se ignoran y se responde `200 OK`
   con el archivo completo en streaming (comportamiento permitido por RFC 9110 §14.2 cuando
   no se implementa `multipart/byteranges`).
2. Headers `Range` malformados (unidad distinta de `bytes=`, sintaxis ilegible, sufijo `<= 0`,
   `start > end` o `start >= total`): se responde `416 Range Not Satisfiable` con el header
   `Content-Range: bytes */{total}`.
"""

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
import mimetypes
from pathlib import Path
import re

import aiofiles
from fastapi import Response
from fastapi.responses import StreamingResponse

SINGLE_RANGE_RE = re.compile(r"^\s*(\d*)\s*-\s*(\d*)\s*$")


class RangeNotSatisfiableError(ValueError):
    """Excepción lanzada cuando el header Range es inválido o fuera de límites (HTTP 416)."""

    def __init__(self, total_size: int, message: str = "Range Not Satisfiable") -> None:
        super().__init__(message)
        self.total_size = total_size


@dataclass(slots=True, frozen=True)
class ByteRange:
    start: int
    end: int
    total: int

    @property
    def content_length(self) -> int:
        return self.end - self.start + 1

    @property
    def content_range_header(self) -> str:
        return f"bytes {self.start}-{self.end}/{self.total}"


def guess_video_media_type(file_path: Path) -> str:
    guessed, _ = mimetypes.guess_type(str(file_path))
    if guessed and guessed.startswith("video/"):
        return guessed
    ext = file_path.suffix.lower()
    fallback_map = {
        ".mp4": "video/mp4",
        ".m4v": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
    }
    return fallback_map.get(ext, "video/mp4")


def parse_range_header(range_header: str | None, total_size: int) -> ByteRange | None:
    """Parsea el header HTTP Range.

    Retorna:
    - `None` si no hay header `Range` o si es un rango múltiple (se sirve 200 completo).
    - `ByteRange(start, end, total_size)` si es un rango simple válido (se sirve 206).
    Lanza `RangeNotSatisfiableError` si el rango es malformado o insatisfacible (416).
    """
    if range_header is None or not range_header.strip():
        return None

    if total_size <= 0:
        raise RangeNotSatisfiableError(total_size, "El archivo está vacío.")

    header = range_header.strip()
    if not header.lower().startswith("bytes="):
        raise RangeNotSatisfiableError(total_size, "Unidad de Range no soportada.")

    spec = header[6:].strip()
    if not spec:
        raise RangeNotSatisfiableError(total_size, "Especificación de Range vacía.")

    # Decisión documentada: ante rangos múltiples separados por coma, devolvemos None para responder 200 completo.
    if "," in spec:
        return None

    match = SINGLE_RANGE_RE.match(spec)
    if not match:
        raise RangeNotSatisfiableError(total_size, "Formato de Range malformado.")

    start_str, end_str = match.group(1), match.group(2)
    if not start_str and not end_str:
        raise RangeNotSatisfiableError(total_size, "Rango vacío.")

    if not start_str:
        # Rango sufijo: bytes=-N (últimos N bytes)
        suffix_length = int(end_str)
        if suffix_length <= 0:
            raise RangeNotSatisfiableError(
                total_size, "El sufijo de bytes debe ser mayor a 0."
            )
        if suffix_length >= total_size:
            start = 0
        else:
            start = total_size - suffix_length
        end = total_size - 1
        return ByteRange(start=start, end=end, total=total_size)

    start = int(start_str)
    if start >= total_size:
        raise RangeNotSatisfiableError(
            total_size, "El inicio del rango supera el tamaño del archivo."
        )

    if end_str:
        end = int(end_str)
        if end < start:
            raise RangeNotSatisfiableError(
                total_size, "El fin del rango es menor que el inicio."
            )
        end = min(end, total_size - 1)
    else:
        end = total_size - 1

    return ByteRange(start=start, end=end, total=total_size)


async def iter_file_range(
    file_path: Path,
    start: int,
    length: int,
    chunk_size: int = 256 * 1024,
) -> AsyncIterator[bytes]:
    """Generador asíncrono que hace seek a `start` y emite exactamente `length` bytes en bloques de 256 KiB."""
    remaining = length
    async with aiofiles.open(file_path, mode="rb") as file_obj:
        if start > 0:
            await file_obj.seek(start)
        while remaining > 0:
            read_size = min(chunk_size, remaining)
            chunk = await file_obj.read(read_size)
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


async def build_range_streaming_response(
    file_path: Path,
    range_header: str | None,
    method: str = "GET",
    chunk_size: int = 256 * 1024,
) -> Response:
    """Construye la respuesta HTTP (200, 206 o 416; GET o HEAD) para el streaming de video."""
    stat_result = await asyncio.to_thread(file_path.stat)
    total_size = stat_result.st_size
    media_type = guess_video_media_type(file_path)

    try:
        byte_range = parse_range_header(range_header, total_size)
    except RangeNotSatisfiableError as exc:
        return Response(
            status_code=416,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes */{exc.total_size}",
                "Content-Length": "0",
            },
            media_type=media_type,
        )

    is_head = method.upper() == "HEAD"

    if byte_range is None:
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(total_size),
        }
        if is_head:
            return Response(status_code=200, headers=headers, media_type=media_type)
        return StreamingResponse(
            iter_file_range(
                file_path=file_path,
                start=0,
                length=total_size,
                chunk_size=chunk_size,
            ),
            status_code=200,
            headers=headers,
            media_type=media_type,
        )

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Range": byte_range.content_range_header,
        "Content-Length": str(byte_range.content_length),
    }
    if is_head:
        return Response(status_code=206, headers=headers, media_type=media_type)

    return StreamingResponse(
        iter_file_range(
            file_path=file_path,
            start=byte_range.start,
            length=byte_range.content_length,
            chunk_size=chunk_size,
        ),
        status_code=206,
        headers=headers,
        media_type=media_type,
    )
