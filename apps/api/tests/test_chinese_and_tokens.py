import asyncio
import json
from pathlib import Path
import time
import tracemalloc
from typing import Any

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
import httpx
from sqlmodel import SQLModel, Session

from app.config import Settings
from app.db import build_engine, init_db
from app.main import create_app
from app.models import Cue, SubtitleTrack, TokensStatus, Video, VideoStatus
from app.routers.subtitles import _build_track_etag
from app.services.chinese import (
    TOKENS_SCHEMA_VERSION,
    detect_script,
    init_segmenter,
    is_han_char,
    pinyin_for_word,
    tokenize_cue,
    tokenize_cue_text,
    tokenize_line,
    tokens_to_pinyin_string,
)
from app.services.tokenizer_job import tokenize_track


def _assert_token_invariants(original_text: str, payload: dict[str, Any]) -> None:
    assert payload.get("v") == TOKENS_SCHEMA_VERSION
    tokens = payload.get("t")
    assert isinstance(tokens, list)

    # Invariante 1 (lossless): concatenar w reconstruye exactamente el texto original
    reconstructed = "".join(t["w"] for t in tokens)
    assert reconstructed == original_text

    # Invariante 2: en tokens k="w", solo caracteres Han y len(p) == len(n) == len(w)
    for tok in tokens:
        kind = tok["k"]
        word = tok["w"]
        assert kind in ("w", "p", "l", "s", "b")
        if kind == "w":
            assert len(word) > 0
            assert all(is_han_char(ch) for ch in word), f"Carácter no-Han en {word!r}"
            p_list = tok["p"]
            n_list = tok["n"]
            assert len(p_list) == len(word)
            assert len(n_list) == len(word)
            for p_val, n_val in zip(p_list, n_list):
                if p_val is None:
                    assert n_val is None
                else:
                    assert isinstance(p_val, str) and len(p_val) > 0
                    assert n_val in (1, 2, 3, 4, 5)
        elif kind == "b":
            assert word == "\n"
            assert "p" not in tok and "n" not in tok
        else:
            assert all(not is_han_char(ch) for ch in word)
            assert "p" not in tok and "n" not in tok


def test_alembic_upgrade_head_matches_sqlmodel_metadata(tmp_path: Path) -> None:
    settings = Settings(DATA_DIR=tmp_path / "alembic_test_data")
    engine = build_engine(settings)
    init_db(engine)

    with engine.connect() as connection:
        migration_ctx = MigrationContext.configure(
            connection,
            opts={"compare_type": True, "compare_server_default": True},
        )
        diff = compare_metadata(migration_ctx, SQLModel.metadata)
        assert diff == [], f"Diferencias detectadas entre Alembic y SQLModel: {diff}"

    engine.dispose()


def test_lossless_and_han_invariants_across_corpus() -> None:
    corpus = [
        "你好，欢迎来到2024年的中文课堂！",
        "我們今天去銀行辦理業務。",
        "「……這真的沒問題嗎？——我覺得OK！」",
        "♪ 音乐响起   中间有三个空格   ♪",
        "A型血和B型血有什么不同？一共3个人。",
        "第一行文本\n\n第三行（中间有空行）\n   前导空格与尾随空格   ",
        "Rare Extension B char: 𠮷野家与〇号房间",
        "",
        "   ",
    ]
    for sample in corpus:
        script = detect_script([sample])
        payload = tokenize_cue(sample, script=script)
        _assert_token_invariants(sample, payload)


def test_non_bmp_character_and_mixed_tokens() -> None:
    # Carácter fuera del BMP: 𠮷 (U+20BB7) tiene longitud 1 en code points
    assert len("𠮷") == 1
    assert is_han_char("𠮷") is True
    assert is_han_char("〇") is True

    payload_bmp = tokenize_cue("𠮷")
    _assert_token_invariants("𠮷", payload_bmp)
    tok = payload_bmp["t"][0]
    assert tok["k"] == "w"
    assert tok["w"] == "𠮷"
    assert len(tok["p"]) == 1
    assert len(tok["n"]) == 1

    # Tokens mixtos: "2024年" -> l("2024") + w("年")
    tokens_2024 = tokenize_line("2024年")
    assert [t["k"] for t in tokens_2024] == ["l", "w"]
    assert tokens_2024[0]["w"] == "2024"
    assert tokens_2024[1]["w"] == "年"
    assert tokens_2024[1]["p"] == ["nián"]
    assert tokens_2024[1]["n"] == [2]

    # "A型血" separa "A" (l) de los caracteres Han (w)
    tokens_blood = tokenize_line("A型血")
    assert tokens_blood[0] == {"w": "A", "k": "l"}
    assert all(t["k"] == "w" for t in tokens_blood[1:])
    assert "".join(t["w"] for t in tokens_blood) == "A型血"


