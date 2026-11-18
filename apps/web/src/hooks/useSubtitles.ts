import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSubtitleTrack,
  fetchSubtitleTracks,
  fetchTrackCues,
  triggerSubtitleTokenize,
  updateSubtitleTrack,
  uploadSubtitleTrack,
  type SubtitleTrackRead,
  type SubtitleTrackUpdatePayload,
  type TokensStatus,
  type TrackCuesResponse,
  type UploadSubtitleOptions,
  type VideoRead,
} from "../lib/api";
import { VIDEOS_QUERY_KEY } from "./useVideos";

export function useSubtitleTracks(videoId: number | null) {
  const queryClient = useQueryClient();
  const prevStatusMapRef = useRef<Map<number, TokensStatus>>(new Map());

  const query = useQuery<SubtitleTrackRead[]>({
    queryKey: ["subtitles", videoId],
    queryFn: () => {
      if (videoId === null) {
        throw new Error("videoId inválido");
      }
      return fetchSubtitleTracks(videoId);
    },
    enabled: videoId !== null && Number.isFinite(videoId) && videoId > 0,
    refetchInterval: (q) => {
      const tracks = q.state.data;
      if (!tracks) {
        return false;
      }
      const isProcessing = tracks.some(
        (t) => t.tokens_status === "pending" || t.tokens_status === "processing",
      );
      return isProcessing ? 1500 : false;
    },
  });

  useEffect(() => {
    const tracks = query.data;
    if (!tracks) {
      return;
    }
    const prevMap = prevStatusMapRef.current;
    for (const track of tracks) {
      const prevStatus = prevMap.get(track.id);
      if (
        prevStatus &&
        prevStatus !== track.tokens_status &&
        (track.tokens_status === "ready" ||
          track.tokens_status === "error" ||
          track.tokens_status === "not_applicable")
      ) {
        void queryClient.invalidateQueries({ queryKey: ["cues", track.id] });
      }
      prevMap.set(track.id, track.tokens_status);
    }
  }, [query.data, queryClient]);

  return query;
}

export function useCues(trackId: number | null) {
  return useQuery<TrackCuesResponse>({
    queryKey: ["cues", trackId],
    queryFn: () => {
      if (trackId === null) {
        throw new Error("trackId inválido");
      }
      return fetchTrackCues(trackId);
    },
    enabled: trackId !== null && Number.isFinite(trackId) && trackId > 0,
    staleTime: Infinity,
  });
}

export function useUploadSubtitle(videoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: Omit<UploadSubtitleOptions, "videoId">) =>
      uploadSubtitleTrack({ ...options, videoId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subtitles", videoId] });
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
      queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}

export function useUpdateTrack(videoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      trackId,
      payload,
    }: {
      trackId: number;
      payload: SubtitleTrackUpdatePayload;
    }) => updateSubtitleTrack(trackId, payload),
    onMutate: async ({ trackId, payload }) => {
      await queryClient.cancelQueries({ queryKey: ["subtitles", videoId] });
      await queryClient.cancelQueries({ queryKey: ["video", videoId] });

      const previousTracks = queryClient.getQueryData<SubtitleTrackRead[]>([
        "subtitles",
        videoId,
      ]);
      const previousVideo = queryClient.getQueryData<VideoRead>(["video", videoId]);

      const applyOptimisticToList = (list: SubtitleTrackRead[]): SubtitleTrackRead[] =>
        list.map((t) => {
          if (t.id === trackId) {
            return {
              ...t,
              ...(payload.label !== undefined ? { label: payload.label } : {}),
              ...(payload.lang !== undefined ? { lang: payload.lang } : {}),
              ...(payload.offset_ms !== undefined
                ? { offset_ms: payload.offset_ms }
                : {}),
              ...(payload.is_primary !== undefined
                ? { is_primary: payload.is_primary }
                : {}),
            };
          }
          if (payload.is_primary === true && t.is_primary) {
            return { ...t, is_primary: false };
          }
          return t;
        });

      if (previousTracks) {
        queryClient.setQueryData<SubtitleTrackRead[]>(
          ["subtitles", videoId],
          applyOptimisticToList(previousTracks),
        );
      }

      if (previousVideo) {
        queryClient.setQueryData<VideoRead>(["video", videoId], {
          ...previousVideo,
          subtitle_tracks: applyOptimisticToList(previousVideo.subtitle_tracks),
        });
      }

      return { previousTracks, previousVideo };
    },
    onError: (_err, _variables, context) => {
      if (context?.previousTracks) {
        queryClient.setQueryData(["subtitles", videoId], context.previousTracks);
      }
      if (context?.previousVideo) {
        queryClient.setQueryData(["video", videoId], context.previousVideo);
      }
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: ["subtitles", videoId] });
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
      if (variables.payload.lang !== undefined) {
        queryClient.invalidateQueries({
          queryKey: ["cues", variables.trackId],
        });
      }
    },
  });
}

export function useRetokenize(videoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (trackId: number) => triggerSubtitleTokenize(trackId, true),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["subtitles", videoId] });
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
      queryClient.invalidateQueries({ queryKey: ["cues", updated.id] });
    },
  });
}

export function useDeleteTrack(videoId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (trackId: number) => deleteSubtitleTrack(trackId),
    onSuccess: (_data, trackId) => {
      queryClient.removeQueries({ queryKey: ["cues", trackId] });
      queryClient.invalidateQueries({ queryKey: ["subtitles", videoId] });
      queryClient.invalidateQueries({ queryKey: ["video", videoId] });
      queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
    },
  });
}
