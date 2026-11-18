import os
from pathlib import Path
import time

import httpx
import pytest
from sqlmodel import Session, select

from app.config import Settings
from app.models import Cue, SubtitleTrack
from app.services.subtitles import (
    SubtitleParseError,
    SubtitleTooLargeError,
    decode_subtitle_bytes,
    detect_language,
    parse_subtitles,
)

SRT_ZH_UTF8 = """1
00:00:00,500 --> 00:00:01,800
你好，欢迎来到中文学习课堂！

2
00:00:01,900 --> 00:00:02,900
今天我们一起练习听力。
"""

SRT_ZH_TRADITIONAL = """1
00:00:00,500 --> 00:00:01,800
你好，歡迎來到台灣電影字幕測試！

2
00:00:01,900 --> 00:00:02,900
請注意聽老師說的話，謝謝大家。
"""

ASS_SAMPLE = """[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:00.20,0:00:00.80,Default,,0,0,0,,Este comentario se debe descartar
Dialogue: 0,0:00:00.50,0:00:01.80,Default,,0,0,0,,{\\an8}{\\pos(192,220)}第一行\\N{\\fad(100,100)}第二行
Dialogue: 0,0:00:01.90,0:00:02.50,Default,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}
"""

VTT_SAMPLE = """WEBVTT

NOTE Comentario de bloque en WebVTT
con segunda línea que debe ignorarse

cue-1
00:00:00.400 --> 00:00:01.600 align:start position:10%
<v Hablante><c.yellow>你好</c> <i>世界</i> <00:00:00.900>朋友

cue-2
00:00:01.700 --> 00:00:02.800 line:85%
<b>第二句</b>测试
"""

SRT_MESSY = """1
00:00:02,000 --> 00:00:03,000
Tercer cue cronológico

2
00:00:01,500 --> 00:00:01,000
Cue con end < start (debe descartarse)

3
00:00:00,500 --> 00:00:01,800
Primer cue (se solapa con el segundo)

4
00:00:01,000 --> 00:00:02,200
Segundo cue solapado

5
00:00:02,500 --> 00:00:02,900
<i>   </i>
"""


def test_decode_subtitle_bytes_encodings() -> None:
    # 1. UTF-8 estándar
    text_utf8, enc_utf8 = decode_subtitle_bytes(SRT_ZH_UTF8.encode("utf-8"))
    assert enc_utf8 == "utf-8"
    assert "欢迎来到中文学习课堂" in text_utf8

    # 2. UTF-8 con BOM
    text_bom, enc_bom = decode_subtitle_bytes(SRT_ZH_UTF8.encode("utf-8-sig"))
    assert enc_bom == "utf-8-sig"
    assert not text_bom.startswith("\ufeff")
    assert "今天我们一起练习听力" in text_bom

    # 3. GBK / GB18030 con texto chino simplificado
    raw_gbk = SRT_ZH_UTF8.encode("gb18030")
    text_gbk, enc_gbk = decode_subtitle_bytes(raw_gbk)
    assert enc_gbk == "gb18030"
    assert "欢迎来到中文学习课堂" in text_gbk

    # 4. Big5 con caracteres tradicionales
    raw_big5 = SRT_ZH_TRADITIONAL.encode("big5")
    text_big5, enc_big5 = decode_subtitle_bytes(raw_big5)
    assert enc_big5 == "big5"
    assert "歡迎來到台灣電影字幕測試" in text_big5

    # 5. UTF-16 LE con BOM
    raw_utf16le = b"\xff\xfe" + SRT_ZH_UTF8.encode("utf-16-le")
    text_utf16, enc_utf16 = decode_subtitle_bytes(raw_utf16le)
    assert enc_utf16 == "utf-16-le"
    assert "欢迎来到中文学习课堂" in text_utf16

    # 6. Límite de tamaño
    with pytest.raises(SubtitleTooLargeError):
        decode_subtitle_bytes(b"a" * 100, max_bytes=50)


