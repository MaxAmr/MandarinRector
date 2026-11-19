import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import { PLAYBACK_SPEED_PRESETS } from "../hooks/useVideoElement";
import type { ChineseScript, CueRead } from "../lib/api";
import { formatDuration } from "../lib/format";
import type { WordActivateInfo } from "./CueText";
import { SubtitleOverlay } from "./SubtitleOverlay";

export interface VideoPlayerProps {
  streamUrl: string;
  thumbnailUrl?: string | null;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  mediaError: string | null;
  primaryCues: readonly CueRead[];
  primaryLang?: string;
  primaryScript?: ChineseScript;
  secondaryCues: readonly CueRead[];
  secondaryLang?: string;
  secondaryScript?: ChineseScript;
  loopActive?: boolean;
  pauseAfterCueActive?: boolean;
  onBindVideoRef: (node: HTMLVideoElement | null) => void;
  onTogglePlay: () => void;
  onSeekTo: (seconds: number) => void;
  onSeekBy: (deltaSeconds: number) => void;
  onSetPlaybackRate: (rate: number) => void;
  onSetVolume: (volume: number) => void;
  onToggleMute: () => void;
  onWordActivate?: (info: WordActivateInfo) => void;
  onWordHover?: (info: WordActivateInfo) => void;
  overlayPopup?: React.ReactNode;
  containerRef?: React.RefObject<HTMLDivElement>;
}

/**
 * Reproductor de video controlado con controles propios y overlay de subtítulos.
 *
 * Decisión de diseño (controles propios en lugar de controles nativos):
 * Se desactivan los controles nativos del `<video>` para garantizar que el botón de
 * pantalla completa (`F`) ejecute `requestFullscreen()` sobre el contenedor padre
 * (manteniendo visible `SubtitleOverlay`) y para exponer directamente los presets de
 * velocidad de estudio (0.5x–1.5x con `preservesPitch = true`).
 */
