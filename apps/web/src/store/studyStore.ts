import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PinyinStyle = "marks" | "numbers";

export type DictionaryTrigger = "click" | "hover";

export type ToneColorScope = "active" | "all";

export interface StudyState {
  subtitleFontSize: number;
  /** Distancia del overlay al borde inferior del video, en % de la altura. */
  subtitleOffsetY: number;
  showOverlay: boolean;
  showSecondary: boolean;
  showPanel: boolean;
  followActive: boolean;
  pauseAfterCue: boolean;
  loopPadMs: number;
  primaryTrackIdByVideo: Record<number, number>;
  secondaryTrackIdByVideo: Record<number, number | null>;

  // Fase 3: Ajustes de pinyin y tonos (persistidos)
  showPinyinOverlay: boolean;
  showPinyinPanel: boolean;
  colorTones: boolean;
  /** Alcance del color por tono en el panel (el overlay siempre lo usa si colorTones). */
  toneColorScope: ToneColorScope;
  pinyinStyle: PinyinStyle;
  pinyinScale: number;

  // Fase 4: Diccionario CC-CEDICT (persistidos)
  dictionaryTrigger: DictionaryTrigger;
  pauseOnLookup: boolean;

  // Estado efímero (no se persiste en localStorage)
  loopCueIdx: number | null;

  setSubtitleOffsetY: (pct: number) => void;
  setSubtitleFontSize: (size: number) => void;
  adjustSubtitleFontSize: (delta: number) => void;
  setShowOverlay: (show: boolean) => void;
  toggleOverlay: () => void;
  setShowSecondary: (show: boolean) => void;
  toggleSecondary: () => void;
  setShowPanel: (show: boolean) => void;
  togglePanel: () => void;
  setFollowActive: (follow: boolean) => void;
  setPauseAfterCue: (pause: boolean) => void;
  togglePauseAfterCue: () => void;
  setLoopPadMs: (padMs: number) => void;
  setPrimaryTrackForVideo: (videoId: number, trackId: number) => void;
  setSecondaryTrackForVideo: (videoId: number, trackId: number | null) => void;

  setShowPinyinOverlay: (show: boolean) => void;
  togglePinyinOverlay: () => void;
  setShowPinyinPanel: (show: boolean) => void;
  togglePinyinPanel: () => void;
  setColorTones: (color: boolean) => void;
  toggleColorTones: () => void;
  setToneColorScope: (scope: ToneColorScope) => void;
  setPinyinStyle: (style: PinyinStyle) => void;
  setPinyinScale: (scale: number) => void;

  setDictionaryTrigger: (trigger: DictionaryTrigger) => void;
  setPauseOnLookup: (pause: boolean) => void;
  togglePauseOnLookup: () => void;

  setLoopCueIdx: (idx: number | null) => void;
  toggleLoopCueIdx: (idx: number) => void;
}

const MIN_FONT_SIZE = 16;
const MAX_FONT_SIZE = 48;
const MIN_PINYIN_SCALE = 0.4;
const MAX_PINYIN_SCALE = 0.7;