def test_polyphones_tones_and_umlaut() -> None:
    # Polifónicos a nivel palabra
    p_yinhang, n_yinhang = pinyin_for_word("银行")
    p_buxing, n_buxing = pinyin_for_word("不行")
    assert p_yinhang[1] == "háng" and n_yinhang[1] == 2
    assert p_buxing[1] == "xíng" and n_buxing[1] == 2

    p_zhongyao, n_zhongyao = pinyin_for_word("重要")
    p_chongxin, n_chongxin = pinyin_for_word("重新")
    assert p_zhongyao[0] == "zhòng" and n_zhongyao[0] == 4
    assert p_chongxin[0] == "chóng" and n_chongxin[0] == 2

    p_zhangda, n_zhangda = pinyin_for_word("长大")
    p_henchang, n_henchang = pinyin_for_word("很长")
    assert p_zhangda[0] == "zhǎng" and n_zhangda[0] == 3
    assert p_henchang[1] == "cháng" and n_henchang[1] == 2

    # Tonos en citación (sin sandhi): 你好吗 -> [3, 3, 5]
    p_nhm, n_nhm = pinyin_for_word("你好吗", tone_sandhi=False)
    assert p_nhm == ["nǐ", "hǎo", "ma"]
    assert n_nhm == [3, 3, 5]

    _, n_de = pinyin_for_word("的")
    assert n_de == [5]

    # Conservación de diéresis ü en lǜ y nǚ
    p_lv, n_lv = pinyin_for_word("绿色")
    p_nv, n_nv = pinyin_for_word("女人")
    assert p_lv[0] == "lǜ" and n_lv[0] == 4
    assert p_nv[0] == "nǚ" and n_nv[0] == 3

    # Helper tokens_to_pinyin_string (extensión Fase 6)
    cue_tokens = tokenize_cue("你好吗！")
    assert tokens_to_pinyin_string(cue_tokens) == "nǐ hǎo ma"


def test_traditional_script_detection_and_length_guard() -> None:
    trad_line = "我們今天去銀行辦理業務"
    simp_line = "我们今天去银行办理业务"

    assert detect_script([trad_line]) == "hant"
    assert detect_script([simp_line]) == "hans"
    assert detect_script(["Hello world 123!"]) is None

    trad_tokens = tokenize_line(trad_line, script="hant")
    simp_tokens = tokenize_line(simp_line, script="hans")

    # El texto original en tradicional se preserva intacto
    assert "".join(t["w"] for t in trad_tokens) == trad_line
    # Y el pinyin coincide con la versión simplificada equivalente
    trad_pinyins = [p for t in trad_tokens if t["k"] == "w" for p in t["p"]]
    simp_pinyins = [p for t in simp_tokens if t["k"] == "w" for p in t["p"]]
    assert trad_pinyins == simp_pinyins

    # Guard de longitud: simulamos un conversor t2s que altera la longitud (no 1:1)
    def broken_converter(s: str) -> str:
        return s + "多余字符"

    fallback_payload = tokenize_cue(
        trad_line,
        script="hant",
        t2s_converter=broken_converter,
    )
    _assert_token_invariants(trad_line, fallback_payload)


def test_custom_userdict_segments_proper_noun_as_single_token(tmp_path: Path) -> None:
    userdict_file = tmp_path / "userdict.txt"
    # Nombre propio ficticio de 4 caracteres que sin userdict se partiría
    custom_word = "云深不知"
    userdict_file.write_text(f"{custom_word} 50000 nr\n", encoding="utf-8")

    init_segmenter(userdict_path=userdict_file)
    tokens = tokenize_line(f"欢迎来到{custom_word}处")
    words = [t["w"] for t in tokens if t["k"] == "w"]
    assert custom_word in words


