import {
  Bookmark,
  Keyboard,
  Minus,
  PauseCircle,
  Plus,
  Repeat,
  Repeat1,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { S } from "../lib/strings";
import type {
  SubtitleLang,
  SubtitleTrackRead,
  SubtitleTrackUpdatePayload,
} from "../lib/api";
import { formatLanguageLabel, formatOffsetMs, LANGUAGE_LABELS } from "../lib/format";
import { useStudyStore } from "../store/studyStore";
import { PinyinSettingsPopover } from "./PinyinSettingsPopover";

export interface SubtitleToolbarProps {
  tracks: readonly SubtitleTrackRead[];
  selectedPrimaryTrack: SubtitleTrackRead | null;
  selectedSecondaryTrackId: number | null;
  effectiveOffsetMs: number;
  onSelectPrimaryTrack: (trackId: number) => void;
  onSelectSecondaryTrack: (trackId: number | null) => void;
  onAdjustOffsetMs: (deltaMs: number) => void;
  onResetOffsetMs: () => void;
  onPrevCue: () => void;
  onNextCue: () => void;
  onRepeatCue: () => void;
  onToggleLoopCurrentCue: () => void;
  onSaveCurrentCue?: () => void;
  onOpenUploadDialog: () => void;
  onOpenShortcutsModal: () => void;
  onUpdateTrack: (trackId: number, payload: SubtitleTrackUpdatePayload) => void;
  onRetokenizeTrack: (trackId: number) => void;
  onDeleteTrack: (trackId: number) => void;
}

function renderTokensStatusBadge(track: SubtitleTrackRead): React.ReactNode {
  if (track.lang !== "zh" || track.tokens_status === "not_applicable") {
    return (
      <span className="rounded bg-surface2/80 px-1.5 py-0.5 text-[10px] text-ink2">
        No aplica
      </span>
    );
  }

  if (track.tokens_status === "pending" || track.tokens_status === "processing") {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
        <span className="h-2 w-2 animate-spin rounded-full border border-accent border-t-transparent" />
        Procesando pinyin…
      </span>
    );
  }

  if (track.tokens_status === "ready") {
    const scriptLabel =
      track.script === "hant"
        ? " · 繁體"
        : track.script === "hans"
          ? " · 简体"
          : track.script === "mixed"
            ? " · 混合"
            : "";
    return (
      <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
        Pinyin listo{scriptLabel}
      </span>
    );
  }

  if (track.tokens_status === "error") {
    return (
      <span
        title={track.tokens_error ?? "Error durante la tokenización"}
        className="cursor-help rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-300"
      >
        Error
      </span>
    );
  }

  return null;
}

