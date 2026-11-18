import React, { useMemo } from "react";
import type { ChineseScript } from "../lib/api";
import { formatPinyinSyllable } from "../lib/pinyin";
import {
  parseTokens,
  tokensToPlainText,
  type ToneNumber,
  type WordToken,
} from "../lib/tokens";
import type { PinyinStyle } from "../store/studyStore";

export interface WordActivateInfo {
  cueIdx: number;
  tokenIdx: number;
  word: string;
  anchorRect: DOMRect;
  source: "overlay" | "panel";
  pinned: boolean;
}

export interface ZhWordProps {
  token: WordToken;
  tokenIdx: number;
  cueIdx: number;
  variant: "overlay" | "panel";
  showPinyin: boolean;
  colorTones: boolean;
  pinyinStyle: PinyinStyle;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
}

function getToneColorClass(
  tone: ToneNumber | null | undefined,
  variant: "overlay" | "panel",
  colorTones: boolean,
): string {
  if (!colorTones || !tone || tone < 1 || tone > 5) {
    return "";
  }
  return variant === "overlay" ? `tone-overlay-${tone}` : `tone-panel-${tone}`;
}

export const ZhWord: React.FC<ZhWordProps> = React.memo(function ZhWord({
  token,
  tokenIdx,
  cueIdx,
  variant,
  showPinyin,
  colorTones,
  pinyinStyle,
  onWordActivate,
  onWordHover,
}) {
  const chars = useMemo(() => Array.from(token.w), [token.w]);

  const handleClick = onWordActivate
    ? (e: React.MouseEvent<HTMLSpanElement>) => {
        e.stopPropagation();
        onWordActivate({
          cueIdx,
          tokenIdx,
          word: token.w,
          anchorRect: e.currentTarget.getBoundingClientRect(),
          source: variant,
          pinned: true,
        });
      }
    : undefined;

  const handleMouseEnter = onWordHover
    ? (e: React.MouseEvent<HTMLSpanElement>) => {
        onWordHover({
          cueIdx,
          tokenIdx,
          word: token.w,
          anchorRect: e.currentTarget.getBoundingClientRect(),
          source: variant,
          pinned: false,
        });
      }
    : undefined;

  const isInteractive = Boolean(onWordActivate || onWordHover);

  return (
    <span
      className={`zh-word inline-block rounded px-0.5 transition-colors ${
        isInteractive
          ? "cursor-pointer hover:bg-accent/20 hover:underline hover:decoration-accent/60 hover:underline-offset-4"
          : ""
      }`.trim()}
      data-token-idx={tokenIdx}
      data-cue-idx={cueIdx}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
    >
      {chars.map((char, charIdx) => {
        const rawPinyin = token.p[charIdx] ?? null;
        const tone = token.n[charIdx] ?? null;
        const toneClass = getToneColorClass(tone, variant, colorTones);
        const displayPinyin =
          showPinyin && rawPinyin
            ? formatPinyinSyllable(rawPinyin, tone, pinyinStyle)
            : null;

        return (
          <ruby key={charIdx} className={toneClass || undefined}>
            {char}
            {displayPinyin !== null && <rt aria-hidden="true">{displayPinyin}</rt>}
          </ruby>
        );
      })}
    </span>
  );
});

export interface CueTextProps {
  text: string;
  tokens?: unknown;
  lang?: string;
  script?: ChineseScript;
  variant?: "overlay" | "panel";
  showPinyin?: boolean;
  colorTones?: boolean;
  pinyinStyle?: PinyinStyle;
  pinyinScale?: number;
  cueIdx?: number;
  highlightQuery?: string;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
  className?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export function resolveBcp47Lang(
  lang?: string,
  script?: ChineseScript,
): string | undefined {
  if (lang === "zh-Hant" || (lang === "zh" && script === "hant")) {
    return "zh-Hant";
  }
  if (lang === "zh" || lang === "zh-Hans") {
    return "zh-Hans";
  }
  return lang;
}

function renderHighlightedPlainText(
  text: string,
  highlightQuery?: string,
): React.ReactNode {
  const trimmedQuery = (highlightQuery ?? "").trim();
  if (!trimmedQuery) {
    return text;
  }
  const escaped = trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, idx) =>
    part.toLowerCase() === trimmedQuery.toLowerCase() ? (
      <mark key={idx} className="rounded bg-accent/25 px-0.5 text-ink">
        {part}
      </mark>
    ) : (
      <React.Fragment key={idx}>{part}</React.Fragment>
    ),
  );
}

/**
 * Único punto de renderizado del texto de subtítulos en overlay y panel.
 *
 * Decisiones de diseño:
 * - Ruby por carácter dentro de `<span class="zh-word">`: garantiza alineación exacta de cada
 *   sílaba sobre su hanzi y coloreado individual por tono, manteniendo agrupada la palabra
 *   segmentada por jieba para el futuro diccionario (Fase 4).
 * - Cuando `showPinyin` es `false`, se omite el nodo `<rt>` del DOM para ahorrar costo de layout.
 */
export const CueText: React.FC<CueTextProps> = React.memo(function CueText({
  text,
  tokens,
  lang,
  script,
  variant = "panel",
  showPinyin = false,
  colorTones = true,
  pinyinStyle = "marks",
  pinyinScale = 0.5,
  cueIdx = 0,
  highlightQuery,
  onWordActivate,
  onWordHover,
  className = "",
}) {
  const effectiveLang = resolveBcp47Lang(lang, script);
  const parsedTokens = useMemo(() => parseTokens(tokens), [tokens]);

  // Fallback a texto plano si no hay tokens válidos o si hay una búsqueda activa resaltando substrings
  if (!parsedTokens) {
    return (
      <span lang={effectiveLang} className={`whitespace-pre-line ${className}`.trim()}>
        {renderHighlightedPlainText(text, highlightQuery)}
      </span>
    );
  }

  const plainLabel = tokensToPlainText(parsedTokens);
  const styleVars = {
    "--pinyin-scale": String(pinyinScale),
  } as React.CSSProperties;

  return (
    <span
      lang={effectiveLang}
      aria-label={plainLabel}
      style={styleVars}
      className={`whitespace-pre-line ${className}`.trim()}
    >
      {parsedTokens.t.map((tok, tokenIdx) => {
        if (tok.k === "w") {
          return (
            <ZhWord
              key={tokenIdx}
              token={tok}
              tokenIdx={tokenIdx}
              cueIdx={cueIdx}
              variant={variant}
              showPinyin={showPinyin}
              colorTones={colorTones}
              pinyinStyle={pinyinStyle}
              onWordActivate={onWordActivate}
              onWordHover={onWordHover}
            />
          );
        }
        if (tok.k === "b") {
          return <br key={tokenIdx} />;
        }
        return (
          <React.Fragment key={tokenIdx}>
            {renderHighlightedPlainText(tok.w, highlightQuery)}
          </React.Fragment>
        );
      })}
    </span>
  );
});
