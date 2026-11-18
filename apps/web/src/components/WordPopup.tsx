import { X } from "lucide-react";
import React, { useEffect, useMemo, useRef } from "react";
import { useDictionaryWord, useImportDictionary } from "../hooks/useDictionary";
import type { DictionaryEntryRead } from "../lib/api";
import { useStudyStore } from "../store/studyStore";
import type { WordActivateInfo } from "./CueText";

export interface WordPopupProps {
  activeWord: WordActivateInfo | null;
  onClose: () => void;
  onSaveWordPhrase?: (info: {
    word: string;
    cueIdx: number;
    topDefinition: string | null;
  }) => void;
  onMouseEnterPopup?: () => void;
  onMouseLeavePopup?: () => void;
}

const POPUP_WIDTH = 340;
const POPUP_MARGIN = 10;

function formatEntryPinyin(
  entry: DictionaryEntryRead,
  style: "marks" | "numbers",
): string {
  return style === "numbers" ? entry.pinyin_numeric : entry.pinyin_marks;
}

export const WordPopup: React.FC<WordPopupProps> = ({
  activeWord,
  onClose,
  onSaveWordPhrase,
  onMouseEnterPopup,
  onMouseLeavePopup,
}) => {
  const popupRef = useRef<HTMLDivElement | null>(null);
  const pinyinStyle = useStudyStore((s) => s.pinyinStyle);

  const { data, isLoading, isError, error } = useDictionaryWord(activeWord?.word ?? null);
  const importMutation = useImportDictionary();

  // Cerrar con Escape o click fuera del popup y fuera de palabras .zh-word
  useEffect(() => {
    if (!activeWord) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (popupRef.current?.contains(target)) {
        return;
      }
      if (target.closest(".zh-word")) {
        return;
      }
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [activeWord, onClose]);

  const positionStyle = useMemo<React.CSSProperties>(() => {
    if (!activeWord || typeof window === "undefined") {
      return {};
    }
    const rect = activeWord.anchorRect;
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    const centeredLeft = rect.left + rect.width / 2 - POPUP_WIDTH / 2;
    const left = Math.max(
      POPUP_MARGIN,
      Math.min(viewportW - POPUP_WIDTH - POPUP_MARGIN, centeredLeft),
    );

    const preferAbove = activeWord.source === "overlay" || rect.bottom + 260 > viewportH;

    if (preferAbove && rect.top > 180) {
      return {
        position: "fixed",
        left: `${left}px`,
        bottom: `${Math.max(POPUP_MARGIN, viewportH - rect.top + 8)}px`,
        width: `${POPUP_WIDTH}px`,
      };
    }

    return {
      position: "fixed",
      left: `${left}px`,
      top: `${Math.min(viewportH - 120, rect.bottom + 8)}px`,
      width: `${POPUP_WIDTH}px`,
    };
  }, [activeWord]);

  if (!activeWord) {
    return null;
  }

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label={`Diccionario: ${activeWord.word}`}
      style={positionStyle}
      onMouseEnter={onMouseEnterPopup}
      onMouseLeave={onMouseLeavePopup}
      onClick={(e) => e.stopPropagation()}
      className="z-50 max-h-[340px] overflow-y-auto rounded-lg border border-lineStrong bg-surface/95 p-3.5 text-left text-xs text-ink shadow-2xl backdrop-blur-md"
    >
      {/* Cabecera */}
      <div className="flex items-start justify-between gap-2 border-b border-line pb-2">
        <div className="flex items-baseline gap-2">
          <span className="font-cjk text-xl font-bold text-accent">
            {activeWord.word}
          </span>
          {data?.entries[0] &&
            data.entries[0].traditional !== data.entries[0].simplified && (
              <span className="font-cjk text-xs text-ink2">
                (
                {activeWord.word === data.entries[0].traditional
                  ? data.entries[0].simplified
                  : data.entries[0].traditional}
                )
              </span>
            )}
        </div>

        <div className="flex items-center gap-1.5">
          {onSaveWordPhrase && (
            <button
              type="button"
              onClick={() => {
                const topDef = data?.entries[0]
                  ? `${data.entries[0].pinyin_marks}: ${data.entries[0].definitions.slice(0, 2).join("; ")}`
                  : null;
                onSaveWordPhrase({
                  word: activeWord.word,
                  cueIdx: activeWord.cueIdx,
                  topDefinition: topDef,
                });
              }}
              className="rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-app transition hover:bg-accent/90"
            >
              Guardar frase
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar diccionario (Esc)"
            className="rounded-md px-1.5 py-0.5 text-ink2 hover:bg-surface2 hover:text-white"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Cuerpo */}
      <div className="mt-2.5 space-y-2.5">
        {isLoading && (
          <div className="space-y-2 py-2">
            <div className="h-3 w-28 animate-pulse rounded bg-surface2" />
            <div className="h-3 w-full animate-pulse rounded bg-surface2" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-surface2" />
          </div>
        )}

        {isError && (
          <p className="text-rose-400">
            {error instanceof Error
              ? error.message
              : "Error al consultar el diccionario."}
          </p>
        )}

        {data && !data.dictionary_loaded && (
          <div className="space-y-2 rounded-lg border border-accent/30 bg-accent/10 p-2.5">
            <p className="text-accent">
              El diccionario CC-CEDICT aún no está cargado en la base de datos.
            </p>
            <button
              type="button"
              disabled={importMutation.isPending}
              onClick={() => importMutation.mutate(true)}
              className="w-full rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-app transition hover:bg-accent/90 disabled:opacity-50"
            >
              {importMutation.isPending
                ? "Descargando e importando (~10 MB)..."
                : "Descargar e importar CC-CEDICT"}
            </button>
            {importMutation.isError && (
              <p className="text-[11px] text-rose-300">
                {importMutation.error instanceof Error
                  ? importMutation.error.message
                  : "No se pudo importar CC-CEDICT."}
              </p>
            )}
          </div>
        )}

        {data && data.dictionary_loaded && data.entries.length === 0 && (
          <p className="text-ink2">
            Sin entrada exacta para «{data.query}» en CC-CEDICT.
          </p>
        )}

        {/* Entradas exactas de la palabra */}
        {data && data.entries.length > 0 && (
          <div className="space-y-2">
            {data.entries.map((entry) => (
              <div key={entry.id} className="rounded-lg bg-app/70 px-2.5 py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-accent">
                    {formatEntryPinyin(entry, pinyinStyle)}
                  </span>
                  {entry.traditional !== entry.simplified && (
                    <span className="font-cjk text-[11px] text-ink2">
                      {entry.simplified} / {entry.traditional}
                    </span>
                  )}
                </div>

                <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-ink">
                  {entry.definitions.map((def, idx) => (
                    <li key={idx}>{def}</li>
                  ))}
                </ol>

                {entry.classifiers.length > 0 && (
                  <p className="mt-1 text-[11px] text-accent/90">
                    Clasificadores: {entry.classifiers.join(", ")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Desglose carácter por carácter */}
        {data && data.char_entries.length > 0 && (
          <div className="border-t border-line pt-2">
            <h4 className="mb-1.5 text-[10px] font-semibold text-ink2">
              Desglose por carácter
            </h4>
            <div className="space-y-1.5">
              {data.char_entries.map((item) => {
                const top = item.entries[0];
                if (!top) return null;
                return (
                  <div
                    key={item.char}
                    className="flex items-start gap-2 rounded-md bg-app/50 px-2 py-1"
                  >
                    <span className="font-cjk text-sm font-semibold text-accent">
                      {item.char}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-[11px] text-accent">
                        {formatEntryPinyin(top, pinyinStyle)}
                      </span>
                      <p className="line-clamp-2 text-[11px] text-ink">
                        {top.definitions.slice(0, 3).join("; ")}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