export const SubtitleToolbar: React.FC<SubtitleToolbarProps> = ({
  tracks,
  selectedPrimaryTrack,
  selectedSecondaryTrackId,
  effectiveOffsetMs,
  onSelectPrimaryTrack,
  onSelectSecondaryTrack,
  onAdjustOffsetMs,
  onResetOffsetMs,
  onPrevCue,
  onNextCue,
  onRepeatCue,
  onToggleLoopCurrentCue,
  onSaveCurrentCue,
  onOpenUploadDialog,
  onOpenShortcutsModal,
  onUpdateTrack,
  onRetokenizeTrack,
  onDeleteTrack,
}) => {
  const showOverlay = useStudyStore((s) => s.showOverlay);
  const toggleOverlay = useStudyStore((s) => s.toggleOverlay);
  const showSecondary = useStudyStore((s) => s.showSecondary);
  const toggleSecondary = useStudyStore((s) => s.toggleSecondary);
  const showPanel = useStudyStore((s) => s.showPanel);
  const togglePanel = useStudyStore((s) => s.togglePanel);
  const subtitleFontSize = useStudyStore((s) => s.subtitleFontSize);
  const adjustSubtitleFontSize = useStudyStore((s) => s.adjustSubtitleFontSize);
  const pauseAfterCue = useStudyStore((s) => s.pauseAfterCue);
  const togglePauseAfterCue = useStudyStore((s) => s.togglePauseAfterCue);
  const loopCueIdx = useStudyStore((s) => s.loopCueIdx);

  // Un solo menú desplegable abierto a la vez (Pinyin o Subtítulos).
  const [openMenu, setOpenMenu] = useState<"pinyin" | "subtitles" | null>(null);
  const handlePinyinOpenChange = useCallback((open: boolean) => {
    setOpenMenu((current) => (open ? "pinyin" : current === "pinyin" ? null : current));
  }, []);
  const handleSubtitlesOpenChange = useCallback((open: boolean) => {
    setOpenMenu((current) =>
      open ? "subtitles" : current === "subtitles" ? null : current,
    );
  }, []);
  const [manageOpen, setManageOpen] = useState(false);
  const [editingTrackId, setEditingTrackId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const hasTracks = tracks.length > 0;

  return (
    <div className="shrink-0 rounded-lg border border-line bg-surface p-2">
      <div className="flex flex-wrap items-center gap-2">
        {/* Navegación por línea (grupo segmentado) */}
        <div
          role="group"
          aria-label="Navegación de líneas"
          className="flex items-center rounded-md border border-line"
        >
          <SegBtn
            disabled={!hasTracks}
            onClick={onPrevCue}
            label="Cue anterior (A)"
            kbd="A"
          >
            <SkipBack size={14} />
          </SegBtn>
          <SegBtn
            disabled={!hasTracks}
            onClick={onRepeatCue}
            label="Repetir cue actual (R)"
            kbd="R"
          >
            <Repeat1 size={14} />
          </SegBtn>
          <SegBtn
            disabled={!hasTracks}
            onClick={onNextCue}
            label="Cue siguiente (D)"
            kbd="D"
          >
            <SkipForward size={14} />
          </SegBtn>
        </div>

        {/* Modos */}
        <ToggleBtn
          disabled={!hasTracks}
          pressed={loopCueIdx !== null}
          onClick={onToggleLoopCurrentCue}
          label="Alternar bucle de la línea actual (L)"
          kbd="L"
        >
          <Repeat size={14} />
          Bucle
        </ToggleBtn>
        <ToggleBtn
          disabled={!hasTracks}
          pressed={pauseAfterCue}
          onClick={togglePauseAfterCue}
          label="Pausar automáticamente al final de cada línea (P)"
          kbd="P"
        >
          <PauseCircle size={14} />
          Pausar al final
        </ToggleBtn>

        <div className="ml-auto flex items-center gap-1.5">
          <PinyinSettingsPopover
            open={openMenu === "pinyin"}
            onOpenChange={handlePinyinOpenChange}
          />
          <SubtitleSettings
            open={openMenu === "subtitles"}
            onOpenChange={handleSubtitlesOpenChange}
          >
            <div className="grid min-w-0 grid-cols-1 gap-3">
              <div className="grid min-w-0 grid-cols-1 gap-1.5">
                <label htmlFor="primary-track-select" className="text-xs text-ink2">
                  Pista principal
                </label>
                <div className="flex items-center gap-1.5">
                  <select
                    id="primary-track-select"
                    disabled={!hasTracks}
                    value={selectedPrimaryTrack?.id ?? ""}
                    onChange={(e) => {
                      const nextId = Number.parseInt(e.target.value, 10);
                      if (Number.isFinite(nextId)) onSelectPrimaryTrack(nextId);
                    }}
                    className={SELECT_CLS}
                  >
                    {!hasTracks ? (
                      <option value="">Sin pistas</option>
                    ) : (
                      tracks.map((track) => (
                        <option key={track.id} value={track.id}>
                          {track.label} ({track.lang.toUpperCase()})
                          {track.is_primary ? " (predeterminada)" : ""}
                        </option>
                      ))
                    )}
                  </select>
                  {selectedPrimaryTrack && renderTokensStatusBadge(selectedPrimaryTrack)}
                </div>
              </div>

              <div className="grid min-w-0 grid-cols-1 gap-1.5">
                <label htmlFor="secondary-track-select" className="text-xs text-ink2">
                  Pista secundaria
                </label>
                <select
                  id="secondary-track-select"
                  disabled={tracks.length < 2}
                  value={selectedSecondaryTrackId ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    onSelectSecondaryTrack(val ? Number.parseInt(val, 10) : null);
                  }}
                  className={SELECT_CLS}
                >
                  <option value="">Ninguna</option>
                  {tracks
                    .filter((t) => t.id !== selectedPrimaryTrack?.id)
                    .map((track) => (
                      <option key={track.id} value={track.id}>
                        {track.label} ({track.lang.toUpperCase()})
                      </option>
                    ))}
                </select>
              </div>

              <div className="grid gap-1 border-t border-line pt-2">
                <SwitchRow
                  label="Subtítulos sobre el video"
                  kbd="C"
                  checked={showOverlay}
                  onChange={toggleOverlay}
                />
                <SwitchRow
                  label="Mostrar segunda pista"
                  kbd="T"
                  checked={showSecondary}
                  onChange={toggleSecondary}
                />
                <SwitchRow
                  label="Panel de transcripción"
                  checked={showPanel}
                  onChange={togglePanel}
                />
              </div>

              <div
                role="group"
                aria-label="Tamaño de fuente del subtítulo"
                className="flex items-center justify-between border-t border-line pt-2 text-xs"
              >
                <span className="text-ink2">Tamaño</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => adjustSubtitleFontSize(-2)}
                    aria-label="Reducir tamaño de fuente"
                    className={MINI_BTN}
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-12 text-center font-mono text-[11px] text-ink">
                    {subtitleFontSize}px
                  </span>
                  <button
                    type="button"
                    onClick={() => adjustSubtitleFontSize(2)}
                    aria-label="Aumentar tamaño de fuente"
                    className={MINI_BTN}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>

              <div
                role="group"
                aria-label="Ajuste de sincronía (offset)"
                className="flex items-center justify-between border-t border-line pt-2 text-xs"
              >
                <span className="text-ink2">Sincronía</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={!selectedPrimaryTrack}
                    onClick={() => onAdjustOffsetMs(-100)}
                    aria-label="Adelantar subtítulo 100 ms (G)"
                    className={MINI_BTN}
                  >
                    <Minus size={12} />
                  </button>
                  <span className="w-16 text-center font-mono text-[11px] text-ink">
                    {formatOffsetMs(effectiveOffsetMs)}
                  </span>
                  <button
                    type="button"
                    disabled={!selectedPrimaryTrack}
                    onClick={() => onAdjustOffsetMs(100)}
                    aria-label="Retrasar subtítulo 100 ms (H)"
                    className={MINI_BTN}
                  >
                    <Plus size={12} />
                  </button>
                  {effectiveOffsetMs !== 0 && (
                    <button
                      type="button"
                      onClick={onResetOffsetMs}
                      aria-label="Restablecer offset a 0 ms"
                      className="ml-1 text-[11px] text-ink2 hover:text-ink"
                    >
                      Restablecer
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    onOpenUploadDialog();
                  }}
                  className={GHOST_BTN}
                >
                  Añadir subtítulos
                </button>
                {hasTracks && (
                  <button
                    type="button"
                    onClick={() => setManageOpen((v) => !v)}
                    aria-expanded={manageOpen}
                    className={GHOST_BTN}
                  >
                    Gestionar pistas ({tracks.length})
                  </button>
                )}
              </div>
            </div>
          </SubtitleSettings>

          <button
            type="button"
            onClick={onOpenShortcutsModal}
            aria-label="Ver atajos de teclado (?)"
            title="Atajos de teclado (?)"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink2 transition hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Keyboard size={16} />
          </button>

          {onSaveCurrentCue && (
            <button
              type="button"
              disabled={!hasTracks}
              onClick={onSaveCurrentCue}
              aria-label="Guardar frase actual y cortar clip (S)"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-app transition hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink disabled:opacity-40"
            >
              <Bookmark size={14} />
              {S.saveSentence}
              <kbd className="rounded bg-black/15 px-1 font-mono text-[10px]">S</kbd>
            </button>
          )}
        </div>
      </div>

      {/* Gestor desplegable de pistas */}
      {manageOpen && hasTracks && (
        <div className="mt-3 rounded-lg border border-line bg-app/90 p-3">
          <h3 className="mb-2 text-xs font-semibold text-ink2">
            Gestionar pistas de subtítulos
          </h3>
          <div className="space-y-2">
            {tracks.map((track) => {
              const isEditing = editingTrackId === track.id;
              const isConfirmingDelete = confirmDeleteId === track.id;
              const isZh = track.lang === "zh";
              const isTokenizing =
                track.tokens_status === "pending" || track.tokens_status === "processing";

              return (
                <div
                  key={track.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line/80 bg-surface/70 px-3 py-2 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {isEditing ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editLabel.trim()) {
                            onUpdateTrack(track.id, { label: editLabel.trim() });
                          }
                          setEditingTrackId(null);
                        }}
                        className="flex items-center gap-1.5"
                      >
                        <input
                          type="text"
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          aria-label="Nuevo nombre de pista"
                          className="rounded border border-lineStrong bg-app px-2 py-0.5 text-xs text-ink focus:border-accent focus:outline-none"
                        />
                        <button
                          type="submit"
                          className="rounded bg-accent px-2 py-0.5 font-semibold text-app"
                        >
                          Guardar
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingTrackId(null)}
                          className="rounded bg-surface2 px-2 py-0.5 text-ink"
                        >
                          Cancelar
                        </button>
                      </form>
                    ) : (
                      <>
                        <span className="font-medium text-ink">{track.label}</span>
                        <span className="rounded bg-surface2 px-1.5 py-0.5 text-[11px] text-ink">
                          .{track.source_format} · {track.cue_count} cues ·{" "}
                          {track.detected_encoding ?? "utf-8"}
                        </span>
                        {renderTokensStatusBadge(track)}
                        {track.is_primary && (
                          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] font-semibold text-accent">
                            Primaria
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Selector de idioma */}
                    <select
                      aria-label={`Idioma de ${track.label}`}
                      value={track.lang}
                      onChange={(e) =>
                        onUpdateTrack(track.id, {
                          lang: e.target.value as SubtitleLang,
                        })
                      }
                      className="rounded border border-lineStrong bg-app px-2 py-0.5 text-xs text-ink"
                    >
                      {Object.keys(LANGUAGE_LABELS).map((code) => (
                        <option key={code} value={code}>
                          {formatLanguageLabel(code)}
                        </option>
                      ))}
                    </select>

                    {isZh && (
                      <button
                        type="button"
                        disabled={isTokenizing}
                        onClick={() => onRetokenizeTrack(track.id)}
                        className="rounded bg-surface2 px-2 py-0.5 text-accent hover:bg-line disabled:opacity-40"
                      >
                        Reprocesar pinyin
                      </button>
                    )}

                    {!track.is_primary && (
                      <button
                        type="button"
                        onClick={() => {
                          onUpdateTrack(track.id, { is_primary: true });
                          onSelectPrimaryTrack(track.id);
                        }}
                        className="rounded bg-surface2 px-2 py-0.5 text-ink hover:bg-line"
                      >
                        Hacer primaria
                      </button>
                    )}

                    {!isEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTrackId(track.id);
                          setEditLabel(track.label);
                        }}
                        className="rounded bg-surface2 px-2 py-0.5 text-ink hover:text-white"
                      >
                        Renombrar
                      </button>
                    )}

                    {isConfirmingDelete ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            onDeleteTrack(track.id);
                            setConfirmDeleteId(null);
                          }}
                          className="rounded bg-rose-600 px-2 py-0.5 font-semibold text-white hover:bg-rose-500"
                        >
                          Confirmar
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded bg-surface2 px-2 py-0.5 text-ink"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(track.id)}
                        className="rounded bg-rose-950/60 px-2 py-0.5 text-rose-300 hover:bg-rose-900/60"
                      >
                        Eliminar
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const SELECT_CLS =
  "min-w-0 flex-1 rounded-md border border-line bg-app px-2 py-1 text-xs text-ink focus:border-lineStrong focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50";
const MINI_BTN =
  "inline-flex h-6 w-6 items-center justify-center rounded border border-line text-ink2 hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40";
const GHOST_BTN =
  "rounded-md border border-line px-2.5 py-1 text-xs text-ink hover:bg-surface2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent";

const SegBtn: React.FC<{
  onClick: () => void;
  label: string;
  kbd: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ onClick, label, kbd, disabled, children }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    aria-label={label}
    title={label}
    className="inline-flex h-8 w-9 items-center justify-center text-ink2 transition first:rounded-l-md last:rounded-r-md hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-40 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-line"
    data-kbd={kbd}
  >
    {children}
  </button>
);

