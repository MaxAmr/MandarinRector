"""Servicio de generación de paquetes `.apkg` para Anki mediante `genanki` y soporte AnkiConnect (Fase 7)."""

import base64
import hashlib
import html
import logging
from pathlib import Path
import tempfile
from typing import Literal

import genanki
import httpx

from app.config import Settings
from app.models import Phrase, Video
from app.services.storage import resolve_data_path

logger = logging.getLogger("app.services.anki_export")

# IDs fijos base para que Anki actualice notas existentes al re-importar mazos
MANDARIN_CLIP_MODEL_ID_BASE = 1607392319
MANDARIN_CLIP_DECK_ID_BASE = 2059400110

CardType = Literal["listening", "reading", "production"]

ANKI_CARD_CSS = """
.card {
  font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif;
  font-size: 20px;
  text-align: center;
  color: #f8fafc;
  background-color: #0f172a;
  padding: 20px;
}
.hanzi {
  font-size: 34px;
  font-weight: 700;
  color: #ffffff;
  margin: 12px 0 6px;
  line-height: 1.35;
}
.pinyin {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 20px;
  color: #38bdf8;
  margin-bottom: 10px;
}
.translation {
  font-size: 19px;
  color: #e2e8f0;
  margin-bottom: 12px;
}
.focus-hint {
  display: inline-block;
  background: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
  border: 1px solid rgba(245, 158, 11, 0.4);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 15px;
  margin: 6px 0;
}
.notes {
  font-size: 15px;
  font-style: italic;
  color: #94a3b8;
  margin-top: 10px;
}
.source {
  font-size: 12px;
  color: #64748b;
  margin-top: 16px;
}
.media img {
  max-width: 420px;
  width: 100%;
  height: auto;
  border-radius: 10px;
  margin: 8px auto;
  display: block;
}
"""


def _deterministic_anki_id(seed_text: str, fallback: int) -> int:
    if not seed_text or seed_text == "Mandarín - Clips":
        return fallback
    digest = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:8]
    return (int(digest, 16) % 1_000_000_000) + 1_100_000_000


def _build_templates(card_types: list[CardType]) -> list[dict[str, str]]:
    templates: list[dict[str, str]] = []
    normalized = card_types or ["listening", "reading"]

    if "listening" in normalized:
        templates.append(
            {
                "name": "1. Escucha → Lectura",
                "qfmt": (
                    '<div class="media">{{Screenshot}}<br>{{Audio}}{{VideoClip}}</div>'
                    '{{#FocusWord}}<div class="focus-hint">Foco: {{FocusWord}}</div>{{/FocusWord}}'
                ),
                "afmt": (
                    '{{FrontSide}}<hr id="answer">'
                    '<div class="hanzi">{{Hanzi}}</div>'
                    '<div class="pinyin">{{Pinyin}}</div>'
                    '<div class="translation">{{Traduccion}}</div>'
                    '{{#Notas}}<div class="notes">{{Notas}}</div>{{/Notas}}'
                    '<div class="source">{{FuenteVideo}}</div>'
                ),
            }
        )

    if "reading" in normalized:
        templates.append(
            {
                "name": "2. Lectura → Significado",
                "qfmt": (
                    '<div class="hanzi">{{Hanzi}}</div>'
                    '{{#FocusWord}}<div class="focus-hint">Foco: {{FocusWord}}</div>{{/FocusWord}}'
                ),
                "afmt": (
                    '{{FrontSide}}<hr id="answer">'
                    '<div class="pinyin">{{Pinyin}}</div>'
                    '<div class="translation">{{Traduccion}}</div>'
                    '<div class="media">{{Screenshot}}<br>{{Audio}}{{VideoClip}}</div>'
                    '{{#Notas}}<div class="notes">{{Notas}}</div>{{/Notas}}'
                    '<div class="source">{{FuenteVideo}}</div>'
                ),
            }
        )

    if "production" in normalized:
        templates.append(
            {
                "name": "3. Producción (Traducción → Hanzi)",
                "qfmt": (
                    '<div class="translation">{{Traduccion}}</div>'
                    '{{#FocusWord}}<div class="focus-hint">Palabra clave: {{FocusWord}}</div>{{/FocusWord}}'
                    '<div class="media">{{Screenshot}}</div>'
                ),
                "afmt": (
                    '{{FrontSide}}<hr id="answer">'
                    '<div class="hanzi">{{Hanzi}}</div>'
                    '<div class="pinyin">{{Pinyin}}</div>'
                    '<div>{{Audio}}{{VideoClip}}</div>'
                    '{{#Notas}}<div class="notes">{{Notas}}</div>{{/Notas}}'
                    '<div class="source">{{FuenteVideo}}</div>'
                ),
            }
        )

    return templates