def test_parse_subtitles_ass_vtt_and_messy_srt() -> None:
    # ASS
    parsed_ass = parse_subtitles(ASS_SAMPLE, filename="episodio.ass")
    assert parsed_ass.source_format == "ass"
    assert len(parsed_ass.cues) == 1
    assert parsed_ass.cues[0].idx == 0
    assert parsed_ass.cues[0].start_ms == 500
    assert parsed_ass.cues[0].end_ms == 1800
    assert parsed_ass.cues[0].text == "第一行\n第二行"
    assert parsed_ass.skipped == 2  # 1 Comment + 1 drawing {\p1}

    # VTT
    parsed_vtt = parse_subtitles(VTT_SAMPLE, filename="episodio.vtt")
    assert parsed_vtt.source_format == "vtt"
    assert len(parsed_vtt.cues) == 2
    assert parsed_vtt.cues[0].text == "你好 世界 朋友"
    assert parsed_vtt.cues[0].start_ms == 400
    assert parsed_vtt.cues[0].end_ms == 1600
    assert parsed_vtt.cues[1].text == "第二句测试"

    # SRT desordenado, con end < start, vacío y cues solapados
    parsed_messy = parse_subtitles(SRT_MESSY, filename="messy.srt")
    assert parsed_messy.source_format == "srt"
    assert parsed_messy.skipped == 2  # 1 end < start + 1 vacío tras limpiar <i> </i>
    assert len(parsed_messy.warnings) == 2
    assert len(parsed_messy.cues) == 3
    assert [c.idx for c in parsed_messy.cues] == [0, 1, 2]
    assert [c.start_ms for c in parsed_messy.cues] == [500, 1000, 2000]
    assert parsed_messy.cues[0].end_ms == 1800
    assert parsed_messy.cues[1].start_ms == 1000  # Solapado preservado sin fusionar


def test_detect_language_heuristics() -> None:
    zh_cues = parse_subtitles(SRT_ZH_UTF8, "zh.srt").cues
    assert detect_language(zh_cues) == "zh"

    ja_srt = "1\n00:00:01,000 --> 00:00:02,000\nこんにちは、今日はいい天気ですね。\n"
    ja_cues = parse_subtitles(ja_srt, "ja.srt").cues
    assert detect_language(ja_cues) == "ja"

    ko_srt = "1\n00:00:01,000 --> 00:00:02,000\n안녕하세요, 만나서 반갑습니다.\n"
    ko_cues = parse_subtitles(ko_srt, "ko.srt").cues
    assert detect_language(ko_cues) == "ko"

    en_srt = "1\n00:00:01,000 --> 00:00:02,000\nHello world, how are you doing today?\n"
    en_cues = parse_subtitles(en_srt, "en.srt").cues
    assert detect_language(en_cues) == "und"


