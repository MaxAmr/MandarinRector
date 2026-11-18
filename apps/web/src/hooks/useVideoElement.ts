import { useCallback, useEffect, useRef, useState } from "react";
import { playbackClock } from "../lib/playbackClock";

export const PLAYBACK_SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5] as const;

export interface VideoElementState {
  currentTime: number;
  paused: boolean;
  duration: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  mediaError: string | null;
}

function describeMediaError(error: MediaError | null): string | null {
  if (!error) {
    return null;
  }
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "La carga del video fue abortada por el usuario.";
    case MediaError.MEDIA_ERR_NETWORK:
      return "Error de red mientras se descargaba el flujo de video.";
    case MediaError.MEDIA_ERR_DECODE:
      return "El video está corrupto o utiliza un codec que el navegador no pudo decodificar.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "El formato de video o la fuente de streaming no es compatible con este navegador.";
    default:
      return "Error desconocido al reproducir el video.";
  }
}

function applyPreservesPitch(el: HTMLVideoElement): void {
  const vendorEl = el as HTMLVideoElement & {
    mozPreservesPitch?: boolean;
    webkitPreservesPitch?: boolean;
  };
  if ("preservesPitch" in el) {
    el.preservesPitch = true;
  } else if ("mozPreservesPitch" in vendorEl) {
    vendorEl.mozPreservesPitch = true;
  } else if ("webkitPreservesPitch" in vendorEl) {
    vendorEl.webkitPreservesPitch = true;
  }
}