def _format_ms_mmss(ms: int) -> str:
    total_sec = max(0, ms // 1000)
    mm = total_sec // 60
    ss = total_sec % 60
    return f"{mm:02d}:{ss:02d}"


def build_anki_apkg_bytes(
    phrases: list[Phrase],
    videos_by_id: dict[int, Video],
    settings: Settings,
    deck_name: str = "Mandarín - Clips",
    include_video: bool = False,
    card_types: list[CardType] | None = None,
) -> bytes:
    """Construye un archivo `.apkg` en disco temporal con las frases y sus archivos multimedia."""
    effective_card_types: list[CardType] = (
        card_types if card_types else ["listening", "reading"]
    )
    templates = _build_templates(effective_card_types)
    # Derivamos el Model ID según la combinación de plantillas para evitar colisiones de esquema en Anki
    templates_key = ",".join(sorted(effective_card_types))
    model_id = (
        MANDARIN_CLIP_MODEL_ID_BASE
        if templates_key == "listening,reading"
        else _deterministic_anki_id(
            f"model:{templates_key}", MANDARIN_CLIP_MODEL_ID_BASE
        )
    )
    deck_id = _deterministic_anki_id(deck_name.strip(), MANDARIN_CLIP_DECK_ID_BASE)

    model = genanki.Model(
        model_id,
        "Mandarin Reactor Clip",
        fields=[
            {"name": "PhraseId"},
            {"name": "Hanzi"},
            {"name": "FocusWord"},
            {"name": "Pinyin"},
            {"name": "Traduccion"},
            {"name": "Notas"},
            {"name": "Audio"},
            {"name": "Screenshot"},
            {"name": "VideoClip"},
            {"name": "FuenteVideo"},
        ],
        templates=templates,
        css=ANKI_CARD_CSS,
    )

    deck = genanki.Deck(deck_id, deck_name.strip() or "Mandarín - Clips")
    media_files: list[str] = []
    seen_media: set[str] = set()

    def register_media(rel_path: str | None) -> str | None:
        if not rel_path:
            return None
        try:
            abs_p = resolve_data_path(settings, rel_path)
        except ValueError:
            return None
        if not abs_p.is_file():
            return None
        abs_str = str(abs_p)
        if abs_str not in seen_media:
            seen_media.add(abs_str)
            media_files.append(abs_str)
        return abs_p.name

    for phrase in phrases:
        audio_filename = register_media(phrase.clip_audio_path)
        thumb_filename = register_media(phrase.clip_thumb_path)
        video_filename = (
            register_media(phrase.clip_video_path) if include_video else None
        )

        audio_field = f"[sound:{audio_filename}]" if audio_filename else ""
        thumb_field = f'<img src="{thumb_filename}">' if thumb_filename else ""
        video_field = f"[sound:{video_filename}]" if video_filename else ""

        video_obj = videos_by_id.get(phrase.video_id)
        video_title = video_obj.title if video_obj else f"Video #{phrase.video_id}"
        source_label = f"{html.escape(video_title)} ({_format_ms_mmss(phrase.start_ms)})"

        note_guid = genanki.guid_for("mandarin-reactor-phrase", phrase.id or phrase.hanzi)
        note = genanki.Note(
            model=model,
            guid=note_guid,
            fields=[
                str(phrase.id or ""),
                html.escape(phrase.hanzi),
                html.escape(phrase.focus_word or ""),
                html.escape(phrase.pinyin),
                html.escape(phrase.translation),
                html.escape(phrase.notes or ""),
                audio_field,
                thumb_field,
                video_field,
                source_label,
            ],
        )
        deck.add_note(note)

    pkg = genanki.Package(deck)
    pkg.media_files = media_files

    with tempfile.NamedTemporaryFile(suffix=".apkg", delete=False) as tmp_file:
        tmp_path = Path(tmp_file.name)

    try:
        pkg.write_to_file(str(tmp_path))
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)