const ToggleBtn: React.FC<{
  pressed: boolean;
  onClick: () => void;
  label: string;
  kbd: string;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ pressed, onClick, label, kbd, disabled, children }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    aria-pressed={pressed}
    aria-label={label}
    title={label}
    className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${
      pressed
        ? "border-accent bg-accent/10 font-semibold text-accent"
        : "border-line text-ink2 hover:bg-surface2 hover:text-ink"
    }`}
    data-kbd={kbd}
  >
    {children}
  </button>
);

const SwitchRow: React.FC<{
  label: string;
  kbd?: string;
  checked: boolean;
  onChange: () => void;
}> = ({ label, kbd, checked, onChange }) => (
  <div className="flex items-center justify-between py-1 text-xs">
    <span className="text-ink">
      {label}
      {kbd && (
        <kbd className="ml-2 rounded bg-surface2 px-1 font-mono text-[10px] text-ink2">
          {kbd}
        </kbd>
      )}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-5 w-9 rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        checked ? "bg-accent" : "bg-lineStrong"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-app transition-all ${
          checked ? "left-[1.1rem]" : "left-0.5 bg-ink"
        }`}
      />
    </button>
  </div>
);

const SubtitleSettings: React.FC<{
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}> = ({ open, onOpenChange, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink2 transition hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <SlidersHorizontal size={14} />
        Subtítulos
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Ajustes de subtítulos"
          className="absolute bottom-full right-0 z-40 mb-2 max-h-[min(70vh,34rem)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-surface2 p-3 shadow-xl"
        >
          {children}
        </div>
      )}
    </div>
  );
};
