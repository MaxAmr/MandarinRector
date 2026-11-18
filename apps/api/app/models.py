"""Modelos SQLModel de persistencia para videos, pistas de subtítulos y cues.

NOTA DE ARQUITECTURA (MIGRACIONES):
A partir de la Fase 3 el esquema es gestionado exclusivamente con Alembic (`apps/api/alembic/`).
Cada inicio del servidor aplica `alembic upgrade head` de forma programática.
"""

from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import Column, ForeignKey, Index, Integer, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class VideoStatus(str, Enum):
    PROCESSING = "processing"
    READY = "ready"
    ERROR = "error"


class TokensStatus(str, Enum):
    NOT_APPLICABLE = "not_applicable"
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    ERROR = "error"


class ClipStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    READY = "ready"
    ERROR = "error"


class Video(SQLModel, table=True):
    __tablename__ = "video"

    id: int | None = Field(default=None, primary_key=True)
    title: str = Field(index=True)
    original_filename: str
    # Ruta relativa a DATA_DIR. Se conserva siempre intacta como fuente para ffmpeg al cortar clips en Fase 6.
    original_path: str
    playback_path: str | None = Field(default=None)
    thumbnail_path: str | None = Field(default=None)
    duration: float | None = Field(default=None)
    width: int | None = Field(default=None)
    height: int | None = Field(default=None)
    video_codec: str | None = Field(default=None)
    audio_codec: str | None = Field(default=None)
    container: str | None = Field(default=None)
    size_bytes: int
    status: VideoStatus = Field(default=VideoStatus.PROCESSING, index=True)
    error_message: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=utc_now, index=True)

    subtitle_tracks: list["SubtitleTrack"] = Relationship(
        back_populates="video",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "passive_deletes": True,
        },
    )


class SubtitleTrack(SQLModel, table=True):
    __tablename__ = "subtitletrack"

    id: int | None = Field(default=None, primary_key=True)
    video_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("video.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )
    # BCP-47 simplificado: "zh", "es", "en", "ja", "ko", "und"
    lang: str = Field(default="und")
    label: str
    is_primary: bool = Field(default=False)
    # Formato origen normalizado: "srt" | "ass" | "ssa" | "vtt"
    source_format: str
    original_filename: str
    detected_encoding: str | None = Field(default=None)
    cue_count: int = Field(default=0)
    # Desfase en milisegundos persistido; se aplica en cliente al renderizar y DEBE sumarse a
    # start_ms/end_ms al cortar clips con ffmpeg en la Fase 6.
    offset_ms: int = Field(default=0)
    created_at: datetime = Field(default_factory=utc_now)

    # Fase 3: Metadatos de segmentación jieba y pinyin por pista
    # script: "hans" | "hant" | "mixed" | None
    script: str | None = Field(default=None)
    # tokens_status: "not_applicable" | "pending" | "processing" | "ready" | "error"
    tokens_status: str = Field(
        default=TokensStatus.NOT_APPLICABLE.value,
        sa_column_kwargs={"server_default": "not_applicable"},
    )
    tokens_version: int | None = Field(default=None)
    tokens_error: str | None = Field(default=None)
    tokens_updated_at: datetime | None = Field(default=None)

    video: Video | None = Relationship(back_populates="subtitle_tracks")
    cues: list["Cue"] = Relationship(
        back_populates="track",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "passive_deletes": True,
        },
    )


class Cue(SQLModel, table=True):
    __tablename__ = "cue"
    __table_args__ = (
        Index("ix_cue_track_id_start_ms", "track_id", "start_ms"),
        UniqueConstraint("track_id", "idx", name="uq_cue_track_id_idx"),
    )

    id: int | None = Field(default=None, primary_key=True)
    track_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("subtitletrack.id", ondelete="CASCADE"),
            nullable=False,
        )
    )
    # Posición ordinal 0-based dentro de la pista tras ordenar por (start_ms, end_ms)
    idx: int
    # Tiempos enteros en milisegundos. Fase 6 reutilizará (start_ms + track.offset_ms, end_ms + track.offset_ms) para ffmpeg.
    start_ms: int
    end_ms: int
    text: str
    # Fase 3: JSON compacto con contrato versionado {"v":1,"t":[...]}
    tokens_json: str | None = Field(default=None)
    # Fase 5: Traducción emparejada persistida desde pista secundaria
    translation_text: str | None = Field(default=None)

    track: SubtitleTrack | None = Relationship(back_populates="cues")


class DictionaryEntry(SQLModel, table=True):
    """Entrada del diccionario CC-CEDICT indexada por simplificado y tradicional (Fase 4)."""

    __tablename__ = "dictionaryentry"

    id: int | None = Field(default=None, primary_key=True)
    traditional: str = Field(index=True)
    simplified: str = Field(index=True)
    pinyin_numeric: str
    pinyin_marks: str
    definitions_json: str
    classifiers_json: str | None = Field(default=None)
    # Menor valor = mayor prioridad (p. ej. entradas comunes en minúscula antes que apellidos propios)
    rank: int = Field(default=0, sa_column_kwargs={"server_default": "0"})


class TranslationCache(SQLModel, table=True):
    """Caché persistente de traducciones bajo demanda (Fase 5)."""

    __tablename__ = "translationcache"
    __table_args__ = (
        UniqueConstraint(
            "source_text",
            "target_lang",
            name="uq_translationcache_source_lang",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    source_text: str = Field(index=True)
    target_lang: str = Field(default="es")
    translated_text: str
    provider: str = Field(default="offline_cedict")
    created_at: datetime = Field(default_factory=utc_now)


class Phrase(SQLModel, table=True):
    """Frase guardada por el estudiante con su clip de video/audio cortado con ffmpeg (Fase 6)."""

    __tablename__ = "phrase"

    id: int | None = Field(default=None, primary_key=True)
    video_id: int = Field(
        sa_column=Column(
            Integer,
            ForeignKey("video.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )
    track_id: int | None = Field(
        default=None,
        sa_column=Column(
            Integer,
            ForeignKey("subtitletrack.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    cue_idx: int | None = Field(default=None)
    hanzi: str
    focus_word: str | None = Field(default=None)
    pinyin: str = Field(default="")
    translation: str = Field(default="")
    notes: str | None = Field(default=None)
    start_ms: int
    end_ms: int
    clip_status: str = Field(
        default=ClipStatus.PENDING.value,
        sa_column_kwargs={"server_default": "pending"},
    )
    clip_video_path: str | None = Field(default=None)
    clip_audio_path: str | None = Field(default=None)
    clip_thumb_path: str | None = Field(default=None)
    clip_error: str | None = Field(default=None)
    created_at: datetime = Field(default_factory=utc_now, index=True)
