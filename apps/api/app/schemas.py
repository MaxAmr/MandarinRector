from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.models import Phrase, SubtitleTrack, Video, VideoStatus


class SubtitleTrackRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    lang: str
    label: str
    is_primary: bool
    source_format: str
    original_filename: str
    detected_encoding: str | None
    cue_count: int
    offset_ms: int
    created_at: datetime
    script: str | None = None
    tokens_status: str = "not_applicable"
    tokens_version: int | None = None
    tokens_error: str | None = None


class SubtitleUploadResponse(SubtitleTrackRead):
    warnings: list[str] = Field(default_factory=list)
    skipped: int = 0
    lang_detected: bool = False


class SubtitleTrackUpdate(BaseModel):
    label: str | None = None
    lang: str | None = None
    is_primary: bool | None = None
    offset_ms: int | None = None


class CueRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    idx: int
    start_ms: int
    end_ms: int
    text: str
    tokens: dict[str, Any] | None = None
    translation_text: str | None = None


class TrackCuesResponse(BaseModel):
    track_id: int
    cues: list[CueRead]


class VideoListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    duration: float | None
    width: int | None
    height: int | None
    status: VideoStatus
    error_message: str | None = None
    thumbnail_url: str | None
    subtitle_count: int = 0
    created_at: datetime

    @classmethod
    def from_video(cls, video: Video, subtitle_count: int = 0) -> "VideoListItem":
        assert video.id is not None
        thumbnail_url = (
            f"/api/videos/{video.id}/thumbnail" if video.thumbnail_path else None
        )
        return cls(
            id=video.id,
            title=video.title,
            duration=video.duration,
            width=video.width,
            height=video.height,
            status=video.status,
            error_message=video.error_message,
            thumbnail_url=thumbnail_url,
            subtitle_count=subtitle_count,
            created_at=video.created_at,
        )


class VideoRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    original_filename: str
    original_path: str
    playback_path: str | None
    thumbnail_path: str | None
    duration: float | None
    width: int | None
    height: int | None
    video_codec: str | None
    audio_codec: str | None
    container: str | None
    size_bytes: int
    status: VideoStatus
    error_message: str | None
    created_at: datetime
    stream_url: str
    thumbnail_url: str | None
    subtitle_tracks: list[SubtitleTrackRead] = Field(default_factory=list)

    @classmethod
    def from_video(
        cls,
        video: Video,
        tracks: list[SubtitleTrack] | None = None,
    ) -> "VideoRead":
        assert video.id is not None
        raw_tracks = tracks if tracks is not None else list(video.subtitle_tracks or [])
        sorted_tracks = sorted(
            raw_tracks,
            key=lambda t: (not t.is_primary, t.created_at, t.id or 0),
        )
        return cls(
            id=video.id,
            title=video.title,
            original_filename=video.original_filename,
            original_path=video.original_path,
            playback_path=video.playback_path,
            thumbnail_path=video.thumbnail_path,
            duration=video.duration,
            width=video.width,
            height=video.height,
            video_codec=video.video_codec,
            audio_codec=video.audio_codec,
            container=video.container,
            size_bytes=video.size_bytes,
            status=video.status,
            error_message=video.error_message,
            created_at=video.created_at,
            stream_url=f"/api/videos/{video.id}/stream",
            thumbnail_url=(
                f"/api/videos/{video.id}/thumbnail" if video.thumbnail_path else None
            ),
            subtitle_tracks=[
                SubtitleTrackRead.model_validate(track) for track in sorted_tracks
            ],
        )


class VideoUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=300)


class VideoFromUrlCreate(BaseModel):
    url: str = Field(min_length=8, max_length=2000)
    title: str | None = Field(default=None, max_length=300)
    auto_subtitles: bool = True
    max_height: int = Field(default=1080, ge=240, le=2160)


class DictionaryEntryRead(BaseModel):
    id: int
    traditional: str
    simplified: str
    pinyin_numeric: str
    pinyin_marks: str
    definitions: list[str]
    classifiers: list[str] = Field(default_factory=list)


class CharBreakdownItem(BaseModel):
    char: str
    entries: list[DictionaryEntryRead]


class DictionaryLookupResponse(BaseModel):
    query: str
    normalized_simplified: str
    dictionary_loaded: bool
    entries: list[DictionaryEntryRead] = Field(default_factory=list)
    char_entries: list[CharBreakdownItem] = Field(default_factory=list)


class DictionaryStatusResponse(BaseModel):
    loaded: bool
    entry_count: int
    cedict_file_exists: bool
    cedict_path: str


class SubtitlePairResponse(BaseModel):
    video_id: int
    matched_cues: int


class TranslateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    target_lang: str = Field(default="es", max_length=16)


class TranslateResponse(BaseModel):
    source_text: str
    target_lang: str
    translated_text: str
    provider: str
    cached: bool


class PhraseCreate(BaseModel):
    video_id: int
    track_id: int | None = None
    cue_idx: int | None = None
    hanzi: str | None = None
    focus_word: str | None = None
    pinyin: str | None = None
    translation: str | None = None
    notes: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    pad_ms: int = Field(default=300, ge=0, le=5000)
    apply_track_offset: bool = True


class PhraseUpdate(BaseModel):
    hanzi: str | None = None
    focus_word: str | None = None
    pinyin: str | None = None
    translation: str | None = None
    notes: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None


class PhraseRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    video_id: int
    track_id: int | None
    cue_idx: int | None
    hanzi: str
    focus_word: str | None
    pinyin: str
    translation: str
    notes: str | None
    start_ms: int
    end_ms: int
    clip_status: str
    clip_error: str | None
    clip_video_url: str | None
    clip_audio_url: str | None
    clip_thumb_url: str | None
    created_at: datetime

    @classmethod
    def from_phrase(cls, phrase: Phrase) -> "PhraseRead":
        assert phrase.id is not None
        ready = phrase.clip_status == "ready"
        return cls(
            id=phrase.id,
            video_id=phrase.video_id,
            track_id=phrase.track_id,
            cue_idx=phrase.cue_idx,
            hanzi=phrase.hanzi,
            focus_word=phrase.focus_word,
            pinyin=phrase.pinyin,
            translation=phrase.translation,
            notes=phrase.notes,
            start_ms=phrase.start_ms,
            end_ms=phrase.end_ms,
            clip_status=phrase.clip_status,
            clip_error=phrase.clip_error,
            clip_video_url=(
                f"/api/phrases/{phrase.id}/video"
                if ready and phrase.clip_video_path
                else None
            ),
            clip_audio_url=(
                f"/api/phrases/{phrase.id}/audio"
                if ready and phrase.clip_audio_path
                else None
            ),
            clip_thumb_url=(
                f"/api/phrases/{phrase.id}/thumbnail"
                if ready and phrase.clip_thumb_path
                else None
            ),
            created_at=phrase.created_at,
        )


class AnkiExportRequest(BaseModel):
    video_id: int | None = None
    phrase_ids: list[int] | None = None
    deck_name: str = Field(default="Mandarín - Clips", max_length=120)
    include_video: bool = False
    card_types: list[str] = Field(
        default_factory=lambda: ["listening", "reading"]
    )
    anki_connect_url: str = Field(default="http://127.0.0.1:8765")


class AnkiConnectExportResponse(BaseModel):
    deck_name: str
    added: int
    skipped: int

