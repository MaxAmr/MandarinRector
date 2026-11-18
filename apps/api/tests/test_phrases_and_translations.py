import io
import json
from pathlib import Path
import zipfile

import httpx

from app.config import Settings
from tests.test_dictionary import MINI_CEDICT

SRT_ZH = """1
00:00:00,600 --> 00:00:01,700
你好银行

2
00:00:01,800 --> 00:00:02,700
绿女学生
"""

SRT_ES = """1
00:00:00,550 --> 00:00:01,750
Hola banco

2
00:00:01,850 --> 00:00:02,750
Estudiante
"""


async def test_phase5_track_pairing_and_cached_translation(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    # Cargar mini-CEDICT para glosa offline
    cedict_path = test_settings.resolved_cedict_path
    cedict_path.parent.mkdir(parents=True, exist_ok=True)
    cedict_path.write_text(MINI_CEDICT.replace("nv3", "nu:3"), encoding="utf-8")
    await async_client.post("/api/dictionary/import")

    # 1. Traducción bajo demanda con caché en SQLite
    t1 = await async_client.post(
        "/api/translate",
        json={"text": "你好银行", "target_lang": "es"},
    )
    assert t1.status_code == 200
    body1 = t1.json()
    assert body1["cached"] is False
    assert "hello" in body1["translated_text"]
    assert "bank" in body1["translated_text"]

    t2 = await async_client.post(
        "/api/translate",
        json={"text": "你好银行", "target_lang": "es"},
    )
    assert t2.status_code == 200
    assert t2.json()["cached"] is True
    assert t2.json()["translated_text"] == body1["translated_text"]

    # 2. Emparejado persistido entre pista primaria (zh) y secundaria (es)
    with sample_mp4_path.open("rb") as fh:
        v_resp = await async_client.post(
            "/api/videos",
            files={"file": ("lesson.mp4", fh, "video/mp4")},
        )
    video_id = v_resp.json()["id"]

    zh_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("zh.srt", SRT_ZH.encode("utf-8"), "application/x-subrip")},
        data={"lang": "zh"},
    )
    zh_track_id = zh_resp.json()["id"]

    es_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("es.srt", SRT_ES.encode("utf-8"), "application/x-subrip")},
        data={"lang": "es"},
    )
    assert es_resp.status_code == 201

    cues_resp = await async_client.get(f"/api/subtitles/{zh_track_id}/cues")
    assert cues_resp.status_code == 200
    cues = cues_resp.json()["cues"]
    assert cues[0]["translation_text"] == "Hola banco"
    assert cues[1]["translation_text"] == "Estudiante"


async def test_phase6_create_phrase_cut_clips_stream_and_delete(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    with sample_mp4_path.open("rb") as fh:
        v_resp = await async_client.post(
            "/api/videos",
            files={"file": ("clip_source.mp4", fh, "video/mp4")},
        )
    video_id = v_resp.json()["id"]

    zh_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("zh.srt", SRT_ZH.encode("utf-8"), "application/x-subrip")},
        data={"lang": "zh"},
    )
    zh_track_id = zh_resp.json()["id"]

    await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("es.srt", SRT_ES.encode("utf-8"), "application/x-subrip")},
        data={"lang": "es"},
    )

    # Ajustar offset de la pista primaria (+100 ms) para verificar que se aplica al cortar el clip
    await async_client.patch(
        f"/api/subtitles/{zh_track_id}",
        json={"offset_ms": 100},
    )

    # Guardar frase desde cue_idx=0 con margen pad_ms=300
    # Cue 0: [600, 1700] + offset 100 = [700, 1800] -> con pad 300 = [400, 2100]
    create_resp = await async_client.post(
        "/api/phrases",
        json={
            "video_id": video_id,
            "track_id": zh_track_id,
            "cue_idx": 0,
            "focus_word": "银行",
            "notes": "Vocabulario financiero",
            "pad_ms": 300,
        },
    )
    assert create_resp.status_code == 201
    created = create_resp.json()
    phrase_id = created["id"]
    assert created["hanzi"] == "你好银行"
    assert created["focus_word"] == "银行"
    assert created["pinyin"] == "nǐ hǎo yín háng"
    assert created["translation"] == "Hola banco"
    assert created["start_ms"] == 400
    assert created["end_ms"] == 2100

    # Verificar que el BackgroundTask generó el clip MP4, el MP3 y la miniatura JPEG
    detail_resp = await async_client.get(f"/api/phrases/{phrase_id}")
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["clip_status"] == "ready"
    assert detail["clip_video_url"] == f"/api/phrases/{phrase_id}/video"
    assert detail["clip_audio_url"] == f"/api/phrases/{phrase_id}/audio"
    assert detail["clip_thumb_url"] == f"/api/phrases/{phrase_id}/thumbnail"

    # Verificar streaming HTTP Range del clip de video (206 Partial Content)
    vid_range = await async_client.get(
        detail["clip_video_url"],
        headers={"Range": "bytes=0-99"},
    )
    assert vid_range.status_code == 206
    assert len(vid_range.content) == 100

    # Verificar descarga del clip de audio MP3 y miniatura JPEG
    aud_resp = await async_client.get(detail["clip_audio_url"])
    assert aud_resp.status_code == 200
    assert aud_resp.headers["content-type"] == "audio/mpeg"
    assert len(aud_resp.content) > 100

    thumb_resp = await async_client.get(detail["clip_thumb_url"])
    assert thumb_resp.status_code == 200
    assert thumb_resp.headers["content-type"] == "image/jpeg"
    assert len(thumb_resp.content) > 100

    # Verificar que los 3 archivos existen en data/clips/
    clip_files = list(test_settings.clips_dir.iterdir())
    assert len(clip_files) == 3

    # Fase 7: Exportar mazo Anki (.apkg) con genanki e inspeccionar contenido del paquete ZIP
    export_resp = await async_client.post(
        "/api/export/anki",
        json={
            "video_id": video_id,
            "deck_name": "Mandarín - Test",
            "include_video": True,
            "card_types": ["listening", "reading", "production"],
        },
    )
    assert export_resp.status_code == 200
    assert (
        export_resp.headers["content-disposition"]
        == 'attachment; filename="mandarin_clips.apkg"'
    )
    with zipfile.ZipFile(io.BytesIO(export_resp.content), "r") as zf:
        names = set(zf.namelist())
        assert "media" in names
        assert any(name.startswith("collection.anki2") for name in names)
        media_map = json.loads(zf.read("media").decode("utf-8"))
        media_values = list(media_map.values())
        assert any(v.endswith(".mp3") for v in media_values)
        assert any(v.endswith(".jpg") for v in media_values)
        assert any(v.endswith(".mp4") for v in media_values)

    # PATCH de tiempos re-corta el clip y limpia los anteriores
    patch_resp = await async_client.patch(
        f"/api/phrases/{phrase_id}",
        json={"start_ms": 500, "end_ms": 2000, "notes": "Recortado"},
    )
    assert patch_resp.status_code == 200
    after_patch = (await async_client.get(f"/api/phrases/{phrase_id}")).json()
    assert after_patch["clip_status"] == "ready"
    assert after_patch["start_ms"] == 500
    assert after_patch["end_ms"] == 2000
    assert len(list(test_settings.clips_dir.iterdir())) == 3

    # DELETE elimina registro y borra los archivos de data/clips/
    del_resp = await async_client.delete(f"/api/phrases/{phrase_id}")
    assert del_resp.status_code == 204
    assert list(test_settings.clips_dir.iterdir()) == []