async def test_subtitles_crud_primary_etag_and_cascade(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    # 1. Subir video base
    with sample_mp4_path.open("rb") as fh:
        v_resp = await async_client.post(
            "/api/videos",
            files={"file": ("video.mp4", fh, "video/mp4")},
        )
    assert v_resp.status_code == 201
    video_id = v_resp.json()["id"]

    # Video inexistente → 404
    not_found_resp = await async_client.post(
        "/api/videos/99999/subtitles",
        files={"file": ("zh.srt", SRT_ZH_UTF8.encode("utf-8"), "application/x-subrip")},
    )
    assert not_found_resp.status_code == 404

    # Archivo basura binario con extensión .srt → 422
    random_garbage = bytes(range(256)) * 4
    garbage_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("basura.srt", random_garbage, "application/octet-stream")},
    )
    assert garbage_resp.status_code == 422

    # 2. Subir primera pista (GBK sin especificar idioma): auto-detecta zh y se vuelve primaria
    sub1_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={
            "file": (
                "mandarin_gbk.srt",
                SRT_ZH_UTF8.encode("gb18030"),
                "application/x-subrip",
            )
        },
    )
    assert sub1_resp.status_code == 201
    track1 = sub1_resp.json()
    track1_id = track1["id"]
    assert track1["lang"] == "zh"
    assert track1["lang_detected"] is True
    assert track1["detected_encoding"] == "gb18030"
    assert track1["is_primary"] is True
    assert track1["cue_count"] == 2

    # 3. Subir segunda pista con is_primary=true → desmarca la primera
    es_srt = (
        "1\n00:00:00,500 --> 00:00:01,800\nHola, bienvenidos a la clase de chino.\n\n"
        "2\n00:00:01,900 --> 00:00:02,900\nHoy practicaremos comprensión auditiva.\n"
    )
    sub2_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("espanol.srt", es_srt.encode("utf-8"), "text/plain")},
        data={"lang": "es", "label": "Español Neutro", "is_primary": "true"},
    )
    assert sub2_resp.status_code == 201
    track2 = sub2_resp.json()
    track2_id = track2["id"]
    assert track2["is_primary"] is True

    tracks_list = (await async_client.get(f"/api/videos/{video_id}/subtitles")).json()
    assert len(tracks_list) == 2
    primaries = [t for t in tracks_list if t["is_primary"]]
    assert len(primaries) == 1
    assert primaries[0]["id"] == track2_id

    # Verificar que VideoRead y VideoListItem exponen subtitle_tracks y subtitle_count
    v_detail = (await async_client.get(f"/api/videos/{video_id}")).json()
    assert len(v_detail["subtitle_tracks"]) == 2
    v_list = (await async_client.get("/api/videos")).json()
    assert v_list[0]["subtitle_count"] == 2

    # 4. GET cues + ETag / 304 Not Modified
    cues_resp = await async_client.get(f"/api/subtitles/{track1_id}/cues")
    assert cues_resp.status_code == 200
    etag = cues_resp.headers.get("etag")
    assert etag is not None
    assert (
        cues_resp.headers.get("cache-control")
        == "private, max-age=0, must-revalidate"
    )
    cues_payload = cues_resp.json()
    assert cues_payload["track_id"] == track1_id
    assert len(cues_payload["cues"]) == 2
    assert cues_payload["cues"][0]["text"] == "你好，欢迎来到中文学习课堂！"

    not_mod_resp = await async_client.get(
        f"/api/subtitles/{track1_id}/cues",
        headers={"If-None-Match": etag},
    )
    assert not_mod_resp.status_code == 304

    # 5. PATCH offset_ms, lang e is_primary (y bloqueo 409 al intentar desmarcar la única primaria)
    conflict_patch = await async_client.patch(
        f"/api/subtitles/{track2_id}",
        json={"is_primary": False},
    )
    assert conflict_patch.status_code == 409

    patch_resp = await async_client.patch(
        f"/api/subtitles/{track1_id}",
        json={"offset_ms": -350, "label": "Chino Simplificado", "is_primary": True},
    )
    assert patch_resp.status_code == 200
    patched = patch_resp.json()
    assert patched["offset_ms"] == -350
    assert patched["label"] == "Chino Simplificado"
    assert patched["is_primary"] is True

    # 6. DELETE de la pista primaria promueve la restante a primaria
    del_track1 = await async_client.delete(f"/api/subtitles/{track1_id}")
    assert del_track1.status_code == 204

    tracks_after_del = (
        await async_client.get(f"/api/videos/{video_id}/subtitles")
    ).json()
    assert len(tracks_after_del) == 1
    assert tracks_after_del[0]["id"] == track2_id
    assert tracks_after_del[0]["is_primary"] is True

    # 7. DELETE /api/videos/{id} elimina pistas y cues por CASCADE
    del_video = await async_client.delete(f"/api/videos/{video_id}")
    assert del_video.status_code == 204

    # Verificación directa en SQLite de que no quedaron pistas ni cues huérfanos
    from app.db import build_engine

    engine = build_engine(test_settings)
    with Session(engine) as db_session:
        remaining_tracks = list(db_session.exec(select(SubtitleTrack)).all())
        remaining_cues = list(db_session.exec(select(Cue)).all())
        assert remaining_tracks == []
        assert remaining_cues == []
    engine.dispose()


async def test_performance_5000_cues_insert_and_read(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
) -> None:
    with sample_mp4_path.open("rb") as fh:
        v_resp = await async_client.post(
            "/api/videos",
            files={"file": ("perf_video.mp4", fh, "video/mp4")},
        )
    video_id = v_resp.json()["id"]

    blocks: list[str] = []
    for i in range(5000):
        start_s = i * 2
        end_s = start_s + 1
        sh, sm, ss = start_s // 3600, (start_s % 3600) // 60, start_s % 60
        eh, em, es = end_s // 3600, (end_s % 3600) // 60, end_s % 60
        blocks.append(
            f"{i + 1}\n"
            f"{sh:02d}:{sm:02d}:{ss:02d},100 --> {eh:02d}:{em:02d}:{es:02d},900\n"
            f"这是第 {i + 1} 条测试中文字幕内容。\n"
        )
    synthetic_srt = "\n".join(blocks).encode("utf-8")

    t0 = time.perf_counter()
    up_resp = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("perf_5000.srt", synthetic_srt, "application/x-subrip")},
        data={"lang": "zh"},
    )
    insert_elapsed = time.perf_counter() - t0
    assert up_resp.status_code == 201
    track_id = up_resp.json()["id"]
    assert up_resp.json()["cue_count"] == 5000
    assert insert_elapsed < 1.0, f"Inserción tardó {insert_elapsed:.3f}s (>= 1.0s)"

    t1 = time.perf_counter()
    read_resp = await async_client.get(f"/api/subtitles/{track_id}/cues")
    read_elapsed = time.perf_counter() - t1
    assert read_resp.status_code == 200
    assert len(read_resp.json()["cues"]) == 5000
    assert read_elapsed < 1.0, f"Lectura tardó {read_elapsed:.3f}s (>= 1.0s)"