async def test_pipeline_endpoints_etag_gzip_and_recovery(
    async_client: httpx.AsyncClient,
    sample_mp4_path: Path,
    test_settings: Settings,
) -> None:
    # 1. Subir video
    with sample_mp4_path.open("rb") as fh:
        v_resp = await async_client.post(
            "/api/videos",
            files={"file": ("video.mp4", fh, "video/mp4")},
        )
    assert v_resp.status_code == 201
    video_id = v_resp.json()["id"]

    # 2. Subir SRT en chino tradicional -> auto-detecta zh, tokeniza en BackgroundTasks -> ready + hant
    trad_srt = (
        "1\n00:00:00,500 --> 00:00:01,800\n我們今天去銀行！\n\n"
        "2\n00:00:01,900 --> 00:00:02,900\n這個問題非常重要。\n"
    )
    up_zh = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("trad.srt", trad_srt.encode("utf-8"), "application/x-subrip")},
    )
    assert up_zh.status_code == 201
    zh_track_id = up_zh.json()["id"]

    # Verificar estado tras BackgroundTask
    tracks_resp = await async_client.get(f"/api/videos/{video_id}/subtitles")
    zh_track = next(t for t in tracks_resp.json() if t["id"] == zh_track_id)
    assert zh_track["tokens_status"] == "ready"
    assert zh_track["script"] == "hant"
    assert zh_track["tokens_version"] == TOKENS_SCHEMA_VERSION

    # 3. Verificar compresión GZip acotada a /cues y NO en /stream
    cues_resp = await async_client.get(
        f"/api/subtitles/{zh_track_id}/cues",
        headers={"Accept-Encoding": "gzip"},
    )
    assert cues_resp.status_code == 200
    assert cues_resp.headers.get("content-encoding") == "gzip"
    ready_etag = cues_resp.headers.get("etag")
    assert ready_etag is not None

    cues_data = cues_resp.json()
    assert cues_data["cues"][0]["tokens"] is not None
    assert cues_data["cues"][0]["tokens"]["v"] == 1
    _assert_token_invariants(
        cues_data["cues"][0]["text"],
        cues_data["cues"][0]["tokens"],
    )

    # El endpoint /stream NO debe comprimirse con gzip aunque se envíe Accept-Encoding: gzip
    stream_resp = await async_client.get(
        f"/api/videos/{video_id}/stream",
        headers={"Range": "bytes=0-99", "Accept-Encoding": "gzip"},
    )
    assert stream_resp.status_code == 206
    assert "content-encoding" not in stream_resp.headers

    # 4. ETag: si la pista estaba en pending tenía otro ETag distinto de ready_etag
    with Session( build_engine(test_settings) ) as db_s:
        dummy_pending = SubtitleTrack(
            id=zh_track_id,
            video_id=video_id,
            lang="zh",
            label="trad",
            is_primary=True,
            source_format="srt",
            original_filename="trad.srt",
            cue_count=2,
            tokens_status="pending",
            tokens_version=None,
        )
        old_etag = _build_track_etag(dummy_pending)
        assert old_etag != ready_etag

    resp_old_etag = await async_client.get(
        f"/api/subtitles/{zh_track_id}/cues",
        headers={"If-None-Match": old_etag},
    )
    assert resp_old_etag.status_code == 200

    resp_new_etag = await async_client.get(
        f"/api/subtitles/{zh_track_id}/cues",
        headers={"If-None-Match": ready_etag},
    )
    assert resp_new_etag.status_code == 304

    # 5. Subir SRT en español -> not_applicable y tokens: null
    es_srt = "1\n00:00:00,500 --> 00:00:01,800\nHola amigos, bienvenidos.\n"
    up_es = await async_client.post(
        f"/api/videos/{video_id}/subtitles",
        files={"file": ("es.srt", es_srt.encode("utf-8"), "application/x-subrip")},
        data={"lang": "es"},
    )
    assert up_es.status_code == 201
    es_track = up_es.json()
    es_track_id = es_track["id"]
    assert es_track["tokens_status"] == "not_applicable"

    es_cues = (await async_client.get(f"/api/subtitles/{es_track_id}/cues")).json()
    assert es_cues["cues"][0]["tokens"] is None

    # POST /tokenize en pista no-zh -> 422; inexistente -> 404
    tok_422 = await async_client.post(f"/api/subtitles/{es_track_id}/tokenize")
    assert tok_422.status_code == 422
    tok_404 = await async_client.post("/api/subtitles/999999/tokenize")
    assert tok_404.status_code == 404

    # 6. PATCH lang zh -> es borra tokens; es -> zh vuelve a tokenizar
    patch_to_es = await async_client.patch(
        f"/api/subtitles/{zh_track_id}",
        json={"lang": "es"},
    )
    assert patch_to_es.status_code == 200
    assert patch_to_es.json()["tokens_status"] == "not_applicable"
    cues_Cleared = (
        await async_client.get(f"/api/subtitles/{zh_track_id}/cues")
    ).json()
    assert cues_Cleared["cues"][0]["tokens"] is None

    patch_back_zh = await async_client.patch(
        f"/api/subtitles/{zh_track_id}",
        json={"lang": "zh"},
    )
    assert patch_back_zh.status_code == 200
    cues_retokenized = (
        await async_client.get(f"/api/subtitles/{zh_track_id}/cues")
    ).json()
    assert cues_retokenized["cues"][0]["tokens"] is not None

    # 7. POST /tokenize?force=false (idempotente) y ?force=true (recomputa -> 202)
    tok_202 = await async_client.post(
        f"/api/subtitles/{zh_track_id}/tokenize?force=true"
    )
    assert tok_202.status_code == 202

    # 8. Reclamo atómico: dos llamadas simultáneas a tokenize_track sobre la misma pista
    engine = build_engine(test_settings)
    with Session(engine) as s:
        t = s.get(SubtitleTrack, zh_track_id)
        assert t is not None
        t.tokens_status = TokensStatus.PENDING.value
        s.add(t)
        s.commit()

    results = await asyncio.gather(
        tokenize_track(zh_track_id, engine, test_settings, force=True),
        tokenize_track(zh_track_id, engine, test_settings, force=True),
    )
    # Exactamente una de las dos corrutinas adquiere el reclamo atómico
    assert results.count(True) == 1
    assert results.count(False) == 1
    engine.dispose()