export function useVideoElement(externalDuration?: number | null) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);

  const [state, setState] = useState<VideoElementState>({
    currentTime: 0,
    paused: true,
    duration: externalDuration ?? 0,
    playbackRate: 1,
    volume: 1,
    muted: false,
    mediaError: null,
  });

  const bindVideoRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setElement(node);
    if (node) {
      playbackClock.attach(node);
    } else {
      playbackClock.detach();
    }
  }, []);

  useEffect(() => {
    if (!element) {
      return;
    }

    playbackClock.attach(element);
    applyPreservesPitch(element);

    let rafId: number | null = null;
    let lastReactStateSyncMs = 0;

    const syncStateFromVideo = (forceTimeUpdate = true) => {
      const now = performance.now();
      setState((prev) => {
        const nextDuration =
          Number.isFinite(element.duration) && element.duration > 0
            ? element.duration
            : (externalDuration ?? prev.duration);
        const nextTime = element.currentTime;
        const shouldUpdateTime =
          forceTimeUpdate ||
          now - lastReactStateSyncMs >= 120 ||
          Math.abs(nextTime - prev.currentTime) >= 0.15;

        if (shouldUpdateTime) {
          lastReactStateSyncMs = now;
        }

        const targetTime = shouldUpdateTime ? nextTime : prev.currentTime;
        const nextPaused = element.paused;
        const nextRate = element.playbackRate;
        const nextVolume = element.volume;
        const nextMuted = element.muted;
        const nextError = describeMediaError(element.error);

        if (
          prev.currentTime === targetTime &&
          prev.paused === nextPaused &&
          prev.duration === nextDuration &&
          prev.playbackRate === nextRate &&
          prev.volume === nextVolume &&
          prev.muted === nextMuted &&
          prev.mediaError === nextError
        ) {
          return prev;
        }

        return {
          currentTime: targetTime,
          paused: nextPaused,
          duration: nextDuration,
          playbackRate: nextRate,
          volume: nextVolume,
          muted: nextMuted,
          mediaError: nextError,
        };
      });
    };

    const tick = () => {
      rafId = null;
      if (!element || element.paused || element.ended) {
        syncStateFromVideo(true);
        return;
      }
      syncStateFromVideo(false);
      rafId = window.requestAnimationFrame(tick);
    };

    const startRaf = () => {
      syncStateFromVideo(true);
      if (rafId === null) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const stopRaf = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      syncStateFromVideo(true);
    };

    const handleImmediate = () => syncStateFromVideo(true);
    const handleRateChange = () => {
      applyPreservesPitch(element);
      syncStateFromVideo(true);
    };

    element.addEventListener("play", startRaf);
    element.addEventListener("playing", startRaf);
    element.addEventListener("pause", stopRaf);
    element.addEventListener("ended", stopRaf);
    element.addEventListener("loadedmetadata", handleImmediate);
    element.addEventListener("durationchange", handleImmediate);
    element.addEventListener("seeking", handleImmediate);
    element.addEventListener("seeked", handleImmediate);
    element.addEventListener("volumechange", handleImmediate);
    element.addEventListener("ratechange", handleRateChange);
    element.addEventListener("error", handleImmediate);

    syncStateFromVideo(true);
    if (!element.paused && !element.ended) {
      startRaf();
    }

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      playbackClock.detach();
      element.removeEventListener("play", startRaf);
      element.removeEventListener("playing", startRaf);
      element.removeEventListener("pause", stopRaf);
      element.removeEventListener("ended", stopRaf);
      element.removeEventListener("loadedmetadata", handleImmediate);
      element.removeEventListener("durationchange", handleImmediate);
      element.removeEventListener("seeking", handleImmediate);
      element.removeEventListener("seeked", handleImmediate);
      element.removeEventListener("volumechange", handleImmediate);
      element.removeEventListener("ratechange", handleRateChange);
      element.removeEventListener("error", handleImmediate);
    };
  }, [element, externalDuration]);

  const togglePlay = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused || el.ended) {
      try {
        await el.play();
      } catch {
        // Ignorar bloqueo de autoplay si ocurre
      }
    } else {
      el.pause();
    }
  }, []);

  const play = useCallback(async () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      try {
        await el.play();
      } catch {
        // Ignorar
      }
    }
  }, []);

  const pause = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!el.paused) {
      el.pause();
    }
  }, []);

  const seekTo = useCallback((seconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    const maxDur =
      Number.isFinite(el.duration) && el.duration > 0
        ? el.duration
        : Number.POSITIVE_INFINITY;
    const clamped = Math.max(0, Math.min(seconds, maxDur));
    el.currentTime = clamped;
    playbackClock.setTimeMs(clamped * 1000);
  }, []);

  const seekBy = useCallback(
    (deltaSeconds: number) => {
      const el = videoRef.current;
      if (!el) return;
      seekTo(el.currentTime + deltaSeconds);
    },
    [seekTo],
  );

  const setPlaybackRate = useCallback((rate: number) => {
    const el = videoRef.current;
    if (!el) return;
    applyPreservesPitch(el);
    el.playbackRate = rate;
  }, []);

  const stepPlaybackRate = useCallback(
    (direction: -1 | 1) => {
      const el = videoRef.current;
      if (!el) return;
      const current = el.playbackRate;
      let closestIdx = 0;
      let minDiff = Number.POSITIVE_INFINITY;
      PLAYBACK_SPEED_PRESETS.forEach((preset, idx) => {
        const diff = Math.abs(preset - current);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = idx;
        }
      });
      const nextIdx = Math.max(
        0,
        Math.min(PLAYBACK_SPEED_PRESETS.length - 1, closestIdx + direction),
      );
      setPlaybackRate(PLAYBACK_SPEED_PRESETS[nextIdx]);
    },
    [setPlaybackRate],
  );

  const setVolume = useCallback((volume: number) => {
    const el = videoRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(1, volume));
    el.volume = clamped;
    if (clamped > 0 && el.muted) {
      el.muted = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
  }, []);

  return {
    videoRef,
    bindVideoRef,
    ...state,
    togglePlay,
    play,
    pause,
    seekTo,
    seekBy,
    setPlaybackRate,
    stepPlaybackRate,
    setVolume,
    toggleMute,
  };
}
