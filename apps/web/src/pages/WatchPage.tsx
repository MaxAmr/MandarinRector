import { ArrowLeft } from "lucide-react";
import { S } from "../lib/strings";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { WordActivateInfo } from "../components/CueText";
import { PhrasesDrawer } from "../components/PhrasesDrawer";
import {
  SavePhraseModal,
  type SavePhraseInitialData,
} from "../components/SavePhraseModal";
import { ShortcutsModal } from "../components/ShortcutsModal";
import { SubtitlePanel } from "../components/SubtitlePanel";
import { SubtitleToolbar } from "../components/SubtitleToolbar";
import { SubtitleUploadDialog } from "../components/SubtitleUploadDialog";
import { VideoPlayer } from "../components/VideoPlayer";
import { WordPopup } from "../components/WordPopup";
import {
  useCues,
  useDeleteTrack,
  useRetokenize,
  useSubtitleTracks,
  useUpdateTrack,
  useUploadSubtitle,
} from "../hooks/useSubtitles";
import { useVideo } from "../hooks/useVideo";
import { useVideoElement } from "../hooks/useVideoElement";
import type {
  CueRead,
  SubtitleLang,
  SubtitleTrackRead,
  SubtitleTrackUpdatePayload,
} from "../lib/api";
import { applyOffsetToCues, findBestOverlapIndex, findCueIndexAt } from "../lib/cues";
import { playbackClock } from "../lib/playbackClock";
import { useStudyStore } from "../store/studyStore";

const MAX_OFFSET_MS = 600_000;

function isInteractiveInputFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  return target.isContentEditable;
}

/**
 * Página de reproducción y estudio sincronizado.
 *
 * Decisiones de diseño documentadas:
 * 1. Offset en cliente + persistencia con debounce de 400 ms: los tiempos de los cues se
 *    desplazan en memoria (`applyOffsetToCues`) para respuesta visual instantánea al pulsar
 *    `G`/`H`, y el nuevo `offset_ms` se envía mediante `PATCH /api/subtitles/{id}` tras 400 ms
 *    de inactividad con actualización optimista en React Query.
 * 2. Cancelación de Loop (`L`): si el usuario hace un seek manual fuera de
 *    `[start_ms - 500, end_ms + 500]`, navega a otro cue con `A`/`D` o hace click en otra
 *    fila del panel, el loop activo se cancela (`loopCueIdx = null`) para no atrapar la
 *    reproducción inesperadamente.
 */