async def test_startup_reenqueues_interrupted_processing_track(
    test_settings: Settings,
) -> None:
    app1 = create_app(test_settings)
    async with app1.router.lifespan_context(app1):
        with Session(app1.state.engine) as session:
            v = Video(
                title="Video Test",
                original_filename="v.mp4",
                original_path="videos/original/v.mp4",
                size_bytes=100,
                status=VideoStatus.READY,
            )
            session.add(v)
            session.flush()
            assert v.id is not None

            t = SubtitleTrack(
                video_id=v.id,
                lang="zh",
                label="Colgada",
                is_primary=True,
                source_format="srt",
                original_filename="zh.srt",
                cue_count=1,
                tokens_status=TokensStatus.PROCESSING.value,
            )
            session.add(t)
            session.flush()
            assert t.id is not None
            stuck_track_id = t.id

            c = Cue(
                track_id=t.id,
                idx=0,
                start_ms=100,
                end_ms=900,
                text="你好世界！",
                tokens_json=None,
            )
            session.add(c)
            session.commit()

    # Reiniciar app sobre la misma DB: debe recuperar la pista colgada en 'processing' y llevarla a 'ready'
    app2 = create_app(test_settings)
    async with app2.router.lifespan_context(app2):
        if getattr(app2.state, "recovery_tasks", None):
            await asyncio.gather(*app2.state.recovery_tasks)
        with Session(app2.state.engine) as session:
            recovered = session.get(SubtitleTrack, stuck_track_id)
            assert recovered is not None
            assert recovered.tokens_status == TokensStatus.READY.value
            assert recovered.tokens_version == TOKENS_SCHEMA_VERSION


def test_performance_5000_cues_tokenization() -> None:
    sample_sentences = [
        "你好，欢迎来到2024年的中文学习课堂！",
        "我们今天去银行办理非常重要的业务。",
        "这个问题不太容易解决，需要重新考虑一下。",
        "她从小在北京长大，现在头发已经很长了。",
        "今天天气真不错，你想不想出去散步？",
    ]
    cues_5000 = [sample_sentences[i % len(sample_sentences)] for i in range(5000)]

    tracemalloc.start()
    t0 = time.perf_counter()
    script = detect_script(cues_5000[:200])
    outputs = [tokenize_cue_text(line, script=script) for line in cues_5000]
    elapsed = time.perf_counter() - t0
    _, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(outputs) == 5000
    assert elapsed < 5.0, f"La tokenización de 5 000 cues tardó {elapsed:.3f}s (>= 5.0s)"
    # Verificar tamaño de compresión gzip sobre los 5 000 cues
    raw_payload = ("[" + ",".join(outputs) + "]").encode("utf-8")
    import gzip

    compressed = gzip.compress(raw_payload, compresslevel=6)
    assert len(compressed) < len(raw_payload) * 0.4
    _ = peak_bytes
