from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import BeforeValidator, Field
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = Path("data")


def _parse_cors_origins(value: object) -> list[str]:
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        if stripped.startswith("[") and stripped.endswith("]"):
            import json

            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return [str(origin).strip() for origin in parsed if str(origin).strip()]
        return [origin.strip() for origin in stripped.split(",") if origin.strip()]
    if isinstance(value, list):
        return [str(origin).strip() for origin in value if str(origin).strip()]
    raise ValueError(f"Formato inválido para CORS_ORIGINS: {value!r}")


CorsOriginsList = Annotated[list[str], NoDecode, BeforeValidator(_parse_cors_origins)]


class Settings(BaseSettings):
    """Configuración central de la aplicación cargada desde entorno o archivo .env."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    DATA_DIR: Path = Field(default=DEFAULT_DATA_DIR)
    MAX_UPLOAD_BYTES: int = Field(default=8 * 1024 * 1024 * 1024)  # 8 GiB
    MAX_SUBTITLE_BYTES: int = Field(default=5 * 1024 * 1024)  # 5 MiB
    MAX_CUES: int = Field(default=20_000)
    MAX_OFFSET_MS: int = Field(default=600_000)
    CORS_ORIGINS: CorsOriginsList = Field(
        default=["http://localhost:5173", "http://127.0.0.1:5173"]
    )

    # Fase 3: Segmentación jieba y pypinyin
    USERDICT_PATH: Path | None = Field(default=None)
    PINYIN_OVERRIDES_PATH: Path | None = Field(default=None)
    PINYIN_TONE_SANDHI: bool = Field(default=False)

    # Fase 4: Diccionario CC-CEDICT
    CEDICT_PATH: Path | None = Field(default=None)
    CEDICT_DOWNLOAD_URL: str = Field(
        default="https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz"
    )

    # Fase 5 y 6: Traducción automática opcional y margen por defecto de clips
    TRANSLATION_API_URL: str | None = Field(default=None)
    TRANSLATION_API_KEY: str | None = Field(default=None)
    DEFAULT_CLIP_PAD_MS: int = Field(default=300)

    UPLOAD_CHUNK_SIZE: int = Field(default=1024 * 1024)  # 1 MiB
    STREAM_CHUNK_SIZE: int = Field(default=256 * 1024)  # 256 KiB

    ALLOWED_EXTENSIONS: frozenset[str] = frozenset(
        {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"}
    )
    ALLOWED_MIME_TYPES: frozenset[str] = frozenset(
        {
            "video/mp4",
            "video/x-matroska",
            "video/webm",
            "video/quicktime",
            "video/x-msvideo",
            "video/avi",
            "video/msvideo",
            "video/x-m4v",
            "application/x-matroska",
            "application/octet-stream",
        }
    )
    ALLOWED_SUBTITLE_EXTENSIONS: frozenset[str] = frozenset(
        {".srt", ".ass", ".ssa", ".vtt"}
    )
    SUPPORTED_SUBTITLE_LANGS: frozenset[str] = frozenset(
        {"zh", "es", "en", "ja", "ko", "und"}
    )

    @property
    def original_dir(self) -> Path:
        return self.DATA_DIR / "videos" / "original"

    @property
    def playback_dir(self) -> Path:
        return self.DATA_DIR / "videos" / "playback"

    @property
    def thumbs_dir(self) -> Path:
        return self.DATA_DIR / "thumbs"

    @property
    def clips_dir(self) -> Path:
        """Reservado para la fase futura de corte de clips."""
        return self.DATA_DIR / "clips"

    @property
    def db_path(self) -> Path:
        return self.DATA_DIR / "app.db"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{self.db_path.resolve()}"

    @property
    def resolved_userdict_path(self) -> Path:
        if self.USERDICT_PATH is not None:
            return self.USERDICT_PATH
        return self.DATA_DIR / "userdict.txt"

    @property
    def resolved_pinyin_overrides_path(self) -> Path:
        if self.PINYIN_OVERRIDES_PATH is not None:
            return self.PINYIN_OVERRIDES_PATH
        return self.DATA_DIR / "pinyin_overrides.txt"

    @property
    def resolved_cedict_path(self) -> Path:
        if self.CEDICT_PATH is not None:
            return self.CEDICT_PATH
        return self.DATA_DIR / "cedict_ts.u8"

    def ensure_directories(self) -> None:
        """Crea la estructura de directorios de datos requerida si no existe."""
        for directory in (
            self.DATA_DIR,
            self.original_dir,
            self.playback_dir,
            self.thumbs_dir,
            self.clips_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    return Settings()