export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  function VideoPlayer(
    {
      streamUrl,
      thumbnailUrl,
      currentTime,
      duration,
      paused,
      playbackRate,
      volume,
      muted,
      mediaError,
      primaryCues,
      primaryLang,
      primaryScript,
      secondaryCues,
      secondaryLang,
      secondaryScript,
      loopActive = false,
      pauseAfterCueActive = false,
      onBindVideoRef,
      onTogglePlay,
      onSeekTo,
      onSeekBy,
      onSetPlaybackRate,
      onSetVolume,
      onToggleMute,
      onWordActivate,
      onWordHover,
      overlayPopup,
      containerRef: externalContainerRef,
    },
    ref,
  ) {
    const internalVideoRef = useRef<HTMLVideoElement | null>(null);
    const internalContainerRef = useRef<HTMLDivElement | null>(null);
    const wrapperRef = externalContainerRef ?? internalContainerRef;

    const [isFullscreen, setIsFullscreen] = useState(false);

    const handleVideoRef = useCallback(
      (node: HTMLVideoElement | null) => {
        internalVideoRef.current = node;
        onBindVideoRef(node);
      },
      [onBindVideoRef],
    );

    useImperativeHandle(ref, () => internalVideoRef.current as HTMLVideoElement, []);

    const toggleFullscreen = useCallback(async () => {
      const container = wrapperRef.current;
      if (!container) return;
      try {
        if (!document.fullscreenElement) {
          await container.requestFullscreen();
        } else {
          await document.exitFullscreen();
        }
      } catch {
        // Ignorar errores de permisos fullscreen
      }
    }, [wrapperRef]);

    useEffect(() => {
      const handleFullscreenChange = () => {
        setIsFullscreen(Boolean(document.fullscreenElement));
      };
      document.addEventListener("fullscreenchange", handleFullscreenChange);
      return () => {
        document.removeEventListener("fullscreenchange", handleFullscreenChange);
      };
    }, []);

    const bufferedEnd = (() => {
      const v = internalVideoRef.current;
      if (!v || v.buffered.length === 0) return 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (
          currentTime >= v.buffered.start(i) &&
          currentTime <= v.buffered.end(i) + 0.5
        ) {
          return v.buffered.end(i);
        }
      }
      return 0;
    })();

    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const clampedCurrent = Math.min(currentTime, safeDuration || currentTime);

    return (
      <div
        ref={wrapperRef}
        className={`group relative flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-black ${
          isFullscreen ? "h-full" : "shrink-0 lg:flex-1 lg:shrink"
        }`}
      >
        {/* Área de video + Overlay.
            - Móvil: relación 16:9 según el ancho.
            - Desktop (lg+): ocupa todo el alto disponible y el video se ajusta con
              object-contain, así nunca se recorta (con o sin panel lateral) y la
              barra de controles siempre queda visible debajo. */}
        <div
          className={`relative flex w-full items-center justify-center bg-black [container-type:inline-size] ${
            isFullscreen ? "min-h-0 flex-1" : "aspect-video lg:aspect-auto lg:min-h-0 lg:flex-1"
          }`}
        >
          <video
            ref={handleVideoRef}
            src={streamUrl}
            poster={thumbnailUrl ?? undefined}
            preload="metadata"
            playsInline
            onClick={onTogglePlay}
            className="absolute inset-0 h-full w-full cursor-pointer object-contain"
          />

          {/* Badges superiores de estado de estudio (Loop / PauseAfterCue) */}
          {(loopActive || pauseAfterCueActive) && (
            <div className="pointer-events-none absolute left-3 top-3 z-20 flex items-center gap-2">
              {loopActive && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-semibold text-app shadow">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-app" />
                  Bucle de línea
                </span>
              )}
              {pauseAfterCueActive && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface2 px-2.5 py-1 text-xs font-semibold text-ink shadow">
                  Pausa al final de línea
                </span>
              )}
            </div>
          )}

          {/* Overlay de subtítulos dentro del contenedor fullscreen */}
          <SubtitleOverlay
            primaryCues={primaryCues}
            primaryLang={primaryLang}
            primaryScript={primaryScript}
            secondaryCues={secondaryCues}
            secondaryLang={secondaryLang}
            secondaryScript={secondaryScript}
            onWordActivate={onWordActivate}
            onWordHover={onWordHover}
          />
          {overlayPopup}

          {/* Mensaje legible ante MediaError */}
          {mediaError && (
            <div
              role="alert"
              className="absolute inset-4 z-30 flex flex-col items-center justify-center rounded-lg bg-app/90 p-6 text-center"
            >
              <p className="text-base font-semibold text-rose-400">
                No se pudo reproducir el video
              </p>
              <p className="mt-1 max-w-md text-sm text-ink">{mediaError}</p>
            </div>
          )}
        </div>

        {/* Barra de controles propios */}
        <div className="flex shrink-0 flex-col gap-1 border-t border-line bg-surface px-3 pb-2 pt-1">
          <ProgressBar
            current={clampedCurrent}
            duration={safeDuration}
            bufferedEnd={bufferedEnd}
            onSeekTo={onSeekTo}
          />

          <div className="flex items-center gap-1">
            <IconBtn
              onClick={onTogglePlay}
              label={paused ? "Reproducir (Espacio)" : "Pausar (Espacio)"}
            >
              {paused ? (
                <Play size={18} fill="currentColor" />
              ) : (
                <Pause size={18} fill="currentColor" />
              )}
            </IconBtn>
            <IconBtn
              onClick={() => onSeekBy(-5)}
              label="Retroceder 5 segundos (Flecha izquierda)"
            >
              <RotateCcw size={16} />
            </IconBtn>
            <IconBtn
              onClick={() => onSeekBy(5)}
              label="Avanzar 5 segundos (Flecha derecha)"
            >
              <RotateCw size={16} />
            </IconBtn>

            <div className="group/vol ml-1 flex items-center">
              <IconBtn
                onClick={onToggleMute}
                label={muted ? "Activar sonido (M)" : "Silenciar (M)"}
              >
                {muted || volume === 0 ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </IconBtn>
              <input
                type="range"
                aria-label="Volumen"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => onSetVolume(Number.parseFloat(e.target.value))}
                className="h-1 w-0 cursor-pointer appearance-none rounded bg-lineStrong accent-accent opacity-0 transition-all focus:w-20 focus:opacity-100 focus:outline-none group-hover/vol:w-20 group-hover/vol:opacity-100"
              />
            </div>

            <span className="ml-2 font-mono text-xs tabular-nums text-ink2">
              {formatDuration(clampedCurrent)} / {formatDuration(safeDuration)}
            </span>

            <div className="ml-auto flex items-center gap-1">
              <SpeedMenu rate={playbackRate} onChange={onSetPlaybackRate} />
              <IconBtn
                onClick={toggleFullscreen}
                label={
                  isFullscreen
                    ? "Salir de pantalla completa (F)"
                    : "Pantalla completa (F)"
                }
              >
                {isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
              </IconBtn>
            </div>
          </div>
        </div>
      </div>
    );
  },
);

