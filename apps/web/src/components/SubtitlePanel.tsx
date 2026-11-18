import { X } from "lucide-react";
import { S } from "../lib/strings";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChineseScript, CueRead } from "../lib/api";
import { findBestOverlapIndex, findCueIndexAt } from "../lib/cues";
import { formatTimestampMs } from "../lib/format";
import { useClockSelector } from "../lib/playbackClock";
import { useStudyStore, type PinyinStyle } from "../store/studyStore";
import { CueText, type WordActivateInfo } from "./CueText";

interface CueRowProps {
  cue: CueRead;
  secondaryText: string | null;
  primaryLang: string;
  primaryScript: ChineseScript;
  secondaryLang: string;
  isActive: boolean;
  isLooping: boolean;
  showPinyin: boolean;
  colorTones: boolean;
  pinyinStyle: PinyinStyle;
  pinyinScale: number;
  highlightQuery: string;
  onSelectCue: (cue: CueRead) => void;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
}

const CueRow = React.memo(
  function CueRow({
    cue,
    secondaryText,
    primaryLang,
    primaryScript,
    secondaryLang,
    isActive,
    isLooping,
    showPinyin,
    colorTones,
    pinyinStyle,
    pinyinScale,
    highlightQuery,
    onSelectCue,
    onWordActivate,
    onWordHover,
  }: CueRowProps) {
    return (
      <button
        type="button"
        role="listitem"
        aria-current={isActive ? "true" : undefined}
        onClick={() => onSelectCue(cue)}
        className={`flex w-full items-start gap-3 border-b border-line/60 border-l-2 px-3.5 py-2.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
          isActive
            ? "border-l-accent bg-surface2"
            : "border-l-transparent hover:bg-surface2/50"
        }`}
      >
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span
            className={`font-mono text-xs ${
              isActive ? "font-semibold text-accent" : "text-ink2"
            }`}
          >
            {formatTimestampMs(cue.start_ms)}
          </span>
          {isLooping && (
            <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              LOOP
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className={`font-cjk text-base leading-relaxed select-text ${
              isActive ? "text-ink" : "text-ink/80"
            }`}
          >
            <CueText
              text={cue.text}
              tokens={highlightQuery ? undefined : cue.tokens}
              lang={primaryLang}
              script={primaryScript}
              variant="panel"
              showPinyin={showPinyin}
              colorTones={colorTones}
              pinyinStyle={pinyinStyle}
              pinyinScale={pinyinScale}
              cueIdx={cue.idx}
              highlightQuery={highlightQuery}
              onWordActivate={onWordActivate}
              onWordHover={onWordHover}
            />
          </div>
          {secondaryText && (
            <div className="mt-1 text-xs leading-relaxed text-ink2 select-text">
              <CueText
                text={secondaryText}
                lang={secondaryLang}
                variant="panel"
                showPinyin={false}
                colorTones={false}
                highlightQuery={highlightQuery}
              />
            </div>
          )}
        </div>
      </button>
    );
  },
  (prev, next) =>
    prev.isActive === next.isActive &&
    prev.isLooping === next.isLooping &&
    prev.cue === next.cue &&
    prev.secondaryText === next.secondaryText &&
    prev.showPinyin === next.showPinyin &&
    prev.colorTones === next.colorTones &&
    prev.pinyinStyle === next.pinyinStyle &&
    prev.pinyinScale === next.pinyinScale &&
    prev.highlightQuery === next.highlightQuery &&
    prev.primaryLang === next.primaryLang &&
    prev.primaryScript === next.primaryScript &&
    prev.secondaryLang === next.secondaryLang &&
    prev.onSelectCue === next.onSelectCue &&
    prev.onWordActivate === next.onWordActivate &&
    prev.onWordHover === next.onWordHover,
);

export interface SubtitlePanelProps {
  hasTracks: boolean;
  isLoading: boolean;
  error: string | null;
  primaryCues: readonly CueRead[];
  primaryLang?: string;
  primaryScript?: ChineseScript;
  secondaryCues: readonly CueRead[];
  secondaryLang?: string;
  onSeekAndPlay: (cue: CueRead) => void;
  onOpenUploadDialog: () => void;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
}

export const SubtitlePanel: React.FC<SubtitlePanelProps> = ({
  hasTracks,
  isLoading,
  error,
  primaryCues,
  primaryLang = "zh",
  primaryScript = null,
  secondaryCues,
  secondaryLang = "es",
  onSeekAndPlay,
  onOpenUploadDialog,
  onWordActivate,
  onWordHover,
}) => {
  const showSecondary = useStudyStore((s) => s.showSecondary);
  const followActive = useStudyStore((s) => s.followActive);
  const setFollowActive = useStudyStore((s) => s.setFollowActive);
  const loopCueIdx = useStudyStore((s) => s.loopCueIdx);
  const showPinyinPanel = useStudyStore((s) => s.showPinyinPanel);
  const colorTones = useStudyStore((s) => s.colorTones);
  const toneColorScope = useStudyStore((s) => s.toneColorScope);
  const pinyinStyle = useStudyStore((s) => s.pinyinStyle);
  const pinyinScale = useStudyStore((s) => s.pinyinScale);

  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedQuery(searchInput.trim());
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // Precalcular el texto secundario emparejado para cada cue primario
  const pairedSecondaryByIdx = useMemo(() => {
    if (!showSecondary) {
      return new Map<number, string>();
    }
    const map = new Map<number, string>();
    for (const cue of primaryCues) {
      if (secondaryCues.length > 0) {
        const matchIdx = findBestOverlapIndex(cue, secondaryCues);
        if (matchIdx !== null) {
          map.set(cue.idx, secondaryCues[matchIdx].text);
          continue;
        }
      }
      if (cue.translation_text) {
        map.set(cue.idx, cue.translation_text);
      }
    }
    return map;
  }, [primaryCues, secondaryCues, showSecondary]);

  const filteredCues = useMemo(() => {
    if (!debouncedQuery) {
      return primaryCues;
    }
    const lower = debouncedQuery.toLowerCase();
    return primaryCues.filter((cue) => {
      if (cue.text.toLowerCase().includes(lower)) {
        return true;
      }
      const secText = pairedSecondaryByIdx.get(cue.idx);
      return secText ? secText.toLowerCase().includes(lower) : false;
    });
  }, [primaryCues, debouncedQuery, pairedSecondaryByIdx]);

  // Suscripción primitiva: solo cambia cuando cambia el índice sticky en primaryCues
  const stickyArrayIdx = useClockSelector((timeMs) =>
    findCueIndexAt(primaryCues, timeMs),
  );
  const activeCueOrdinalIdx =
    stickyArrayIdx >= 0 && stickyArrayIdx < primaryCues.length
      ? primaryCues[stickyArrayIdx].idx
      : -1;

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const isProgrammaticScrollRef = useRef(false);

  const virtualizer = useVirtualizer({
    count: filteredCues.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => (showPinyinPanel ? 82 : 68),
    overscan: 8,
    scrollPaddingStart: 8,
    scrollPaddingEnd: 8,
  });

  const scrollToActiveCue = useCallback(
    (smooth = true) => {
      if (stickyArrayIdx < 0 || debouncedQuery) {
        return;
      }
      isProgrammaticScrollRef.current = true;
      virtualizer.scrollToIndex(stickyArrayIdx, {
        align: "center",
        behavior: smooth ? "smooth" : "auto",
      });
      window.setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 350);
    },
    [stickyArrayIdx, debouncedQuery, virtualizer],
  );

  useEffect(() => {
    if (followActive && !debouncedQuery && stickyArrayIdx >= 0) {
      scrollToActiveCue(true);
    }
  }, [followActive, debouncedQuery, stickyArrayIdx, scrollToActiveCue]);

  const suspendFollowOnUserScroll = useCallback(() => {
    if (!isProgrammaticScrollRef.current && followActive) {
      setFollowActive(false);
    }
  }, [followActive, setFollowActive]);

  const handleSelectCue = useCallback(
    (cue: CueRead) => {
      setFollowActive(true);
      onSeekAndPlay(cue);
    },
    [onSeekAndPlay, setFollowActive],
  );

  const handleResumeFollow = useCallback(() => {
    setFollowActive(true);
    scrollToActiveCue(true);
  }, [setFollowActive, scrollToActiveCue]);

  const handleClearSearch = useCallback(() => {
    setSearchInput("");
    setDebouncedQuery("");
    setFollowActive(true);
  }, [setFollowActive]);

  if (isLoading) {
    return (
      <aside
        aria-label="Panel de subtítulos cargando"
        className="flex h-full min-h-[320px] flex-col rounded-lg border border-line bg-surface p-4"
      >
        <div className="mb-3 h-9 animate-pulse rounded-lg bg-surface2" />
        <div className="space-y-2.5">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="h-14 animate-pulse rounded-lg bg-surface2/70" />
          ))}
        </div>
      </aside>
    );
  }

  if (error) {
    return (
      <aside
        role="alert"
        className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-lg border border-rose-500/40 bg-surface p-6 text-center"
      >
        <p className="text-sm font-semibold text-rose-400">
          Error al cargar los subtítulos
        </p>
        <p className="mt-1 text-xs text-ink2">{error}</p>
      </aside>
    );
  }

  if (!hasTracks) {
    return (
      <aside
        aria-label="Panel de subtítulos vacío"
        className="flex h-full min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-line bg-surface p-6 text-center"
      >
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface2 text-xl text-accent">
          字幕
        </div>
        <h2 className="text-base font-semibold text-ink">
          Este video aún no tiene subtítulos
        </h2>
        <p className="mt-1 max-w-xs text-xs text-ink2">
          Subí un archivo <code className="text-ink">.srt</code>,{" "}
          <code className="text-ink">.ass</code>, <code className="text-ink">.ssa</code> o{" "}
          <code className="text-ink">.vtt</code> para sincronizar las líneas y habilitar
          los controles de estudio.
        </p>
        <button
          type="button"
          onClick={onOpenUploadDialog}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          + Añadir subtítulos
        </button>
      </aside>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const visibleRange = virtualizer.range;
  const isActiveVisible =
    !!visibleRange &&
    stickyArrayIdx >= visibleRange.startIndex &&
    stickyArrayIdx <= visibleRange.endIndex;

  return (
    <aside
      aria-label="Transcripción de subtítulos"
      className="relative flex h-full min-h-[320px] flex-col overflow-hidden rounded-lg border border-line bg-surface"
    >
      {/* Buscador superior */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2.5">
        <div className="relative flex-1">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={S.searchCues}
            aria-label="Buscar texto en subtítulos"
            className="w-full rounded-lg border border-line bg-app py-1.5 pl-3 pr-8 text-xs text-ink placeholder-ink2 focus:border-lineStrong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          />
          {searchInput && (
            <button
              type="button"
              onClick={handleClearSearch}
              aria-label="Limpiar búsqueda"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink2 hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <span className="shrink-0 text-[11px] text-ink2">
          {S.cueCount(filteredCues.length, primaryCues.length)}
        </span>
      </div>

      {/* Lista virtualizada */}
      <div
        ref={scrollContainerRef}
        role="list"
        aria-label="Lista de cues de subtítulos"
        onWheel={suspendFollowOnUserScroll}
        onTouchMove={suspendFollowOnUserScroll}
        onPointerDown={(e) => {
          const target = e.currentTarget;
          if (e.clientX > target.getBoundingClientRect().right - 18) {
            suspendFollowOnUserScroll();
          }
        }}
        className="flex-1 overflow-y-auto"
      >
        {filteredCues.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center p-4 text-center text-xs text-ink2">
            No se encontraron líneas que coincidan con «{debouncedQuery}».
          </div>
        ) : (
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {virtualItems.map((virtualRow) => {
              const cue = filteredCues[virtualRow.index];
              const isActive = cue.idx === activeCueOrdinalIdx;
              const isLooping = loopCueIdx !== null && cue.idx === loopCueIdx;
              const secondaryText = pairedSecondaryByIdx.get(cue.idx) ?? null;

              return (
                <div
                  key={cue.idx}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <CueRow
                    cue={cue}
                    secondaryText={secondaryText}
                    primaryLang={primaryLang}
                    primaryScript={primaryScript}
                    secondaryLang={secondaryLang}
                    isActive={isActive}
                    isLooping={isLooping}
                    showPinyin={showPinyinPanel}
                    colorTones={colorTones && (toneColorScope === "all" || isActive)}
                    pinyinStyle={pinyinStyle}
                    pinyinScale={pinyinScale}
                    highlightQuery={debouncedQuery}
                    onSelectCue={handleSelectCue}
                    onWordActivate={onWordActivate}
                    onWordHover={onWordHover}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Botón flotante para reactivar followActive */}
      {!followActive && !debouncedQuery && stickyArrayIdx >= 0 && !isActiveVisible && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            onClick={handleResumeFollow}
            className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-app shadow-lg transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            {S.backToCurrent}
          </button>
        </div>
      )}
    </aside>
  );
};
