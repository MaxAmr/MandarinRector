import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlmodel import Session

from app.config import Settings
from app.db import get_session
from app.models import DictionaryEntry
from app.schemas import (
    CharBreakdownItem,
    DictionaryEntryRead,
    DictionaryLookupResponse,
    DictionaryStatusResponse,
)
from app.services.dictionary import (
    download_cedict_file,
    get_dictionary_entry_count,
    import_cedict_file,
    lookup_word,
)

router = APIRouter(prefix="/api/dictionary", tags=["dictionary"])


def get_app_settings(request: Request) -> Settings:
    return request.app.state.settings


def _entry_to_dto(entry: DictionaryEntry) -> DictionaryEntryRead:
    assert entry.id is not None
    try:
        defs = json.loads(entry.definitions_json)
        if not isinstance(defs, list):
            defs = []
    except ValueError:
        defs = []

    classifiers: list[str] = []
    if entry.classifiers_json:
        try:
            parsed_cls = json.loads(entry.classifiers_json)
            if isinstance(parsed_cls, list):
                classifiers = [str(item) for item in parsed_cls]
        except ValueError:
            classifiers = []

    return DictionaryEntryRead(
        id=entry.id,
        traditional=entry.traditional,
        simplified=entry.simplified,
        pinyin_numeric=entry.pinyin_numeric,
        pinyin_marks=entry.pinyin_marks,
        definitions=[str(d) for d in defs],
        classifiers=classifiers,
    )


@router.get("/status", response_model=DictionaryStatusResponse)
async def get_dictionary_status(
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
) -> DictionaryStatusResponse:
    count = get_dictionary_entry_count(session)
    cedict_path = settings.resolved_cedict_path
    file_exists = await asyncio.to_thread(cedict_path.is_file)
    return DictionaryStatusResponse(
        loaded=count > 0,
        entry_count=count,
        cedict_file_exists=file_exists,
        cedict_path=str(cedict_path),
    )


@router.post("/import", response_model=DictionaryStatusResponse)
async def import_dictionary(
    request: Request,
    session: Annotated[Session, Depends(get_session)],
    settings: Annotated[Settings, Depends(get_app_settings)],
    download: Annotated[bool, Query()] = False,
) -> DictionaryStatusResponse:
    cedict_path = settings.resolved_cedict_path
    file_exists = await asyncio.to_thread(cedict_path.is_file)

    if not file_exists:
        if not download:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=(
                    f"Archivo CC-CEDICT no encontrado en {cedict_path}. "
                    "Podés pasar ?download=true o descargarlo con el comando CLI."
                ),
            )
        try:
            await asyncio.to_thread(
                download_cedict_file,
                cedict_path,
                settings.CEDICT_DOWNLOAD_URL,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"No se pudo descargar CC-CEDICT: {exc}",
            ) from exc

    count = await asyncio.to_thread(
        import_cedict_file,
        cedict_path,
        request.app.state.engine,
        True,
    )
    return DictionaryStatusResponse(
        loaded=count > 0,
        entry_count=count,
        cedict_file_exists=True,
        cedict_path=str(cedict_path),
    )


@router.get("/{word}", response_model=DictionaryLookupResponse)
async def lookup_dictionary_word(
    word: str,
    response: Response,
    session: Annotated[Session, Depends(get_session)],
) -> DictionaryLookupResponse:
    clean_word = word.strip()
    if not clean_word:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="La palabra a consultar no puede estar vacía.",
        )

    total_entries = get_dictionary_entry_count(session)
    result = lookup_word(session, clean_word)

    if total_entries > 0:
        response.headers["Cache-Control"] = "public, max-age=86400"
    else:
        response.headers["Cache-Control"] = "no-store"

    return DictionaryLookupResponse(
        query=result.query,
        normalized_simplified=result.normalized_simplified,
        dictionary_loaded=total_entries > 0,
        entries=[_entry_to_dto(entry) for entry in result.entries],
        char_entries=[
            CharBreakdownItem(
                char=item.char,
                entries=[_entry_to_dto(e) for e in item.entries],
            )
            for item in result.char_entries
        ],
    )