const IconBtn: React.FC<{
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}> = ({ onClick, label, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink2 transition hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
  >
    {children}
  </button>
);

/** Barra de progreso con buffer, thumb al hover y tooltip de tiempo. */
const ProgressBar: React.FC<{
  current: number;
  duration: number;
  bufferedEnd: number;
  onSeekTo: (s: number) => void;
}> = ({ current, duration, bufferedEnd, onSeekTo }) => {
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const bufPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;
  return (
    <div
      className="group/pb relative flex h-4 items-center"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
        setHover({ x, t: duration * (x / r.width) });
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div className="pointer-events-none relative h-1 w-full rounded bg-lineStrong/60 transition-all group-hover/pb:h-1.5">
        <div
          className="absolute inset-y-0 left-0 rounded bg-ink2/40"
          style={{ width: `${bufPct}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded bg-accent"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent opacity-0 transition-opacity group-hover/pb:opacity-100 group-focus-within/pb:opacity-100"
          style={{ left: `${pct}%` }}
        />
      </div>
      <input
        type="range"
        aria-label="Posición de reproducción"
        min={0}
        max={duration || 100}
        step={0.05}
        value={current}
        onChange={(e) => onSeekTo(Number.parseFloat(e.target.value))}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
      {hover && duration > 0 && (
        <span
          className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-surface2 px-1.5 py-0.5 font-mono text-[11px] text-ink"
          style={{ left: hover.x }}
        >
          {formatDuration(hover.t)}
        </span>
      )}
    </div>
  );
};

/** Velocidad: un solo botón con menú. */
const SpeedMenu: React.FC<{ rate: number; onChange: (r: number) => void }> = ({
  rate,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Velocidad de reproducción"
        onClick={() => setOpen((v) => !v)}
        className="h-8 rounded-md px-2 font-mono text-xs tabular-nums text-ink2 transition hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {rate}×
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-30 mb-1 min-w-[5rem] rounded-md border border-line bg-surface2 p-1 shadow-lg"
        >
          {PLAYBACK_SPEED_PRESETS.map((preset) => {
            const isCurrent = Math.abs(rate - preset) < 0.01;
            return (
              <button
                key={preset}
                type="button"
                role="menuitemradio"
                aria-checked={isCurrent}
                aria-label={`Velocidad ${preset}x`}
                onClick={() => {
                  onChange(preset);
                  setOpen(false);
                }}
                className={`block w-full rounded px-2 py-1 text-left font-mono text-xs ${
                  isCurrent ? "bg-accent text-app" : "text-ink hover:bg-line"
                }`}
              >
                {preset}×
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
