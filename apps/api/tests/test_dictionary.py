from pathlib import Path

import httpx

from app.config import Settings
from app.db import build_engine, init_db
from app.services.dictionary import (
    cedict_pinyin_to_marks,
    import_cedict_file,
    parse_cedict_line,
)

MINI_CEDICT = """# CC-CEDICT mini fixture para tests
# Comentario inicial
你好 你好 [ni3 hao3] /hello/hi/
銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/
綠 绿 [lu:4] /green/
女 女 [nv3] /female/woman/daughter/
張 张 [Zhang1] /surname Zhang/
張 张 [zhang1] /to open up/to spread/sheet of paper/CL:張|张[zhang1]/
學 学 [xue2] /to learn/to study/
生 生 [sheng1] /to be born/life/student/
"""


def test_parse_cedict_line_and_pinyin_marks() -> None:
    assert parse_cedict_line("# comentario") is None
    assert parse_cedict_line("   ") is None

    num, marks = cedict_pinyin_to_marks("lu:4 se4")
    assert num == "lü4 se4"
    assert marks == "lǜ sè"

    entry_bank = parse_cedict_line(
        "銀行 银行 [yin2 hang2] /bank/CL:家[jia1],個|个[ge4]/"
    )
    assert entry_bank is not None
    assert entry_bank.traditional == "銀行"
    assert entry_bank.simplified == "银行"
    assert entry_bank.pinyin_marks == "yín háng"
    assert entry_bank.definitions == ["bank"]
    assert entry_bank.classifiers == ["家[jia1]", "個|个[ge4]"]
    assert entry_bank.rank == 0

    entry_surname = parse_cedict_line("張 张 [Zhang1] /surname Zhang/")
    assert entry_surname is not None
    assert entry_surname.rank == 1
    assert entry_surname.pinyin_marks == "Zhāng"


async def test_dictionary_endpoints_import_lookup_and_char_breakdown(
    async_client: httpx.AsyncClient,
    test_settings: Settings,
) -> None:
    # 1. Sin archivo ni entradas: status=loaded:false, import sin download -> 404
    status_empty = await async_client.get("/api/dictionary/status")
    assert status_empty.status_code == 200
    assert status_empty.json()["loaded"] is False
    assert status_empty.json()["entry_count"] == 0

    import_missing = await async_client.post("/api/dictionary/import")
    assert import_missing.status_code == 404

    lookup_empty = await async_client.get("/api/dictionary/你好")
    assert lookup_empty.status_code == 200
    assert lookup_empty.json()["dictionary_loaded"] is False
    assert lookup_empty.json()["entries"] == []

    # 2. Escribir fixture mini-CEDICT y llamar a POST /api/dictionary/import
    cedict_file: Path = test_settings.resolved_cedict_path
    cedict_file.parent.mkdir(parents=True, exist_ok=True)
    cedict_file.write_text(MINI_CEDICT.replace("nv3", "nu:3"), encoding="utf-8")

    import_ok = await async_client.post("/api/dictionary/import")
    assert import_ok.status_code == 200
    assert import_ok.json()["loaded"] is True
    assert import_ok.json()["entry_count"] == 8

    # 3. Consulta exacta en tradicional ("銀行")
    resp_trad = await async_client.get("/api/dictionary/銀行")
    assert resp_trad.status_code == 200
    assert "max-age=86400" in resp_trad.headers.get("cache-control", "")
    data_trad = resp_trad.json()
    assert data_trad["dictionary_loaded"] is True
    assert data_trad["normalized_simplified"] == "银行"
    assert len(data_trad["entries"]) == 1
    assert data_trad["entries"][0]["simplified"] == "银行"
    assert data_trad["entries"][0]["pinyin_marks"] == "yín háng"
    assert data_trad["entries"][0]["definitions"] == ["bank"]
    assert len(data_trad["entries"][0]["classifiers"]) == 2

    # 4. Ordenamiento por rank: palabra común ("zhang1") aparece antes que apellido ("Zhang1")
    resp_zhang = await async_client.get("/api/dictionary/张")
    assert resp_zhang.status_code == 200
    entries_zhang = resp_zhang.json()["entries"]
    assert len(entries_zhang) == 2
    assert entries_zhang[0]["pinyin_numeric"] == "zhang1"
    assert entries_zhang[1]["pinyin_numeric"] == "Zhang1"

    # 5. Compuesto ausente ("学生") devuelve entries vacío y char_entries con 學/生
    resp_compound = await async_client.get("/api/dictionary/学生")
    assert resp_compound.status_code == 200
    data_comp = resp_compound.json()
    assert data_comp["entries"] == []
    assert [item["char"] for item in data_comp["char_entries"]] == ["学", "生"]
    assert data_comp["char_entries"][0]["entries"][0]["pinyin_marks"] == "xué"
    assert data_comp["char_entries"][1]["entries"][0]["pinyin_marks"] == "shēng"

    # 6. Importación directa idempotente por CLI/función
    engine = build_engine(test_settings)
    init_db(engine)
    count2 = import_cedict_file(cedict_file, engine, replace=True)
    assert count2 == 8
    engine.dispose()