async def push_phrases_to_ankiconnect(
    phrases: list[Phrase],
    videos_by_id: dict[int, Video],
    settings: Settings,
    deck_name: str = "Mandarín - Clips",
    anki_connect_url: str = "http://127.0.0.1:8765",
) -> dict[str, int]:
    """Envía frases y archivos multimedia directamente a Anki abierto mediante AnkiConnect."""
    clean_deck = deck_name.strip() or "Mandarín - Clips"

    async with httpx.AsyncClient(timeout=15.0) as client:
        # 1. Crear el mazo si no existe
        deck_resp = await client.post(
            anki_connect_url,
            json={"action": "createDeck", "version": 6, "params": {"deck": clean_deck}},
        )
        deck_body = deck_resp.json()
        if deck_body.get("error"):
            raise RuntimeError(f"AnkiConnect error: {deck_body['error']}")

        added_count = 0
        skipped_count = 0

        for phrase in phrases:
            # Subir audio y miniatura a la carpeta media de Anki via storeMediaFile
            audio_tag = ""
            if phrase.clip_audio_path:
                abs_aud = resolve_data_path(settings, phrase.clip_audio_path)
                if abs_aud.is_file():
                    b64_aud = base64.b64encode(abs_aud.read_bytes()).decode("ascii")
                    await client.post(
                        anki_connect_url,
                        json={
                            "action": "storeMediaFile",
                            "version": 6,
                            "params": {"filename": abs_aud.name, "data": b64_aud},
                        },
                    )
                    audio_tag = f"[sound:{abs_aud.name}]"

            thumb_tag = ""
            if phrase.clip_thumb_path:
                abs_img = resolve_data_path(settings, phrase.clip_thumb_path)
                if abs_img.is_file():
                    b64_img = base64.b64encode(abs_img.read_bytes()).decode("ascii")
                    await client.post(
                        anki_connect_url,
                        json={
                            "action": "storeMediaFile",
                            "version": 6,
                            "params": {"filename": abs_img.name, "data": b64_img},
                        },
                    )
                    thumb_tag = f'<img src="{abs_img.name}">'

            video_obj = videos_by_id.get(phrase.video_id)
            video_title = video_obj.title if video_obj else f"Video #{phrase.video_id}"

            front_html = (
                f"{thumb_tag}<br>{audio_tag}"
                f"<div style='font-size:28px;font-weight:bold;margin-top:8px'>{html.escape(phrase.hanzi)}</div>"
            )
            back_html = (
                f"<div style='color:#38bdf8;font-family:monospace;font-size:18px'>{html.escape(phrase.pinyin)}</div>"
                f"<div style='font-size:18px;margin-top:6px'>{html.escape(phrase.translation)}</div>"
                + (
                    f"<div style='font-size:14px;color:#94a3b8;margin-top:6px'>{html.escape(phrase.notes)}</div>"
                    if phrase.notes
                    else ""
                )
                + f"<div style='font-size:12px;color:#64748b;margin-top:10px'>{html.escape(video_title)} ({_format_ms_mmss(phrase.start_ms)})</div>"
            )

            note_resp = await client.post(
                anki_connect_url,
                json={
                    "action": "addNote",
                    "version": 6,
                    "params": {
                        "note": {
                            "deckName": clean_deck,
                            "modelName": "Basic",
                            "fields": {
                                "Front": front_html,
                                "Back": back_html,
                            },
                            "options": {"allowDuplicate": False},
                            "tags": ["mandarin-reactor"],
                        }
                    },
                },
            )
            note_body = note_resp.json()
            if note_body.get("error"):
                skipped_count += 1
            else:
                added_count += 1

        return {"added": added_count, "skipped": skipped_count}
