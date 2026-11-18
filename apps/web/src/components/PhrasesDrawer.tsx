import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useDeletePhrase, usePhrases, useUpdatePhrase } from "../hooks/usePhrases";
import { downloadAnkiApkg, type PhraseRead } from "../lib/api";
import { formatTimestampMs } from "../lib/format";

export interface PhrasesDrawerProps {
  videoId: number;
  onJumpToTimeMs?: (timeMs: number) => void;
}

export const PhrasesDrawer: React.FC<PhrasesDrawerProps> = ({
  videoId,
  onJumpToTimeMs,
}) => {
  const { data: phrases, isLoading } = usePhrases(videoId);
  const updateMutation = useUpdatePhrase();
  const deleteMutation = useDeletePhrase();

  const [playingClipId, setPlayingClipId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTranslation, setEditTranslation] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStartMs, setEditStartMs] = useState(0);
  const [editEndMs, setEditEndMs] = useState(0);

  const startEditing = (p: PhraseRead) => {
    setEditingId(p.id);
    setEditTranslation(p.translation);
    setEditNotes(p.notes ?? "");
    setEditStartMs(p.start_ms);
    setEditEndMs(p.end_ms);
  };

  const handleSaveEdit = async (phraseId: number) => {
    await updateMutation.mutateAsync({
      phraseId,
      payload: {
        translation: editTranslation.trim(),
        notes: editNotes.trim() || null,
        start_ms: editStartMs,
        end_ms: editEndMs,
      },
    });
    setEditingId(null);
  };

  if (isLoading) {
    return (
      <div className="mt-4 rounded-lg border border-line bg-surface/70 p-4">
        <div className="h-5 w-40 animate-pulse rounded bg-surface2" />
      </div>
    );
  }

  const list = phrases ?? [];

  return (
    <section
      aria-label="Frases y clips guardados"
      className="mt-4 rounded-lg border border-line bg-surface/80 p-4 shadow"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Frases guardadas ({list.length})
          </h2>
          <span className="text-[11px] text-ink2">
            Atajo rápido:{" "}
            <kbd className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-accent">
              S
            </kbd>
          </span>
        </div>

        <div className="flex items-center gap-2">
          {list.length > 0 && (
            <button
              type="button"
              onClick={() =>
                void downloadAnkiApkg({
                  video_id: videoId,
                  deck_name: "Mandarín - Clips",
                  include_video: false,
                  card_types: ["listening", "reading"],
                })
              }
              className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-app transition hover:bg-accent/90"
            >
              Exportar mazo (.apkg)
            </button>
          )}
          <Link
            to="/phrases"
            className="rounded-lg border border-lineStrong bg-surface2 px-2.5 py-1 text-xs font-medium text-ink hover:bg-line"
          >
            Ver todas las frases
          </Link>
        </div>
      </div>

      {list.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink2">
          Todavía no guardaste ninguna frase en este video. Pulsá{" "}
          <kbd className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-accent">S</kbd>{" "}
          durante la reproducción o usá el botón «Guardar frase» para extraer el clip con
          ffmpeg.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {list.map((phrase) => {
            const isReady = phrase.clip_status === "ready";
            const isProcessing =
              phrase.clip_status === "pending" || phrase.clip_status === "processing";
            const isEditing = editingId === phrase.id;
            const isPlayingVideo = playingClipId === phrase.id;

            return (
              <article
                key={phrase.id}
                className="flex flex-col justify-between rounded-lg border border-line bg-app/80 p-3 text-xs"
              >
                <div className="flex gap-3">
                  {/* Miniatura o reproductor del clip */}
                  <div className="relative h-20 w-32 shrink-0 overflow-hidden rounded-lg bg-black">
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
                        {isProcessing ? "Cortando clip..." : "Sin vista previa"}
                      </div>
                    )}

                    {isProcessing && (
                      <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded bg-accent/90 px-1.5 py-0.5 text-[10px] font-semibold text-app">
                        <span className="h-2 w-2 animate-spin rounded-full border border-line border-t-transparent" />
                        ffmpeg…
                      </span>
                    )}
                  </div>

                  {/* Texto, pinyin y traducción */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-cjk text-base font-semibold text-white">
                        {phrase.hanzi}
                      </span>
                      {phrase.focus_word && (
                        <span className="rounded bg-accent/20 px-1.5 py-0.5 font-cjk text-[11px] font-semibold text-accent">
                          Foco: {phrase.focus_word}
                        </span>
                      )}
                    </div>

                    <p className="mt-0.5 font-mono text-[11px] text-accent">
                      {phrase.pinyin}
                    </p>
                    <p className="mt-1 text-xs text-ink">{phrase.translation}</p>
                    {phrase.notes && (
                      <p className="mt-1 text-[11px] italic text-ink2">
                        Nota: {phrase.notes}
                      </p>
                    )}
                  </div>
                </div>

                {isEditing && (
                  <div className="mt-3 space-y-2 border-t border-line pt-2.5">
                    <div>
                      <label className="block text-[11px] text-ink2">Traducción</label>
                      <input
                        type="text"
                        value={editTranslation}
                        onChange={(e) => setEditTranslation(e.target.value)}
                        className="mt-0.5 w-full rounded border border-lineStrong bg-surface px-2 py-1 text-xs text-ink"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-ink2">Notas</label>
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        className="mt-0.5 w-full rounded border border-lineStrong bg-surface px-2 py-1 text-xs text-ink"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] text-ink2">
                        Inicio (ms):
                        <input
                          type="number"
                          value={editStartMs}
                          onChange={(e) =>
                            setEditStartMs(
                              Math.max(0, Number.parseInt(e.target.value, 10) || 0),
                            )
                          }
                          className="ml-1 w-20 rounded border border-lineStrong bg-surface px-1.5 py-0.5 font-mono text-xs"
                        />
                      </label>
                      <label className="text-[11px] text-ink2">
                        Fin (ms):
                        <input
                          type="number"
                          value={editEndMs}
                          onChange={(e) =>
                            setEditEndMs(
                              Math.max(
                                editStartMs + 200,
                                Number.parseInt(e.target.value, 10) || editStartMs + 200,
                              ),
                            )
                          }
                          className="ml-1 w-20 rounded border border-lineStrong bg-surface px-1.5 py-0.5 font-mono text-xs"
                        />
                      </label>
                    </div>
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded bg-surface2 px-2.5 py-1 text-ink"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSaveEdit(phrase.id)}
                        className="rounded bg-accent px-2.5 py-1 font-semibold text-app"
                      >
                        Guardar cambios
                      </button>
                    </div>
                  </div>
                )}

                {/* Controles del clip */}
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2">
                  <button
                    type="button"
                    onClick={() => onJumpToTimeMs?.(phrase.start_ms)}
                    className="font-mono text-[11px] text-ink2 hover:text-accent"
                  >
                    ⏱ {formatTimestampMs(phrase.start_ms)} –{" "}
                    {formatTimestampMs(phrase.end_ms)}
                  </button>

                  <div className="flex flex-wrap items-center gap-1.5">
                    {isReady && phrase.clip_video_url && (
                      <button
                        type="button"
                        onClick={() =>
                          setPlayingClipId((id) => (id === phrase.id ? null : phrase.id))
                        }
                        className="rounded bg-accent/20 px-2 py-0.5 font-medium text-accent hover:bg-accent/30"
                      >
                        {isPlayingVideo ? "Cerrar clip" : "Ver clip"}
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

                    <button
                      type="button"
                      onClick={() => startEditing(phrase)}
                      className="rounded bg-surface2 px-2 py-0.5 text-ink hover:text-white"
                    >
                      Editar
                    </button>

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
    </section>
  );
};
