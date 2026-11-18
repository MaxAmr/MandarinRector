import { X } from "lucide-react";
import React, { useEffect, useState } from "react";
import { useCreatePhrase, useTranslateText } from "../hooks/usePhrases";
import type { CueRead, PhraseRead } from "../lib/api";
import { formatTimestampMs } from "../lib/format";
import { tokensToPinyinString } from "../lib/tokens";

export interface SavePhraseInitialData {
  videoId: number;
  trackId: number | null;
  cue: CueRead;
  rawCueStartMs: number;
  rawCueEndMs: number;
  trackOffsetMs: number;
  focusWord?: string | null;
  defaultTranslation?: string | null;
  defaultNotes?: string | null;
}

export interface SavePhraseModalProps {
  isOpen: boolean;
  initialData: SavePhraseInitialData | null;
  onClose: () => void;
  onSaved?: (phrase: PhraseRead) => void;
}

function formatMsPrecise(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hundredths = Math.floor((safe % 1000) / 10);
  return `${formatTimestampMs(safe)}.${String(hundredths).padStart(2, "0")}`;
}

export const SavePhraseModal: React.FC<SavePhraseModalProps> = ({
  isOpen,
  initialData,
  onClose,
  onSaved,
}) => {
  const createMutation = useCreatePhrase();
  const translateMutation = useTranslateText();

  const [hanzi, setHanzi] = useState("");
  const [focusWord, setFocusWord] = useState("");
  const [pinyin, setPinyin] = useState("");
  const [translation, setTranslation] = useState("");
  const [notes, setNotes] = useState("");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(2000);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!initialData) {
      return;
    }
    const { cue, focusWord: fw, defaultTranslation, defaultNotes } = initialData;
    setHanzi(cue.text);
    setFocusWord(fw ?? "");
    const derivedPinyin = cue.tokens ? tokensToPinyinString(cue.tokens) : "";
    setPinyin(derivedPinyin);
    setTranslation(defaultTranslation ?? "");
    setNotes(defaultNotes ?? "");
    // Aplicar margen automático de ±300 ms sobre los tiempos del cue
    const defaultStart = Math.max(0, Math.round(cue.start_ms - 300));
    const defaultEnd = Math.max(defaultStart + 400, Math.round(cue.end_ms + 300));
    setStartMs(defaultStart);
    setEndMs(defaultEnd);
    setErrorMsg(null);
    // Sin traducción emparejada: pedirla automáticamente al backend.
    if (!defaultTranslation && cue.text.trim()) {
      let cancelled = false;
      translateMutation
        .mutateAsync({ text: cue.text.trim(), targetLang: "es" })
        .then((res) => {
          if (!cancelled) {
            setTranslation((prev) => (prev ? prev : res.translated_text));
          }
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialData]);

  if (!isOpen || !initialData) {
    return null;
  }

  const handleResetTimes = () => {
    const defaultStart = Math.max(0, Math.round(initialData.cue.start_ms - 300));
    const defaultEnd = Math.max(
      defaultStart + 400,
      Math.round(initialData.cue.end_ms + 300),
    );
    setStartMs(defaultStart);
    setEndMs(defaultEnd);
  };

  const adjustStart = (deltaMs: number) => {
    setStartMs((prev) => {
      const next = Math.max(0, prev + deltaMs);
      return Math.min(next, endMs - 200);
    });
  };

  const adjustEnd = (deltaMs: number) => {
    setEndMs((prev) => Math.max(startMs + 200, prev + deltaMs));
  };

  const handleAutoTranslate = async () => {
    if (!hanzi.trim()) return;
    try {
      const res = await translateMutation.mutateAsync({
        text: hanzi.trim(),
        targetLang: "es",
      });
      setTranslation(res.translated_text);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "No se pudo traducir la frase.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!hanzi.trim()) {
      setErrorMsg("El texto en chino (hanzi) no puede estar vacío.");
      return;
    }
    const cleanStart = Math.max(0, Math.round(startMs));
    const cleanEnd = Math.max(cleanStart + 200, Math.round(endMs));

    try {
      const created = await createMutation.mutateAsync({
        video_id: initialData.videoId,
        track_id: initialData.trackId,
        cue_idx: initialData.cue.idx,
        hanzi: hanzi.trim(),
        focus_word: focusWord.trim() || null,
        pinyin: pinyin.trim() || undefined,
        translation: translation.trim() || undefined,
        notes: notes.trim() || null,
        start_ms: cleanStart,
        end_ms: cleanEnd,
      });
      onSaved?.(created);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Error al guardar la frase.");
    }
  };

  const durationSec = Math.max(0, (endMs - startMs) / 1000).toFixed(2);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-phrase-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 id="save-phrase-modal-title" className="text-base font-semibold text-ink">
            Guardar frase y cortar clip
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar modal de guardar frase"
            className="rounded-lg p-1 text-ink2 hover:bg-surface2 hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-3.5 text-xs">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="block font-medium text-ink">Frase (Hanzi)</label>
              <input
                type="text"
                value={hanzi}
                onChange={(e) => setHanzi(e.target.value)}
                className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-1.5 font-cjk text-sm text-ink focus:border-accent focus:outline-none"
              />
            </div>

            <div>
              <label className="block font-medium text-ink">
                Palabra foco (opcional)
              </label>
              <input
                type="text"
                value={focusWord}
                onChange={(e) => setFocusWord(e.target.value)}
                placeholder="Ej. 热烈"
                className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-1.5 font-cjk text-sm text-accent placeholder-ink2 focus:border-accent focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block font-medium text-ink">Pinyin</label>
            <input
              type="text"
              value={pinyin}
              onChange={(e) => setPinyin(e.target.value)}
              placeholder="Se genera automáticamente desde los tokens"
              className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-1.5 font-mono text-xs text-accent focus:border-accent focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label className="font-medium text-ink">Traducción / Glosa</label>
              <button
                type="button"
                disabled={translateMutation.isPending}
                onClick={handleAutoTranslate}
                className="text-[11px] font-medium text-accent hover:text-accent disabled:opacity-50"
              >
                {translateMutation.isPending
                  ? "Traduciendo..."
                  : "Traducir automáticamente"}
              </button>
            </div>
            <input
              type="text"
              value={translation}
              onChange={(e) => setTranslation(e.target.value)}
              placeholder="Si queda vacío se auto-completa al guardar"
              className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
            />
          </div>

          {/* Rango automático del clip con botones de ajuste fino en segundos */}
          <div className="rounded-lg border border-line bg-app/80 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-ink">
                Rango automático del clip (±0.3s de margen)
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-accent">
                  Duración: {durationSec} s
                </span>
                <button
                  type="button"
                  onClick={handleResetTimes}
                  className="rounded bg-surface2 px-2 py-0.5 text-[10px] text-ink hover:text-white"
                >
                  Restablecer
                </button>
              </div>
            </div>

            <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-line/90 bg-surface/60 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink2">Inicio:</span>
                  <span className="font-mono text-xs font-semibold text-white">
                    {formatMsPrecise(startMs)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => adjustStart(-500)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    −0.5s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustStart(-100)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    −0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustStart(100)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    +0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustStart(500)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    +0.5s
                  </button>
                </div>
              </div>

              <div className="rounded-lg border border-line/90 bg-surface/60 p-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-ink2">Fin:</span>
                  <span className="font-mono text-xs font-semibold text-white">
                    {formatMsPrecise(endMs)}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => adjustEnd(-500)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    −0.5s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustEnd(-100)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    −0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustEnd(100)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    +0.1s
                  </button>
                  <button
                    type="button"
                    onClick={() => adjustEnd(500)}
                    className="flex-1 rounded bg-surface2 py-1 text-[11px] text-ink hover:bg-line"
                  >
                    +0.5s
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div>
            <label className="block font-medium text-ink">
              Notas personales (opcional)
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Apuntes de gramática, contexto o definición..."
              className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-1.5 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none"
            />
          </div>

          {errorMsg && (
            <p role="alert" className="text-xs text-rose-400">
              {errorMsg}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-surface2 px-4 py-2 text-xs font-medium text-ink hover:bg-line"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app hover:bg-accent/90 disabled:opacity-50"
            >
              {createMutation.isPending ? "Guardando..." : "Guardar y generar clip"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
