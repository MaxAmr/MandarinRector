from pathlib import Path
import shutil

import httpx
import pytest
from sqlmodel import Session

from app.config import Settings
from app.main import create_app
from app.models import Video, VideoStatus
from app.services.ytdlp_ingest import DownloadedSubFile, YtdlpDownloadResult


async def test_health_check(async_client: httpx.AsyncClient) -> None:
    resp = await async_client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok", "ffmpeg": True}


async def test_upload_valid_mp4_and_metadata(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    with sample_mp4_path.open("rb") as fh:
        resp = await async_client.post(
            "/api/videos",
            files={"file": ("clase_mandarin.mp4", fh, "video/mp4")},
            data={"title": "Clase 1 - Saludos"},
        )

    assert resp.status_code == 201
    created = resp.json()
    video_id = created["id"]
    assert created["title"] == "Clase 1 - Saludos"
    assert created["original_filename"] == "clase_mandarin.mp4"
    assert created["width"] == 320
    assert created["height"] == 240
    assert created["video_codec"] == "h264"
    assert created["audio_codec"] == "aac"
    assert created["container"] == "mp4"
    assert created["duration"] is not None and 2.5 <= created["duration"] <= 3.5

    # En ASGI transport las BackgroundTasks se ejecutan antes de retornar la respuesta
    detail_resp = await async_client.get(f"/api/videos/{video_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["status"] == "ready"
    assert detail["playback_path"] == detail["original_path"]
    assert detail["thumbnail_path"] is not None

    thumb_resp = await async_client.get(f"/api/videos/{video_id}/thumbnail")
    assert thumb_resp.status_code == 200
    assert thumb_resp.headers["content-type"] == "image/jpeg"
    assert "max-age=" in thumb_resp.headers.get("cache-control", "")
    assert len(thumb_resp.content) > 100

    assert (test_settings.DATA_DIR / detail["original_path"]).is_file()
    assert (test_settings.DATA_DIR / detail["thumbnail_path"]).is_file()


async def test_upload_invalid_non_video_with_mp4_extension_returns_422(
    async_client: httpx.AsyncClient,
    test_settings: Settings,
) -> None:
    fake_payload = b"Este archivo no es un video valido sino texto plano." * 20
    resp = await async_client.post(
        "/api/videos",
        files={"file": ("falso_video.mp4", fake_payload, "video/mp4")},
    )
    assert resp.status_code == 422
    assert list(test_settings.original_dir.iterdir()) == []


async def test_upload_mkv_ac3_generates_distinct_compatible_playback(
    async_client: httpx.AsyncClient,
    sample_mkv_ac3_path: Path,
    test_settings: Settings,
) -> None:
    with sample_mkv_ac3_path.open("rb") as fh:
        resp = await async_client.post(
            "/api/videos",
            files={"file": ("pelicula_ac3.mkv", fh, "video/x-matroska")},
        )

    assert resp.status_code == 201
    video_id = resp.json()["id"]

    detail_resp = await async_client.get(f"/api/videos/{video_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["status"] == "ready"
    assert detail["original_path"].endswith(".mkv")
    assert detail["playback_path"] != detail["original_path"]
    assert detail["playback_path"].startswith("videos/playback/")
    assert detail["playback_path"].endswith(".mp4")

    original_abs = test_settings.DATA_DIR / detail["original_path"]
    playback_abs = test_settings.DATA_DIR / detail["playback_path"]
    assert original_abs.is_file()
    assert playback_abs.is_file()


async def test_streaming_http_range_scenarios(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    with sample_mp4_path.open("rb") as fh:
        upload_resp = await async_client.post(
            "/api/videos",
            files={"file": ("stream_test.mp4", fh, "video/mp4")},
        )
    assert upload_resp.status_code == 201
    video_id = upload_resp.json()["id"]

    detail = (await async_client.get(f"/api/videos/{video_id}")).json()
    playback_abs = test_settings.DATA_DIR / detail["playback_path"]
    expected_bytes = playback_abs.read_bytes()
    total_size = len(expected_bytes)
    assert total_size > 200

    stream_url = f"/api/videos/{video_id}/stream"

    # 1. Sin Range → 200 completo
    r_full = await async_client.get(stream_url)
    assert r_full.status_code == 200
    assert r_full.headers["accept-ranges"] == "bytes"
    assert int(r_full.headers["content-length"]) == total_size
    assert r_full.content == expected_bytes

    # 2. Range: bytes=0-99 → 206 + 100 bytes
    r_0_99 = await async_client.get(stream_url, headers={"Range": "bytes=0-99"})
    assert r_0_99.status_code == 206
    assert r_0_99.headers["accept-ranges"] == "bytes"
    assert r_0_99.headers["content-range"] == f"bytes 0-99/{total_size}"
    assert int(r_0_99.headers["content-length"]) == 100
    assert r_0_99.content == expected_bytes[:100]

    # 3. Range: bytes=100- → 206 hasta el final
    r_100_end = await async_client.get(stream_url, headers={"Range": "bytes=100-"})
    assert r_100_end.status_code == 206
    assert (
        r_100_end.headers["content-range"]
        == f"bytes 100-{total_size - 1}/{total_size}"
    )
    assert int(r_100_end.headers["content-length"]) == total_size - 100
    assert r_100_end.content == expected_bytes[100:]

    # 4. Range: bytes=-50 (suffix) → 206 con últimos 50 bytes
    r_suffix = await async_client.get(stream_url, headers={"Range": "bytes=-50"})
    assert r_suffix.status_code == 206
    assert (
        r_suffix.headers["content-range"]
        == f"bytes {total_size - 50}-{total_size - 1}/{total_size}"
    )
    assert int(r_suffix.headers["content-length"]) == 50
    assert r_suffix.content == expected_bytes[-50:]

    # 5. Range fuera de límite: bytes=9999999- → 416
    r_oob = await async_client.get(stream_url, headers={"Range": "bytes=9999999-"})
    assert r_oob.status_code == 416
    assert r_oob.headers["content-range"] == f"bytes */{total_size}"

    # 6. Header Range malformado → 416 (decisión documentada en services/streaming.py)
    r_malformed = await async_client.get(
        stream_url, headers={"Range": "bytes=abc-def"}
    )
    assert r_malformed.status_code == 416
    assert r_malformed.headers["content-range"] == f"bytes */{total_size}"

    # 7. Rango múltiple → 200 completo (decisión documentada en services/streaming.py)
    r_multi = await async_client.get(
        stream_url, headers={"Range": "bytes=0-1,5-9"}
    )
    assert r_multi.status_code == 200
    assert r_multi.content == expected_bytes

    # 8. HEAD con y sin Range
    r_head = await async_client.head(stream_url, headers={"Range": "bytes=0-99"})
    assert r_head.status_code == 206
    assert r_head.headers["content-range"] == f"bytes 0-99/{total_size}"
    assert r_head.headers["content-length"] == "100"
    assert r_head.content == b""


async def test_delete_video_removes_files_from_disk(
    async_client: httpx.AsyncClient,
    sample_mkv_ac3_path: Path,
    test_settings: Settings,
) -> None:
    with sample_mkv_ac3_path.open("rb") as fh:
        upload_resp = await async_client.post(
            "/api/videos",
            files={"file": ("para_borrar.mkv", fh, "video/x-matroska")},
        )
    video_id = upload_resp.json()["id"]
    detail = (await async_client.get(f"/api/videos/{video_id}")).json()

    orig_file = test_settings.DATA_DIR / detail["original_path"]
    play_file = test_settings.DATA_DIR / detail["playback_path"]
    thumb_file = test_settings.DATA_DIR / detail["thumbnail_path"]
    assert orig_file.exists()
    assert play_file.exists()
    assert thumb_file.exists()

    del_resp = await async_client.delete(f"/api/videos/{video_id}")
    assert del_resp.status_code == 204

    assert not orig_file.exists()
    assert not play_file.exists()
    assert not thumb_file.exists()

    get_after = await async_client.get(f"/api/videos/{video_id}")
    assert get_after.status_code == 404


async def test_startup_marks_stuck_processing_videos_as_error(
    test_settings: Settings,
) -> None:
    app1 = create_app(test_settings)
    async with app1.router.lifespan_context(app1):
        with Session(app1.state.engine) as session:
            stuck = Video(
                title="Colgado",
                original_filename="colgado.mp4",
                original_path="videos/original/colgado.mp4",
                size_bytes=1024,
                status=VideoStatus.PROCESSING,
            )
            session.add(stuck)
            session.commit()
            session.refresh(stuck)
            stuck_id = stuck.id

    # Nuevo inicio de aplicación sobre la misma base de datos
    app2 = create_app(test_settings)
    async with app2.router.lifespan_context(app2):
        with Session(app2.state.engine) as session:
            recovered = session.get(Video, stuck_id)
            assert recovered is not None
            assert recovered.status == VideoStatus.ERROR
            assert recovered.error_message is not None
            assert "interrumpido" in recovered.error_message.lower()


async def test_ingest_video_from_url_pipeline_and_validation(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1. URL inválida o hacia localhost -> 422
    bad_scheme = await async_client.post(
        "/api/videos/from-url",
        json={"url": "file:///etc/passwd"},
    )
    assert bad_scheme.status_code == 422

    bad_host = await async_client.post(
        "/api/videos/from-url",
        json={"url": "http://localhost:8000/api/health"},
    )
    assert bad_host.status_code == 422

    # 2. Simular descarga de yt-dlp con video + subtítulos zh y es
    def fake_ytdlp_download(
        url: str,
        file_uuid: str,
        auto_subtitles: bool,
        max_height: int,
        settings: Settings,
    ) -> YtdlpDownloadResult:
        _ = (auto_subtitles, max_height)
        dest_video = settings.original_dir / f"{file_uuid}.mp4"
        shutil.copyfile(sample_mp4_path, dest_video)

        zh_sub = settings.DATA_DIR / f"_tmp_sub_{file_uuid}_zh.srt"
        zh_sub.write_text(
            "1\n00:00:00,500 --> 00:00:01,800\n你好银行\n",
            encoding="utf-8",
        )
        es_sub = settings.DATA_DIR / f"_tmp_sub_{file_uuid}_es.srt"
        es_sub.write_text(
            "1\n00:00:00,500 --> 00:00:01,800\nHola banco\n",
            encoding="utf-8",
        )

        return YtdlpDownloadResult(
            video_path=dest_video,
            title="Clase desde YouTube",
            webpage_url=url,
            subtitles=[
                DownloadedSubFile(
                    path=zh_sub,
                    lang_tag="zh-Hans",
                    resolved_lang="zh",
                    label="Chino Simplificado (zh-Hans)",
                    priority=0,
                ),
                DownloadedSubFile(
                    path=es_sub,
                    lang_tag="es",
                    resolved_lang="es",
                    label="Español (es)",
                    priority=10,
                ),
            ],
        )

    monkeypatch.setattr(
        "app.services.ytdlp_ingest._run_ytdlp_download_sync",
        fake_ytdlp_download,
    )

    resp = await async_client.post(
        "/api/videos/from-url",
        json={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "auto_subtitles": True,
            "max_height": 720,
        },
    )
    assert resp.status_code == 201
    video_id = resp.json()["id"]

    detail = (await async_client.get(f"/api/videos/{video_id}")).json()
    assert detail["status"] == "ready"
    assert detail["title"] == "Clase desde YouTube"
    assert len(detail["subtitle_tracks"]) == 2

    primary_track = next(
        t for t in detail["subtitle_tracks"] if t["is_primary"]
    )
    assert primary_track["lang"] == "zh"
    assert primary_track["tokens_status"] == "ready"

    cues_resp = await async_client.get(
        f"/api/subtitles/{primary_track['id']}/cues"
    )
    cue0 = cues_resp.json()["cues"][0]
    assert cue0["text"] == "你好银行"
    assert cue0["translation_text"] == "Hola banco"
    assert cue0["tokens"] is not None
