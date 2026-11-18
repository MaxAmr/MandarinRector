import { useSyncExternalStore } from "react";

type ClockListener = () => void;

class PlaybackClock {
  private timeMs = 0;
  private videoElement: HTMLVideoElement | null = null;
  private rafId: number | null = null;
  private listeners = new Set<ClockListener>();
  private cleanupEvents: (() => void) | null = null;

  public getTimeMs = (): number => {
    return this.timeMs;
  };

  public subscribe = (listener: ClockListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public setTimeMs(nextTimeMs: number): void {
    const rounded = Math.max(0, Math.round(nextTimeMs));
    if (rounded === this.timeMs) {
      return;
    }
    this.timeMs = rounded;
    this.notify();
  }

  public syncFromElement(): void {
    if (!this.videoElement) {
      return;
    }
    const nextMs = Math.max(0, Math.round(this.videoElement.currentTime * 1000));
    if (nextMs !== this.timeMs) {
      this.timeMs = nextMs;
      this.notify();
    }
  }

  public attach(element: HTMLVideoElement | null): void {
    if (this.videoElement === element && this.cleanupEvents !== null) {
      return;
    }

    this.detach();
    this.videoElement = element;
    if (!element) {
      this.setTimeMs(0);
      return;
    }

    this.syncFromElement();

    const handlePlay = () => {
      this.syncFromElement();
      this.startLoop();
    };

    const handleStop = () => {
      this.stopLoop();
      this.syncFromElement();
    };

    const handleImmediateSync = () => {
      this.syncFromElement();
    };

    element.addEventListener("play", handlePlay);
    element.addEventListener("playing", handlePlay);
    element.addEventListener("pause", handleStop);
    element.addEventListener("ended", handleStop);
    element.addEventListener("waiting", handleStop);
    element.addEventListener("seeking", handleImmediateSync);
    element.addEventListener("seeked", handleImmediateSync);
    element.addEventListener("ratechange", handleImmediateSync);
    element.addEventListener("loadedmetadata", handleImmediateSync);
    element.addEventListener("timeupdate", handleImmediateSync);

    if (!element.paused && !element.ended) {
      this.startLoop();
    }

    this.cleanupEvents = () => {
      element.removeEventListener("play", handlePlay);
      element.removeEventListener("playing", handlePlay);
      element.removeEventListener("pause", handleStop);
      element.removeEventListener("ended", handleStop);
      element.removeEventListener("waiting", handleStop);
      element.removeEventListener("seeking", handleImmediateSync);
      element.removeEventListener("seeked", handleImmediateSync);
      element.removeEventListener("ratechange", handleImmediateSync);
      element.removeEventListener("loadedmetadata", handleImmediateSync);
      element.removeEventListener("timeupdate", handleImmediateSync);
    };
  }

  public detach(): void {
    this.stopLoop();
    if (this.cleanupEvents) {
      this.cleanupEvents();
      this.cleanupEvents = null;
    }
    this.videoElement = null;
  }

  private startLoop(): void {
    if (this.rafId !== null || typeof window === "undefined") {
      return;
    }
    const tick = () => {
      this.rafId = null;
      if (!this.videoElement || this.videoElement.paused || this.videoElement.ended) {
        this.syncFromElement();
        return;
      }
      this.syncFromElement();
      this.rafId = window.requestAnimationFrame(tick);
    };
    this.rafId = window.requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const playbackClock = new PlaybackClock();

export function getTimeMs(): number {
  return playbackClock.getTimeMs();
}

export function subscribe(listener: ClockListener): () => void {
  return playbackClock.subscribe(listener);
}

export function useClockSelector<T extends string | number | boolean | null>(
  selector: (timeMs: number) => T,
): T {
  return useSyncExternalStore(
    playbackClock.subscribe,
    () => selector(playbackClock.getTimeMs()),
    () => selector(0),
  );
}