export const WatchPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const videoId = id ? Number.parseInt(id, 10) : null;

  const {
    data: video,
    isLoading: isVideoLoading,
    isError: isVideoError,
    error: videoError,
  } = useVideo(videoId);

  const { data: tracksData } = useSubtitleTracks(videoId);
  const tracks: SubtitleTrackRead[] = useMemo(
    () => tracksData ?? video?.subtitle_tracks ?? [],
    [tracksData, video?.subtitle_tracks],
  );

  const uploadSubtitleMutation = useUploadSubtitle(videoId ?? 0);
  const updateTrackMutation = useUpdateTrack(videoId ?? 0);
  const retokenizeMutation = useRetokenize(videoId ?? 0);
  const deleteTrackMutation = useDeleteTrack(videoId ?? 0);

  const showPanel = useStudyStore((s) => s.showPanel);
  const pauseAfterCue = useStudyStore((s) => s.pauseAfterCue);
  const togglePauseAfterCue = useStudyStore((s) => s.togglePauseAfterCue);
  const toggleOverlay = useStudyStore((s) => s.toggleOverlay);
  const toggleSecondary = useStudyStore((s) => s.toggleSecondary);
  const togglePinyinOverlay = useStudyStore((s) => s.togglePinyinOverlay);
  const toggleColorTones = useStudyStore((s) => s.toggleColorTones);
  const dictionaryTrigger = useStudyStore((s) => s.dictionaryTrigger);
  const pauseOnLookup = useStudyStore((s) => s.pauseOnLookup);
  const loopPadMs = useStudyStore((s) => s.loopPadMs);
  const loopCueIdx = useStudyStore((s) => s.loopCueIdx);
  const setLoopCueIdx = useStudyStore((s) => s.setLoopCueIdx);
  const toggleLoopCueIdx = useStudyStore((s) => s.toggleLoopCueIdx);
  const primaryTrackIdByVideo = useStudyStore((s) => s.primaryTrackIdByVideo);
  const secondaryTrackIdByVideo = useStudyStore((s) => s.secondaryTrackIdByVideo);
  const setPrimaryTrackForVideo = useStudyStore((s) => s.setPrimaryTrackForVideo);
  const setSecondaryTrackForVideo = useStudyStore((s) => s.setSecondaryTrackForVideo);

  // Limpiar loop efímero al cambiar de video
  useEffect(() => {
    setLoopCueIdx(null);
  }, [videoId, setLoopCueIdx]);

  // Selección de pista primaria y secundaria
  const selectedPrimaryTrack = useMemo<SubtitleTrackRead | null>(() => {
    if (tracks.length === 0) return null;
    const storedId = videoId ? primaryTrackIdByVideo[videoId] : undefined;
    if (storedId !== undefined) {
      const found = tracks.find((t) => t.id === storedId);
      if (found) return found;
    }
    return tracks.find((t) => t.is_primary) ?? tracks[0];
  }, [tracks, videoId, primaryTrackIdByVideo]);

  const selectedSecondaryTrack = useMemo<SubtitleTrackRead | null>(() => {
    if (tracks.length < 2 || !selectedPrimaryTrack) return null;
    const storedSecondary =
      videoId !== null ? secondaryTrackIdByVideo[videoId] : undefined;
    if (storedSecondary === null) {
      return null;
    }
    if (storedSecondary !== undefined && storedSecondary !== selectedPrimaryTrack.id) {
      const found = tracks.find((t) => t.id === storedSecondary);
      if (found) return found;
    }
    return tracks.find((t) => t.id !== selectedPrimaryTrack.id) ?? null;
  }, [tracks, videoId, secondaryTrackIdByVideo, selectedPrimaryTrack]);

  // Offset local inmediato + debounce 400 ms hacia backend
  const [localOffsetOverride, setLocalOffsetOverride] = useState<{
    trackId: number;
    offsetMs: number;
  } | null>(null);
  const offsetDebounceRef = useRef<number | null>(null);

  const effectivePrimaryOffsetMs = useMemo(() => {
    if (!selectedPrimaryTrack) return 0;
    if (localOffsetOverride && localOffsetOverride.trackId === selectedPrimaryTrack.id) {
      return localOffsetOverride.offsetMs;
    }
    return selectedPrimaryTrack.offset_ms;
  }, [selectedPrimaryTrack, localOffsetOverride]);

  const scheduleOffsetPersist = useCallback(
    (trackId: number, nextOffsetMs: number) => {
      const clamped = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, nextOffsetMs));
      setLocalOffsetOverride({ trackId, offsetMs: clamped });
      if (offsetDebounceRef.current !== null) {
        window.clearTimeout(offsetDebounceRef.current);
      }
      offsetDebounceRef.current = window.setTimeout(() => {
        offsetDebounceRef.current = null;
        updateTrackMutation.mutate({
          trackId,
          payload: { offset_ms: clamped },
        });
      }, 400);
    },
    [updateTrackMutation],
  );

  useEffect(() => {
    return () => {
      if (offsetDebounceRef.current !== null) {
        window.clearTimeout(offsetDebounceRef.current);
      }
    };
  }, []);

  const handleAdjustOffsetMs = useCallback(
    (deltaMs: number) => {
      if (!selectedPrimaryTrack) return;
      scheduleOffsetPersist(selectedPrimaryTrack.id, effectivePrimaryOffsetMs + deltaMs);
    },
    [selectedPrimaryTrack, effectivePrimaryOffsetMs, scheduleOffsetPersist],
  );

  const handleResetOffsetMs = useCallback(() => {
    if (!selectedPrimaryTrack) return;
    scheduleOffsetPersist(selectedPrimaryTrack.id, 0);
  }, [selectedPrimaryTrack, scheduleOffsetPersist]);

  // Carga de cues de pista primaria y secundaria
  const {
    data: primaryCuesData,
    isLoading: isPrimaryCuesLoading,
    error: primaryCuesError,
  } = useCues(selectedPrimaryTrack?.id ?? null);

  const { data: secondaryCuesData } = useCues(selectedSecondaryTrack?.id ?? null);

  const primaryCuesWithOffset = useMemo<CueRead[]>(() => {
    const raw = primaryCuesData?.cues ?? [];
    return applyOffsetToCues(raw, effectivePrimaryOffsetMs);
  }, [primaryCuesData?.cues, effectivePrimaryOffsetMs]);

  const secondaryCuesWithOffset = useMemo<CueRead[]>(() => {
    const raw = secondaryCuesData?.cues ?? [];
    const secOffset = selectedSecondaryTrack?.offset_ms ?? 0;
    return applyOffsetToCues(raw, secOffset);
  }, [secondaryCuesData?.cues, selectedSecondaryTrack?.offset_ms]);

  const player = useVideoElement(video?.duration);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const isInternalSeekRef = useRef(false);

  const [isUploadSubOpen, setIsUploadSubOpen] = useState(false);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

  // Fase 4: Estado del diccionario WordPopup (click + hover opcional)
  const [activeWord, setActiveWord] = useState<WordActivateInfo | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const wasPausedBeforeLookupRef = useRef<boolean | null>(null);

  const openWordPopup = useCallback(
    (info: WordActivateInfo) => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
        hoverTimerRef.current = null;
      }
      if (pauseOnLookup && wasPausedBeforeLookupRef.current === null) {
        const el = player.videoRef.current;
        if (el) {
          wasPausedBeforeLookupRef.current = el.paused;
          if (!el.paused) {
            player.pause();
          }
        }
      }
      setActiveWord(info);
    },
    [pauseOnLookup, player],
  );

  const closeWordPopup = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setActiveWord(null);
    if (wasPausedBeforeLookupRef.current === false) {
      void player.play();
    }
    wasPausedBeforeLookupRef.current = null;
  }, [player]);

  const handleWordHover = useCallback(
    (info: WordActivateInfo) => {
      if (dictionaryTrigger !== "hover") {
        return;
      }
      if (activeWord?.pinned) {
        return;
      }
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        openWordPopup(info);
      }, 200);
    },
    [dictionaryTrigger, activeWord?.pinned, openWordPopup],
  );

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    };
  }, []);

  const seekToCueAndPlay = useCallback(
    (cue: CueRead, keepLoopIdx: number | null = null) => {
      isInternalSeekRef.current = true;
      setLoopCueIdx(keepLoopIdx);
      const targetSeconds = Math.max(0, cue.start_ms / 1000 + 0.01);
      player.seekTo(targetSeconds);
      void player.play();
      window.setTimeout(() => {
        isInternalSeekRef.current = false;
      }, 120);
    },
    [player, setLoopCueIdx],
  );

  // Controles de estudio sobre cues (A, D, R, L)
  const handlePrevCue = useCallback(() => {
    if (primaryCuesWithOffset.length === 0) return;
    const nowMs = playbackClock.getTimeMs();
    const stickyIdx = findCueIndexAt(primaryCuesWithOffset, nowMs);
    if (stickyIdx <= 0) {
      seekToCueAndPlay(primaryCuesWithOffset[0], null);
      return;
    }
    const currentCue = primaryCuesWithOffset[stickyIdx];
    // Si estamos a < 400 ms del inicio del cue sticky, saltamos al anterior; si no, reiniciamos el actual
    if (nowMs - currentCue.start_ms < 400) {
      seekToCueAndPlay(primaryCuesWithOffset[stickyIdx - 1], null);
    } else {
      seekToCueAndPlay(currentCue, null);
    }
  }, [primaryCuesWithOffset, seekToCueAndPlay]);

  const handleNextCue = useCallback(() => {
    if (primaryCuesWithOffset.length === 0) return;
    const nowMs = playbackClock.getTimeMs();
    const stickyIdx = findCueIndexAt(primaryCuesWithOffset, nowMs);
    const nextIdx = Math.min(
      primaryCuesWithOffset.length - 1,
      Math.max(0, stickyIdx + 1),
    );
    seekToCueAndPlay(primaryCuesWithOffset[nextIdx], null);
  }, [primaryCuesWithOffset, seekToCueAndPlay]);

  const handleRepeatCue = useCallback(() => {
    if (primaryCuesWithOffset.length === 0) return;
    const nowMs = playbackClock.getTimeMs();
    const stickyIdx = Math.max(0, findCueIndexAt(primaryCuesWithOffset, nowMs));
    seekToCueAndPlay(primaryCuesWithOffset[stickyIdx], loopCueIdx);
  }, [primaryCuesWithOffset, seekToCueAndPlay, loopCueIdx]);

  const handleToggleLoopCurrentCue = useCallback(() => {
    if (primaryCuesWithOffset.length === 0) return;
    const nowMs = playbackClock.getTimeMs();
    const stickyIdx = Math.max(0, findCueIndexAt(primaryCuesWithOffset, nowMs));
    const targetCue = primaryCuesWithOffset[stickyIdx];
    toggleLoopCueIdx(targetCue.idx);
  }, [primaryCuesWithOffset, toggleLoopCueIdx]);

  // Fase 6: Guardar frase y cortar clip (modal con pre-carga del cue actual o palabra)
  const [savePhraseInitial, setSavePhraseInitial] =
    useState<SavePhraseInitialData | null>(null);

  const openSaveModalForCue = useCallback(
    (cue: CueRead, focusWord?: string | null, defaultNotes?: string | null) => {
      if (videoId === null) return;
      player.pause();
      // Traducción real: solo si la pista secundaria está en otro idioma que la
      // primaria. Si es una variante del mismo idioma (p. ej. chino tradicional),
      // no es una traducción y va a notas.
      const primaryIsZh = (selectedPrimaryTrack?.lang ?? "zh") === "zh";
      // Un texto con hanzi no es traducción de una frase en chino (es otra variante).
      const looksLikeVariant = (text: string) =>
        primaryIsZh && /[\u3400-\u9fff]/.test(text);
      let pairedTranslation =
        cue.translation_text && !looksLikeVariant(cue.translation_text)
          ? cue.translation_text
          : null;
      let sameLangVariant: string | null = null;
      if (secondaryCuesWithOffset.length > 0) {
        const matchIdx = findBestOverlapIndex(cue, secondaryCuesWithOffset);
        if (matchIdx !== null) {
          const secText = secondaryCuesWithOffset[matchIdx].text;
          const isSameLang =
            looksLikeVariant(secText) ||
            (!!selectedSecondaryTrack &&
              !!selectedPrimaryTrack &&
              selectedSecondaryTrack.lang === selectedPrimaryTrack.lang);
          if (isSameLang) {
            sameLangVariant = secText;
          } else {
            pairedTranslation = secText;
          }
        }
      }
      const gloss = defaultNotes ?? null;
      // Traducción = traducción de la frase completa. La glosa de la palabra foco
      // (CEDICT) siempre va a notas. Si no hay traducción, el modal la pide al backend.
      const finalTranslation: string | null = pairedTranslation;
      const finalNotes: string | null =
        [gloss, sameLangVariant].filter(Boolean).join("\n") || null;
      setSavePhraseInitial({
        videoId,
        trackId: selectedPrimaryTrack?.id ?? null,
        cue,
        rawCueStartMs: cue.start_ms - effectivePrimaryOffsetMs,
        rawCueEndMs: cue.end_ms - effectivePrimaryOffsetMs,
        trackOffsetMs: effectivePrimaryOffsetMs,
        focusWord: focusWord ?? null,
        defaultTranslation: finalTranslation,
        defaultNotes: finalNotes,
      });
    },
    [
      videoId,
      player,
      secondaryCuesWithOffset,
      selectedPrimaryTrack,
      selectedSecondaryTrack,
      effectivePrimaryOffsetMs,
    ],
  );

  const handleSaveCurrentCue = useCallback(() => {
    if (primaryCuesWithOffset.length === 0) return;
    const nowMs = playbackClock.getTimeMs();
    const stickyIdx = Math.max(0, findCueIndexAt(primaryCuesWithOffset, nowMs));
    openSaveModalForCue(primaryCuesWithOffset[stickyIdx]);
  }, [primaryCuesWithOffset, openSaveModalForCue]);

  const handleSaveWordPhrase = useCallback(
    (info: { word: string; cueIdx: number; topDefinition: string | null }) => {
      const cue =
        primaryCuesWithOffset.find((c) => c.idx === info.cueIdx) ??
        primaryCuesWithOffset[0];
      if (!cue) return;
      closeWordPopup();
      openSaveModalForCue(cue, info.word, info.topDefinition);
    },
    [primaryCuesWithOffset, closeWordPopup, openSaveModalForCue],
  );

  // Evaluar Loop (L) y Pausa al final de cue (P) en cada tick del reloj externo
  const lastPauseTriggeredCueIdxRef = useRef<number | null>(null);
  const prevTickTimeMsRef = useRef<number>(0);

  useEffect(() => {
    const unsubscribe = playbackClock.subscribe(() => {
      const timeMs = playbackClock.getTimeMs();
      const prevTimeMs = prevTickTimeMsRef.current;
      prevTickTimeMsRef.current = timeMs;

      // 1. Evaluar Loop de cue activo (L)
      if (loopCueIdx !== null && primaryCuesWithOffset.length > 0) {
        const loopCue = primaryCuesWithOffset.find((c) => c.idx === loopCueIdx);
        if (loopCue) {
          // Si hubo un salto manual fuera de [start_ms - 500, end_ms + 500], cancelar el loop
          if (
            !isInternalSeekRef.current &&
            (timeMs < loopCue.start_ms - 500 || timeMs > loopCue.end_ms + loopPadMs + 500)
          ) {
            setLoopCueIdx(null);
            return;
          }
          if (timeMs >= loopCue.end_ms + loopPadMs) {
            isInternalSeekRef.current = true;
            player.seekTo(Math.max(0, loopCue.start_ms / 1000 + 0.01));
            void player.play();
            window.setTimeout(() => {
              isInternalSeekRef.current = false;
            }, 80);
            return;
          }
        }
      }

      // 2. Evaluar Pausa automática al cruzar end_ms del cue activo (P)
      if (pauseAfterCue && loopCueIdx === null && primaryCuesWithOffset.length > 0) {
        const stickyIdx = findCueIndexAt(primaryCuesWithOffset, timeMs);
        if (stickyIdx >= 0) {
          const cue = primaryCuesWithOffset[stickyIdx];
          if (
            prevTimeMs < cue.end_ms &&
            timeMs >= cue.end_ms &&
            timeMs - prevTimeMs < 600 &&
            lastPauseTriggeredCueIdxRef.current !== cue.idx
          ) {
            lastPauseTriggeredCueIdxRef.current = cue.idx;
            player.pause();
          } else if (timeMs < cue.end_ms - 100) {
            if (lastPauseTriggeredCueIdxRef.current === cue.idx) {
              lastPauseTriggeredCueIdxRef.current = null;
            }
          }
        }
      }
    });

    return unsubscribe;
  }, [
    loopCueIdx,
    loopPadMs,
    pauseAfterCue,
    primaryCuesWithOffset,
    player,
    setLoopCueIdx,
  ]);

  // Atajos globales de teclado (Fase 1 + Fase 2)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInteractiveInputFocused(e.target)) {
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) {
        return;
      }

      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        setIsShortcutsOpen((v) => !v);
        return;
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          void player.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          player.seekBy(-5);
          break;
        case "ArrowRight":
          e.preventDefault();
          player.seekBy(5);
          break;
        case "[":
          e.preventDefault();
          player.stepPlaybackRate(-1);
          break;
        case "]":
          e.preventDefault();
          player.stepPlaybackRate(1);
          break;
        case "m":
        case "M":
          e.preventDefault();
          player.toggleMute();
          break;
        case "f":
        case "F": {
          e.preventDefault();
          const container = playerContainerRef.current;
          if (container) {
            if (!document.fullscreenElement) {
              void container.requestFullscreen().catch(() => undefined);
            } else {
              void document.exitFullscreen().catch(() => undefined);
            }
          }
          break;
        }
        case "a":
        case "A":
          e.preventDefault();
          handlePrevCue();
          break;
        case "d":
        case "D":
          e.preventDefault();
          handleNextCue();
          break;
        case "r":
        case "R":
          e.preventDefault();
          handleRepeatCue();
          break;
        case "l":
        case "L":
          e.preventDefault();
          handleToggleLoopCurrentCue();
          break;
        case "p":
        case "P":
          e.preventDefault();
          togglePauseAfterCue();
          break;
        case "t":
        case "T":
          e.preventDefault();
          toggleSecondary();
          break;
        case "c":
        case "C":
          e.preventDefault();
          toggleOverlay();
          break;
        case "y":
        case "Y":
          e.preventDefault();
          togglePinyinOverlay();
          break;
        case "k":
        case "K":
          e.preventDefault();
          toggleColorTones();
          break;
        case "s":
        case "S":
          e.preventDefault();
          handleSaveCurrentCue();
          break;
        case "g":
        case "G":
          e.preventDefault();
          handleAdjustOffsetMs(-100);
          break;
        case "h":
        case "H":
          e.preventDefault();
          handleAdjustOffsetMs(100);
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    player,
    handlePrevCue,
    handleNextCue,
    handleRepeatCue,
    handleToggleLoopCurrentCue,
    togglePauseAfterCue,
    toggleSecondary,
    toggleOverlay,
    togglePinyinOverlay,
    toggleColorTones,
    handleSaveCurrentCue,
    handleAdjustOffsetMs,
  ]);

  if (isVideoLoading) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6">
        <div className="h-8 w-48 animate-pulse rounded-lg bg-surface2" />
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="aspect-video animate-pulse rounded-lg bg-surface lg:col-span-8" />
          <div className="h-[540px] animate-pulse rounded-lg bg-surface lg:col-span-4" />
        </div>
      </div>
    );
  }

  if (isVideoError || !video) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-lg font-semibold text-rose-400">
          Video no encontrado o no disponible
        </h1>
        <p className="mt-2 text-xs text-ink2">
          {videoError instanceof Error
            ? videoError.message
            : "El video solicitado no existe."}
        </p>
        <Link
          to="/"
          className="mt-5 inline-block rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app hover:bg-accent/90"
        >
          Volver a la biblioteca
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[1800px] flex-col gap-3 px-4 py-3 sm:px-6">
      {/* Cabecera */}
      <header className="flex shrink-0 items-center gap-3">
        <Link
          to="/"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-ink2 transition hover:bg-surface2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {S.library}
        </Link>
        <h1
          title={video.title}
          className="min-w-0 flex-1 truncate text-sm font-semibold text-ink sm:text-base"
        >
          {video.title}
        </h1>
        <div className="hidden shrink-0 items-center gap-2 text-xs text-ink2 sm:flex">
          {video.width && video.height && (
            <span className="rounded bg-surface px-2 py-0.5 font-mono">
              {video.width}×{video.height}
            </span>
          )}
          {video.video_codec && (
            <span className="rounded bg-surface px-2 py-0.5 font-mono uppercase">
              {video.video_codec}
            </span>
          )}
        </div>
      </header>

      {/* Layout principal: Reproductor + Toolbar a la izquierda, Panel de subtítulos a la derecha */}
      <div className="grid grid-cols-1 gap-4 lg:h-[calc(100vh-5.5rem)] lg:min-h-[480px] lg:grid-cols-12 lg:grid-rows-1">
        <div
          className={`flex min-h-0 flex-col gap-3 ${
            showPanel ? "lg:col-span-8" : "lg:col-span-12"
          }`}
        >
          <VideoPlayer
            ref={player.videoRef}
            containerRef={playerContainerRef}
            streamUrl={video.stream_url}
            thumbnailUrl={video.thumbnail_url}
            currentTime={player.currentTime}
            duration={player.duration}
            paused={player.paused}
            playbackRate={player.playbackRate}
            volume={player.volume}
            muted={player.muted}
            mediaError={player.mediaError}
            primaryCues={primaryCuesWithOffset}
            primaryLang={selectedPrimaryTrack?.lang}
            primaryScript={selectedPrimaryTrack?.script}
            secondaryCues={secondaryCuesWithOffset}
            secondaryLang={selectedSecondaryTrack?.lang}
            secondaryScript={selectedSecondaryTrack?.script}
            loopActive={loopCueIdx !== null}
            pauseAfterCueActive={pauseAfterCue}
            onBindVideoRef={player.bindVideoRef}
            onTogglePlay={() => void player.togglePlay()}
            onSeekTo={(sec) => player.seekTo(sec)}
            onSeekBy={(delta) => player.seekBy(delta)}
            onSetPlaybackRate={(rate) => player.setPlaybackRate(rate)}
            onSetVolume={(vol) => player.setVolume(vol)}
            onToggleMute={() => player.toggleMute()}
            onWordActivate={openWordPopup}
            onWordHover={dictionaryTrigger === "hover" ? handleWordHover : undefined}
            overlayPopup={
              activeWord?.source === "overlay" ? (
                <WordPopup
                  activeWord={activeWord}
                  onClose={closeWordPopup}
                  onSaveWordPhrase={handleSaveWordPhrase}
                />
              ) : null
            }
          />

          <SubtitleToolbar
            tracks={tracks}
            selectedPrimaryTrack={selectedPrimaryTrack}
            selectedSecondaryTrackId={selectedSecondaryTrack?.id ?? null}
            effectiveOffsetMs={effectivePrimaryOffsetMs}
            onSelectPrimaryTrack={(trackId) => {
              if (videoId !== null) {
                setPrimaryTrackForVideo(videoId, trackId);
              }
            }}
            onSelectSecondaryTrack={(trackId) => {
              if (videoId !== null) {
                setSecondaryTrackForVideo(videoId, trackId);
              }
            }}
            onAdjustOffsetMs={handleAdjustOffsetMs}
            onResetOffsetMs={handleResetOffsetMs}
            onPrevCue={handlePrevCue}
            onNextCue={handleNextCue}
            onRepeatCue={handleRepeatCue}
            onToggleLoopCurrentCue={handleToggleLoopCurrentCue}
            onSaveCurrentCue={handleSaveCurrentCue}
            onOpenUploadDialog={() => setIsUploadSubOpen(true)}
            onOpenShortcutsModal={() => setIsShortcutsOpen(true)}
            onUpdateTrack={(trackId, payload: SubtitleTrackUpdatePayload) =>
              updateTrackMutation.mutate({ trackId, payload })
            }
            onRetokenizeTrack={(trackId) => retokenizeMutation.mutate(trackId)}
            onDeleteTrack={(trackId) => deleteTrackMutation.mutate(trackId)}
          />
        </div>

        {showPanel && (
          <div className="min-h-0 lg:col-span-4">
            <SubtitlePanel
              hasTracks={tracks.length > 0}
              isLoading={isPrimaryCuesLoading}
              error={primaryCuesError instanceof Error ? primaryCuesError.message : null}
              primaryCues={primaryCuesWithOffset}
              primaryLang={selectedPrimaryTrack?.lang}
              primaryScript={selectedPrimaryTrack?.script}
              secondaryCues={secondaryCuesWithOffset}
              secondaryLang={selectedSecondaryTrack?.lang}
              onSeekAndPlay={(cue) => seekToCueAndPlay(cue, null)}
              onOpenUploadDialog={() => setIsUploadSubOpen(true)}
              onWordActivate={openWordPopup}
              onWordHover={dictionaryTrigger === "hover" ? handleWordHover : undefined}
            />
          </div>
        )}
      </div>

      {videoId !== null && (
        <PhrasesDrawer
          videoId={videoId}
          onJumpToTimeMs={(ms) => {
            player.seekTo(Math.max(0, ms / 1000));
            void player.play();
          }}
        />
      )}

      <SavePhraseModal
        isOpen={savePhraseInitial !== null}
        initialData={savePhraseInitial}
        onClose={() => setSavePhraseInitial(null)}
      />

      <SubtitleUploadDialog
        isOpen={isUploadSubOpen}
        hasExistingTracks={tracks.length > 0}
        onClose={() => setIsUploadSubOpen(false)}
        onUpload={async (params) => {
          const uploaded = await uploadSubtitleMutation.mutateAsync(params);
          if (videoId !== null && uploaded.is_primary) {
            setPrimaryTrackForVideo(videoId, uploaded.id);
          }
          return uploaded;
        }}
        onConfirmUndLanguage={async (trackId, lang: SubtitleLang) => {
          await updateTrackMutation.mutateAsync({
            trackId,
            payload: { lang },
          });
        }}
      />

      <ShortcutsModal
        isOpen={isShortcutsOpen}
        onClose={() => setIsShortcutsOpen(false)}
      />

      {activeWord?.source === "panel" && (
        <WordPopup
          activeWord={activeWord}
          onClose={closeWordPopup}
          onSaveWordPhrase={handleSaveWordPhrase}
        />
      )}
    </div>
  );
};
