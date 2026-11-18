import { GripHorizontal } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import type { ChineseScript, CueRead } from "../lib/api";
import { findActiveCueIndices, findBestOverlapIndex } from "../lib/cues";
import { useClockSelector } from "../lib/playbackClock";
import { useStudyStore } from "../store/studyStore";
import { CueText, type WordActivateInfo } from "./CueText";

export interface SubtitleOverlayProps {
  primaryCues: readonly CueRead[];
  primaryLang?: string;
  primaryScript?: ChineseScript;
  secondaryCues: readonly CueRead[];
  secondaryLang?: string;
  secondaryScript?: ChineseScript;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
}

export const SubtitleOverlay: React.FC<SubtitleOverlayProps> = React.memo(
  function SubtitleOverlay({
    primaryCues,
    primaryLang = "zh",
    primaryScript = null,
    secondaryCues,
    secondaryLang = "es",
    secondaryScript = null,
    onWordActivate,
    onWordHover,
  }) {
    const showOverlay = useStudyStore((s) => s.showOverlay);
    const showSecondary = useStudyStore((s) => s.showSecondary);
    const subtitleFontSize = useStudyStore((s) => s.subtitleFontSize);
    const showPinyinOverlay = useStudyStore((s) => s.showPinyinOverlay);
    const colorTones = useStudyStore((s) => s.colorTones);
    const pinyinStyle = useStudyStore((s) => s.pinyinStyle);
    const pinyinScale = useStudyStore((s) => s.pinyinScale);
    const offsetY = useStudyStore((s) => s.subtitleOffsetY);
    const setOffsetY = useStudyStore((s) => s.setSubtitleOffsetY);

    // Arrastre vertical: estado local mientras se arrastra, se confirma al soltar.
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [dragY, setDragY] = useState<number | null>(null);
    const clampPct = (v: number) => Math.min(80, Math.max(0, v));

    const handleDragStart = useCallback(
      (e: React.PointerEvent<HTMLButtonElement>) => {
        const parent = rootRef.current?.parentElement;
        if (!parent) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        const rect = parent.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          setDragY(clampPct(((rect.bottom - ev.clientY) / rect.height) * 100 - 4));
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          setOffsetY(clampPct(((rect.bottom - ev.clientY) / rect.height) * 100 - 4));
          setDragY(null);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      },
      [setOffsetY],
    );

    const handleHandleKey = (e: React.KeyboardEvent) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setOffsetY(offsetY + 2);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setOffsetY(offsetY - 2);
      } else if (e.key === "Home") {
        e.preventDefault();
        setOffsetY(8);
      }
    };

    // El selector retorna un string primitivo ("0" o "1,2" o "") para que React
    // solo re-renderice cuando cambian los cues activos y no en cada frame (60fps).
    const activeIndicesKey = useClockSelector((timeMs) => {
      if (!showOverlay || primaryCues.length === 0) {
        return "";
      }
      const indices = findActiveCueIndices(primaryCues, timeMs);
      return indices.length > 0 ? indices.join(",") : "";
    });

    const activeItems = useMemo(() => {
      if (!activeIndicesKey) {
        return [];
      }
      const indices = activeIndicesKey
        .split(",")
        .map((n) => Number.parseInt(n, 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n < primaryCues.length);

      return indices.map((idx) => {
        const primaryCue = primaryCues[idx];
        let secondaryCue: CueRead | null = null;
        if (showSecondary) {
          if (secondaryCues.length > 0) {
            const matchIdx = findBestOverlapIndex(primaryCue, secondaryCues);
            if (matchIdx !== null) {
              secondaryCue = secondaryCues[matchIdx];
            }
          } else if (primaryCue.translation_text) {
            secondaryCue = {
              idx: primaryCue.idx,
              start_ms: primaryCue.start_ms,
              end_ms: primaryCue.end_ms,
              text: primaryCue.translation_text,
            };
          }
        }
        return {
          primaryCue,
          secondaryCue,
        };
      });
    }, [activeIndicesKey, primaryCues, secondaryCues, showSecondary]);

    if (!showOverlay || activeItems.length === 0) {
      return null;
    }

    // Tamaños relativos al ancho del reproductor (container query units): escalan
    // con el layout y en pantalla completa. 26px de referencia ≈ 3.25cqw.
    const primarySize = `clamp(14px, ${(subtitleFontSize / 8).toFixed(3)}cqw, 72px)`;
    const secondarySize = `clamp(12px, ${((subtitleFontSize * 0.72) / 8).toFixed(3)}cqw, 52px)`;
    const bottomPct = dragY ?? offsetY;

    return (
      <div
        ref={rootRef}
        className="group/ov pointer-events-none absolute inset-x-[4%] z-20 flex flex-col items-center justify-end gap-[0.35em] text-center"
        style={{ bottom: `${bottomPct}%` }}
      >
        <button
          type="button"
          aria-label="Mover subtítulos (flechas arriba y abajo; doble clic para restablecer)"
          title="Arrastrar para mover. Doble clic para restablecer."
          onPointerDown={handleDragStart}
          onDoubleClick={() => setOffsetY(8)}
          onKeyDown={handleHandleKey}
          className="pointer-events-auto flex h-5 w-10 cursor-ns-resize items-center justify-center rounded bg-black/60 text-white/80 opacity-0 transition-opacity focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/ov:opacity-100"
          style={{ touchAction: "none" }}
        >
          <GripHorizontal size={14} />
        </button>
        {activeItems.map(({ primaryCue, secondaryCue }) => (
          <div
            key={primaryCue.idx}
            aria-hidden="true"
            className="pointer-events-auto flex max-w-full flex-col items-center gap-[0.2em]"
          >
            <div
              className="cjk-subtitle-text select-text rounded-[0.3em] bg-black/60 px-[0.5em] py-[0.08em] font-medium leading-snug text-white"
              style={{ fontSize: primarySize }}
            >
              <CueText
                text={primaryCue.text}
                tokens={primaryCue.tokens}
                lang={primaryLang}
                script={primaryScript}
                variant="overlay"
                showPinyin={showPinyinOverlay}
                colorTones={colorTones}
                pinyinStyle={pinyinStyle}
                pinyinScale={pinyinScale}
                cueIdx={primaryCue.idx}
                onWordActivate={onWordActivate}
                onWordHover={onWordHover}
              />
            </div>
            {showSecondary && secondaryCue && (
              <div
                className="cjk-subtitle-text select-text rounded-[0.3em] bg-black/60 px-[0.5em] py-[0.05em] font-normal leading-snug text-[#f1f1ee]"
                style={{ fontSize: secondarySize }}
              >
                <CueText
                  text={secondaryCue.text}
                  tokens={secondaryCue.tokens}
                  lang={secondaryLang}
                  script={secondaryScript}
                  variant="overlay"
                  showPinyin={false}
                  colorTones={false}
                  pinyinStyle={pinyinStyle}
                  pinyinScale={pinyinScale}
                  cueIdx={secondaryCue.idx}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  },
);
