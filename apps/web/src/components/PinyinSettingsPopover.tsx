import { X } from "lucide-react";
import React, { useState } from "react";
import type { CueTokens } from "../lib/tokens";
import { useStudyStore } from "../store/studyStore";
import { CueText } from "./CueText";

const PREVIEW_TOKENS: CueTokens = {
  v: 1,
  t: [
    { w: "你好吗", p: ["nǐ", "hǎo", "ma"], n: [3, 3, 5], k: "w" },
    { w: " · ", k: "p" },
    { w: "绿女", p: ["lǜ", "nǚ"], n: [4, 3], k: "w" },
  ],
};

export const PinyinSettingsPopover: React.FC = () => {
  const [isOpen, setIsOpen] = useState(false);

  const showPinyinOverlay = useStudyStore((s) => s.showPinyinOverlay);
  const togglePinyinOverlay = useStudyStore((s) => s.togglePinyinOverlay);
  const showPinyinPanel = useStudyStore((s) => s.showPinyinPanel);
  const togglePinyinPanel = useStudyStore((s) => s.togglePinyinPanel);
  const colorTones = useStudyStore((s) => s.colorTones);
  const toggleColorTones = useStudyStore((s) => s.toggleColorTones);
  const toneColorScope = useStudyStore((s) => s.toneColorScope);
  const setToneColorScope = useStudyStore((s) => s.setToneColorScope);
  const pinyinStyle = useStudyStore((s) => s.pinyinStyle);
  const setPinyinStyle = useStudyStore((s) => s.setPinyinStyle);
  const pinyinScale = useStudyStore((s) => s.pinyinScale);
  const setPinyinScale = useStudyStore((s) => s.setPinyinScale);
  const dictionaryTrigger = useStudyStore((s) => s.dictionaryTrigger);
  const setDictionaryTrigger = useStudyStore((s) => s.setDictionaryTrigger);
  const pauseOnLookup = useStudyStore((s) => s.pauseOnLookup);
  const togglePauseOnLookup = useStudyStore((s) => s.togglePauseOnLookup);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-expanded={isOpen}
        aria-label="Ajustes de Pinyin y Tonos"
        className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-accent ${
          isOpen
            ? "border-accent bg-accent/20 text-accent"
            : "border-lineStrong bg-surface2 text-ink hover:bg-line"
        }`}
      >
        拼 Pinyin
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Configuración de Pinyin y Tonos"
          className="absolute bottom-full right-0 z-40 mb-2 w-72 rounded-lg border border-lineStrong bg-surface p-4 shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-line pb-2">
            <h3 className="text-xs font-semibold text-ink">Pinyin y Colores de Tono</h3>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Cerrar ajustes de pinyin"
              className="text-xs text-ink2 hover:text-white"
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-3 space-y-2.5 text-xs">
            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-ink">Pinyin en overlay (Y)</span>
              <input
                type="checkbox"
                checked={showPinyinOverlay}
                onChange={togglePinyinOverlay}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-ink">Pinyin en panel lateral</span>
              <input
                type="checkbox"
                checked={showPinyinPanel}
                onChange={togglePinyinPanel}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between">
              <span className="text-ink">Colorear por tono (K)</span>
              <input
                type="checkbox"
                checked={colorTones}
                onChange={toggleColorTones}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
              />
            </label>

            {colorTones && (
              <div className="pt-1">
                <span className="block text-ink2">Alcance en el panel</span>
                <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-lg bg-app p-1">
                  <button
                    type="button"
                    onClick={() => setToneColorScope("active")}
                    aria-pressed={toneColorScope === "active"}
                    className={`rounded py-1 text-xs font-medium transition ${
                      toneColorScope === "active"
                        ? "bg-accent font-semibold text-app"
                        : "text-ink hover:text-white"
                    }`}
                  >
                    Solo activa
                  </button>
                  <button
                    type="button"
                    onClick={() => setToneColorScope("all")}
                    aria-pressed={toneColorScope === "all"}
                    className={`rounded py-1 text-xs font-medium transition ${
                      toneColorScope === "all"
                        ? "bg-accent font-semibold text-app"
                        : "text-ink hover:text-white"
                    }`}
                  >
                    Todas las filas
                  </button>
                </div>
              </div>
            )}

            <div className="pt-1">
              <span className="block text-ink2">Estilo de tonos</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-lg bg-app p-1">
                <button
                  type="button"
                  onClick={() => setPinyinStyle("marks")}
                  aria-pressed={pinyinStyle === "marks"}
                  className={`rounded py-1 text-xs font-medium transition ${
                    pinyinStyle === "marks"
                      ? "bg-accent text-app font-semibold"
                      : "text-ink hover:text-white"
                  }`}
                >
                  Marcas (nǐ)
                </button>
                <button
                  type="button"
                  onClick={() => setPinyinStyle("numbers")}
                  aria-pressed={pinyinStyle === "numbers"}
                  className={`rounded py-1 text-xs font-medium transition ${
                    pinyinStyle === "numbers"
                      ? "bg-accent text-app font-semibold"
                      : "text-ink hover:text-white"
                  }`}
                >
                  Números (ni3)
                </button>
              </div>
            </div>

            <div className="pt-1">
              <div className="flex items-center justify-between">
                <label htmlFor="pinyin-scale-range" className="text-ink2">
                  Escala de pinyin
                </label>
                <span className="font-mono text-[11px] text-accent">
                  {Math.round(pinyinScale * 100)}%
                </span>
              </div>
              <input
                id="pinyin-scale-range"
                type="range"
                min={0.4}
                max={0.7}
                step={0.05}
                value={pinyinScale}
                onChange={(e) => setPinyinScale(Number.parseFloat(e.target.value))}
                className="mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-line accent-accent"
              />
            </div>

            {/* Diccionario CC-CEDICT */}
            <div className="border-t border-line pt-2.5">
              <span className="block text-ink2">Diccionario CC-CEDICT</span>
              <div className="mt-1 grid grid-cols-2 gap-1.5 rounded-lg bg-app p-1">
                <button
                  type="button"
                  onClick={() => setDictionaryTrigger("click")}
                  aria-pressed={dictionaryTrigger === "click"}
                  className={`rounded py-1 text-xs font-medium transition ${
                    dictionaryTrigger === "click"
                      ? "bg-accent text-app font-semibold"
                      : "text-ink hover:text-white"
                  }`}
                >
                  Click
                </button>
                <button
                  type="button"
                  onClick={() => setDictionaryTrigger("hover")}
                  aria-pressed={dictionaryTrigger === "hover"}
                  className={`rounded py-1 text-xs font-medium transition ${
                    dictionaryTrigger === "hover"
                      ? "bg-accent text-app font-semibold"
                      : "text-ink hover:text-white"
                  }`}
                >
                  Hover + Click
                </button>
              </div>
              <label className="mt-2 flex cursor-pointer items-center justify-between">
                <span className="text-ink">Pausar al consultar</span>
                <input
                  type="checkbox"
                  checked={pauseOnLookup}
                  onChange={togglePauseOnLookup}
                  className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
                />
              </label>
            </div>

            {/* Vista previa en vivo con 你好吗 y 绿女 */}
            <div className="mt-3 rounded-lg border border-line bg-app p-3 text-center">
              <span className="block text-[10px] text-ink2">Vista previa</span>
              <div className="mt-2 text-xl">
                <CueText
                  text="你好吗 · 绿女"
                  tokens={PREVIEW_TOKENS}
                  lang="zh-Hans"
                  variant="panel"
                  showPinyin={true}
                  colorTones={colorTones}
                  pinyinStyle={pinyinStyle}
                  pinyinScale={pinyinScale}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
