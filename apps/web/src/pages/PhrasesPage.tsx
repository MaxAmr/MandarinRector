import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDeletePhrase, usePhrases, useUpdatePhrase } from "../hooks/usePhrases";
import { useVideos } from "../hooks/useVideos";
import {
  downloadAnkiApkg,
  exportToAnkiConnect,
  type AnkiCardType,
  type PhraseRead,
} from "../lib/api";
import { formatTimestampMs } from "../lib/format";

export const PhrasesPage: React.FC = () => {
  const { data: videos } = useVideos();
  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");

  const { data: phrases, isLoading } = usePhrases(selectedVideoId, searchInput);
  const updateMutation = useUpdatePhrase();
  const deleteMutation = useDeletePhrase();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [playingClipId, setPlayingClipId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editHanzi, setEditHanzi] = useState("");
  const [editPinyin, setEditPinyin] = useState("");
  const [editTranslation, setEditTranslation] = useState("");
  const [editNotes, setEditNotes] = useState("");

  // Opciones de exportación Anki
  const [deckName, setDeckName] = useState("Mandarín - Clips");
  const [cardTypes, setCardTypes] = useState<Set<AnkiCardType>>(
    () => new Set<AnkiCardType>(["listening", "reading"]),
  );
  const [includeVideo, setIncludeVideo] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<{
    type: "ok" | "err";
    text: string;
  } | null>(null);

  const videosById = useMemo(() => {
    const map = new Map<number, string>();
    for (const v of videos ?? []) {
      map.set(v.id, v.title);
    }
    return map;
  }, [videos]);

  const list = phrases ?? [];

  const toggleSelectPhrase = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === list.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(list.map((p) => p.id)));
    }
  };

  const toggleCardType = (ct: AnkiCardType) => {
    setCardTypes((prev) => {
      const next = new Set(prev);
      if (next.has(ct)) {
        if (next.size > 1) {
          next.delete(ct);
        }
      } else {
        next.add(ct);
      }
      return next;
    });
  };

  const handleDownloadApkg = async () => {
    setIsExporting(true);
    setExportFeedback(null);
    try {
      await downloadAnkiApkg({
        video_id: selectedVideoId,
        phrase_ids: selectedIds.size > 0 ? Array.from(selectedIds) : null,
        deck_name: deckName.trim() || "Mandarín - Clips",
        include_video: includeVideo,
        card_types: Array.from(cardTypes),
      });
      setExportFeedback({
        type: "ok",
        text: "Mazo .apkg generado y descargado correctamente.",
      });
    } catch (err) {
      setExportFeedback({
        type: "err",
        text: err instanceof Error ? err.message : "Error al exportar el mazo .apkg",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const handleAnkiConnect = async () => {
    setIsExporting(true);
    setExportFeedback(null);
    try {
      const res = await exportToAnkiConnect({
        video_id: selectedVideoId,
        phrase_ids: selectedIds.size > 0 ? Array.from(selectedIds) : null,
        deck_name: deckName.trim() || "Mandarín - Clips",
        include_video: includeVideo,
        card_types: Array.from(cardTypes),
      });
      setExportFeedback({
        type: "ok",
        text: `Enviado a AnkiConnect (${res.deck_name}): ${res.added} agregada(s), ${res.skipped} omitida(s).`,
      });
    } catch (err) {
      setExportFeedback({
        type: "err",
        text: err instanceof Error ? err.message : "No se pudo conectar con AnkiConnect.",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const startEditing = (p: PhraseRead) => {
    setEditingId(p.id);
    setEditHanzi(p.hanzi);
    setEditPinyin(p.pinyin);
    setEditTranslation(p.translation);
    setEditNotes(p.notes ?? "");
  };

  const saveEdit = async (phraseId: number) => {
    await updateMutation.mutateAsync({
      phraseId,
      payload: {
        hanzi: editHanzi.trim(),
        pinyin: editPinyin.trim(),
        translation: editTranslation.trim(),
        notes: editNotes.trim() || null,
      },
    });
    setEditingId(null);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Cabecera */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink transition hover:border-lineStrong hover:text-white"
          >
            Biblioteca de videos
          </Link>
          <div>
            <h1 className="text-xl font-bold text-white">Frases y exportación a Anki</h1>
            <p className="text-xs text-ink2">
              Revisá tus clips minados, editá notas y exportá tu mazo <code>.apkg</code>{" "}
              para Anki Desktop, AnkiDroid o iOS
            </p>
          </div>
        </div>
      </header>

      {/* Panel de configuración de exportación a Anki */}
      <section
        aria-label="Exportar a Anki"
        className="mb-6 rounded-lg border border-accent/30 bg-surface/90 p-5 shadow-xl"
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="space-y-2 lg:col-span-4">
            <label
              htmlFor="anki-deck-name"
              className="block text-xs font-semibold text-ink"
            >
              Nombre del mazo en Anki
            </label>
            <input
              id="anki-deck-name"
              type="text"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="Mandarín - Clips"
              className="w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
            />
            <p className="text-[11px] text-ink2">
              Podés usar <code>::</code> para crear submazos (ej.{" "}
              <code>Mandarín::Serie 1</code>).
            </p>
          </div>

          <div className="space-y-2 lg:col-span-5">
            <span className="block text-xs font-semibold text-ink">
              Tipos de tarjeta a generar por frase
            </span>
            <div className="flex flex-wrap gap-3 text-xs text-ink">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={cardTypes.has("listening")}
                  onChange={() => toggleCardType("listening")}
                  className="h-4 w-4 rounded border-lineStrong bg-app text-accent"
                />
                <span>Escucha: audio y captura, luego lectura</span>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={cardTypes.has("reading")}
                  onChange={() => toggleCardType("reading")}
                  className="h-4 w-4 rounded border-lineStrong bg-app text-accent"
                />
                <span>Lectura: del hanzi al significado</span>
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={cardTypes.has("production")}
                  onChange={() => toggleCardType("production")}
                  className="h-4 w-4 rounded border-lineStrong bg-app text-accent"
                />
                <span>Producción: de la traducción al hanzi</span>
              </label>
            </div>

            <label className="mt-2 flex cursor-pointer items-center gap-2 pt-1 text-xs text-ink2">
              <input
                type="checkbox"
                checked={includeVideo}
                onChange={(e) => setIncludeVideo(e.target.checked)}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent"
              />
              <span>
                Incluir también archivo de video <code>.mp4</code> en la tarjeta
                (recomendado solo para Anki Desktop; imagen <code>.jpg</code> + audio{" "}
                <code>.mp3</code> siempre se incluyen)
              </span>
            </label>
          </div>

          <div className="flex flex-col justify-end gap-2 lg:col-span-3">
            <button
              type="button"
              disabled={isExporting || list.length === 0}
              onClick={() => void handleDownloadApkg()}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-xs font-semibold text-app shadow-lg transition hover:bg-accent/90 disabled:opacity-50"
            >
              {isExporting
                ? "Generando mazo..."
                : selectedIds.size > 0
                  ? `Exportar ${selectedIds.size} seleccionada(s) (.apkg)`
                  : `Exportar ${list.length} frase(s) (.apkg)`}
            </button>

            <button
              type="button"
              disabled={isExporting || list.length === 0}
              onClick={() => void handleAnkiConnect()}
              className="w-full rounded-lg border border-lineStrong bg-surface2 px-4 py-2 text-xs font-medium text-ink transition hover:bg-line disabled:opacity-50"
            >
              Enviar por AnkiConnect
            </button>
          </div>
        </div>

        {exportFeedback && (
          <div
            role="status"
            className={`mt-3 rounded-lg px-3 py-2 text-xs ${
              exportFeedback.type === "ok"
                ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
            }`}
          >
            {exportFeedback.text}
          </div>
        )}
      </section>

      {/* Filtros de búsqueda y selección */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar por hanzi, pinyin, traducción o nota..."
            className="w-72 rounded-lg border border-lineStrong bg-surface px-3.5 py-2 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none"
          />

          <select
            aria-label="Filtrar por video"
            value={selectedVideoId ?? ""}
            onChange={(e) =>
              setSelectedVideoId(
                e.target.value ? Number.parseInt(e.target.value, 10) : null,
              )
            }
            className="rounded-lg border border-lineStrong bg-surface px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
          >
            <option value="">Todos los videos</option>
            {(videos ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
        </div>

        {list.length > 0 && (
          <button
            type="button"
            onClick={toggleSelectAll}
            className="text-xs text-ink2 hover:text-accent"
          >
            {selectedIds.size === list.length
              ? "Deseleccionar todas"
              : `Seleccionar todas (${list.length})`}
          </button>
        )}
      </div>

      {/* Lista de tarjetas de frases */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-lg bg-surface/70" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface/30 py-14 text-center text-xs text-ink2">
          No hay frases guardadas que coincidan con el filtro actual.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {list.map((phrase) => {
            const isSelected = selectedIds.has(phrase.id);
            const isReady = phrase.clip_status === "ready";
            const isEditing = editingId === phrase.id;
            const isPlayingVideo = playingClipId === phrase.id;
            const videoTitle =
              videosById.get(phrase.video_id) ?? `Video #${phrase.video_id}`;

            return (
              <article
                key={phrase.id}
                className={`flex flex-col justify-between rounded-lg border p-4 text-xs transition ${
                  isSelected
                    ? "border-accent/70 bg-accent/5"
                    : "border-line bg-surface/80"
                }`}
              >
                <div className="flex gap-3.5">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelectPhrase(phrase.id)}
                    aria-label={`Seleccionar ${phrase.hanzi}`}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-lineStrong bg-app text-accent"
                  />

                  <div className="relative h-24 w-36 shrink-0 overflow-hidden rounded-lg bg-black">
                    {isPlayingVideo && phrase.clip_video_url ? (
                      <video
                        src={phrase.clip_video_url}
                        controls
                        autoPlay
                        className="h-full w-full object-contain"
                      />
                    ) : phrase.clip_thumb_url ? (
                      <img
                        src={phrase.clip_thumb_url}
                        alt={phrase.hanzi}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-[10px] text-ink2">
                        Procesando clip...
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <div className="space-y-1.5">
                        <input
                          type="text"
                          value={editHanzi}
                          onChange={(e) => setEditHanzi(e.target.value)}
                          className="w-full rounded border border-lineStrong bg-app px-2 py-1 font-cjk text-sm text-white"
                        />
                        <input
                          type="text"
                          value={editPinyin}
                          onChange={(e) => setEditPinyin(e.target.value)}
                          className="w-full rounded border border-lineStrong bg-app px-2 py-1 font-mono text-xs text-accent"
                        />
                        <input
                          type="text"
                          value={editTranslation}
                          onChange={(e) => setEditTranslation(e.target.value)}
                          className="w-full rounded border border-lineStrong bg-app px-2 py-1 text-xs text-ink"
                        />
                        <input
                          type="text"
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          placeholder="Notas..."
                          className="w-full rounded border border-lineStrong bg-app px-2 py-1 text-xs text-ink"
                        />
                        <div className="flex justify-end gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded bg-surface2 px-2.5 py-1 text-ink"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveEdit(phrase.id)}
                            className="rounded bg-accent px-2.5 py-1 font-semibold text-app"
                          >
                            Guardar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-cjk text-lg font-bold text-white">
                            {phrase.hanzi}
                          </span>
                          {phrase.focus_word && (
                            <span className="rounded bg-accent/20 px-1.5 py-0.5 font-cjk text-[11px] font-semibold text-accent">
                              Foco: {phrase.focus_word}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 font-mono text-xs text-accent">
                          {phrase.pinyin}
                        </p>
                        <p className="mt-1 text-xs text-ink">{phrase.translation}</p>
                        {phrase.notes && (
                          <p className="mt-1 text-[11px] italic text-ink2">
                            Nota: {phrase.notes}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/80 pt-2.5">
                  <Link
                    to={`/watch/${phrase.video_id}`}
                    className="text-[11px] text-ink2 hover:text-accent"
                  >
                    {videoTitle} ({formatTimestampMs(phrase.start_ms)})
                  </Link>

                  <div className="flex items-center gap-1.5">
                    {isReady && phrase.clip_video_url && (
                      <button
                        type="button"
                        onClick={() =>
                          setPlayingClipId((id) => (id === phrase.id ? null : phrase.id))
                        }
                        className="rounded bg-accent/20 px-2 py-0.5 font-medium text-accent hover:bg-accent/30"
                      >
                        {isPlayingVideo ? "Cerrar video" : "Video"}
                      </button>
                    )}

                    {isReady && phrase.clip_audio_url && (
                      <button
                        type="button"
                        onClick={() => {
                          const audio = new Audio(phrase.clip_audio_url!);
                          void audio.play();
                        }}
                        className="rounded bg-accent/20 px-2 py-0.5 font-medium text-accent hover:bg-accent/30"
                      >
                        Audio
                      </button>
                    )}

                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => startEditing(phrase)}
                        className="rounded bg-surface2 px-2 py-0.5 text-ink hover:text-white"
                      >
                        Editar
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => deleteMutation.mutate(phrase.id)}
                      className="rounded bg-rose-950/60 px-2 py-0.5 text-rose-300 hover:bg-rose-900/60"
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
