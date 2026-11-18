from collections.abc import AsyncIterator
from pathlib import Path
import subprocess

import httpx
import pytest
import pytest_asyncio

from app.config import Settings
from app.main import create_app
from app.services.chinese import init_segmenter


@pytest.fixture(scope="session", autouse=True)
def warmup_chinese_segmenter() -> None:
    """Inicializa jieba y pypinyin una sola vez por sesión de tests."""
    init_segmenter()


@pytest.fixture(scope="session")
def synthetic_media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    media_dir = tmp_path_factory.mktemp("synthetic_media")

    mp4_path = media_dir / "sample_h264_aac.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3:size=320x240:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            str(mp4_path),
        ],
        check=True,
    )

    mkv_ac3_path = media_dir / "sample_h264_ac3.mkv"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=3:size=320x240:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:duration=3",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "ac3",
            "-b:a",
            "192k",
            "-shortest",
            str(mkv_ac3_path),
        ],
        check=True,
    )

    return media_dir


@pytest.fixture(scope="session")
def sample_mp4_path(synthetic_media_dir: Path) -> Path:
    return synthetic_media_dir / "sample_h264_aac.mp4"


@pytest.fixture(scope="session")
def sample_mkv_ac3_path(synthetic_media_dir: Path) -> Path:
    return synthetic_media_dir / "sample_h264_ac3.mkv"


@pytest.fixture
def test_settings(tmp_path: Path) -> Settings:
    return Settings(
        DATA_DIR=tmp_path / "data",
        MAX_UPLOAD_BYTES=50 * 1024 * 1024,
        MAX_SUBTITLE_BYTES=5 * 1024 * 1024,
        CORS_ORIGINS=["http://localhost:5173"],
    )


@pytest_asyncio.fixture
async def async_client(test_settings: Settings) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(test_settings)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://testserver",
        ) as client:
            yield client