export const useStudyStore = create<StudyState>()(
  persist(
    (set) => ({
      subtitleFontSize: 26,
      subtitleOffsetY: 8,
      showOverlay: true,
      showSecondary: true,
      showPanel: true,
      followActive: true,
      pauseAfterCue: false,
      loopPadMs: 80,
      primaryTrackIdByVideo: {},
      secondaryTrackIdByVideo: {},

      showPinyinOverlay: true,
      showPinyinPanel: false,
      colorTones: true,
      toneColorScope: "active",
      pinyinStyle: "marks",
      pinyinScale: 0.5,

      dictionaryTrigger: "click",
      pauseOnLookup: true,

      loopCueIdx: null,

      setSubtitleOffsetY: (pct) =>
        set({ subtitleOffsetY: Math.min(80, Math.max(0, Math.round(pct * 10) / 10)) }),
      setSubtitleFontSize: (size) =>
        set({
          subtitleFontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)),
        }),
      adjustSubtitleFontSize: (delta) =>
        set((state) => ({
          subtitleFontSize: Math.min(
            MAX_FONT_SIZE,
            Math.max(MIN_FONT_SIZE, state.subtitleFontSize + delta),
          ),
        })),
      setShowOverlay: (show) => set({ showOverlay: show }),
      toggleOverlay: () => set((state) => ({ showOverlay: !state.showOverlay })),
      setShowSecondary: (show) => set({ showSecondary: show }),
      toggleSecondary: () => set((state) => ({ showSecondary: !state.showSecondary })),
      setShowPanel: (show) => set({ showPanel: show }),
      togglePanel: () => set((state) => ({ showPanel: !state.showPanel })),
      setFollowActive: (follow) => set({ followActive: follow }),
      setPauseAfterCue: (pause) => set({ pauseAfterCue: pause }),
      togglePauseAfterCue: () =>
        set((state) => ({ pauseAfterCue: !state.pauseAfterCue })),
      setLoopPadMs: (padMs) => set({ loopPadMs: Math.max(0, Math.min(1000, padMs)) }),
      setPrimaryTrackForVideo: (videoId, trackId) =>
        set((state) => ({
          primaryTrackIdByVideo: {
            ...state.primaryTrackIdByVideo,
            [videoId]: trackId,
          },
        })),
      setSecondaryTrackForVideo: (videoId, trackId) =>
        set((state) => ({
          secondaryTrackIdByVideo: {
            ...state.secondaryTrackIdByVideo,
            [videoId]: trackId,
          },
        })),

      setShowPinyinOverlay: (show) => set({ showPinyinOverlay: show }),
      togglePinyinOverlay: () =>
        set((state) => ({ showPinyinOverlay: !state.showPinyinOverlay })),
      setShowPinyinPanel: (show) => set({ showPinyinPanel: show }),
      togglePinyinPanel: () =>
        set((state) => ({ showPinyinPanel: !state.showPinyinPanel })),
      setColorTones: (color) => set({ colorTones: color }),
      toggleColorTones: () => set((state) => ({ colorTones: !state.colorTones })),
      setToneColorScope: (scope) => set({ toneColorScope: scope }),
      setPinyinStyle: (style) => set({ pinyinStyle: style }),
      setPinyinScale: (scale) =>
        set({
          pinyinScale: Number(
            Math.min(MAX_PINYIN_SCALE, Math.max(MIN_PINYIN_SCALE, scale)).toFixed(2),
          ),
        }),

      setDictionaryTrigger: (trigger) => set({ dictionaryTrigger: trigger }),
      setPauseOnLookup: (pause) => set({ pauseOnLookup: pause }),
      togglePauseOnLookup: () =>
        set((state) => ({ pauseOnLookup: !state.pauseOnLookup })),

      setLoopCueIdx: (idx) => set({ loopCueIdx: idx }),
      toggleLoopCueIdx: (idx) =>
        set((state) => ({
          loopCueIdx: state.loopCueIdx === idx ? null : idx,
        })),
    }),
    {
      name: "mandarin-reactor-study-store",
      version: 3,
      // v1 -> v2: se agrega toneColorScope (por defecto "active").
      // v2 -> v3: se agrega subtitleOffsetY (por defecto 8 %).
      migrate: (persisted, version) => {
        const old = (persisted ?? {}) as Record<string, unknown>;
        const next = { ...old };
        if (version < 2) {
          next.toneColorScope = "active";
        }
        if (version < 3) {
          next.subtitleOffsetY = 8;
        }
        return next;
      },
      partialize: (state) => ({
        subtitleFontSize: state.subtitleFontSize,
        subtitleOffsetY: state.subtitleOffsetY,
        showOverlay: state.showOverlay,
        showSecondary: state.showSecondary,
        showPanel: state.showPanel,
        followActive: state.followActive,
        pauseAfterCue: state.pauseAfterCue,
        loopPadMs: state.loopPadMs,
        primaryTrackIdByVideo: state.primaryTrackIdByVideo,
        secondaryTrackIdByVideo: state.secondaryTrackIdByVideo,
        showPinyinOverlay: state.showPinyinOverlay,
        showPinyinPanel: state.showPinyinPanel,
        colorTones: state.colorTones,
        toneColorScope: state.toneColorScope,
        pinyinStyle: state.pinyinStyle,
        pinyinScale: state.pinyinScale,
        dictionaryTrigger: state.dictionaryTrigger,
        pauseOnLookup: state.pauseOnLookup,
      }),
    },
  ),
);
