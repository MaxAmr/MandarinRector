import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteVideo,
  fetchVideos,
  updateVideoTitle,
  type VideoListItem,
} from "../lib/api";

export const VIDEOS_QUERY_KEY = ["videos"] as const;

export function useVideos() {
  return useQuery<VideoListItem[]>({
    queryKey: VIDEOS_QUERY_KEY,
    queryFn: fetchVideos,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (!items) {
        return false;
      }
      const hasProcessing = items.some((v) => v.status === "processing");
      return hasProcessing ? 2000 : false;
    },
  });
}

export function useRenameVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ videoId, title }: { videoId: number; title: string }) =>
      updateVideoTitle(videoId, title),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      queryClient.setQueryData(["video", updated.id], updated);
    },
  });
}

export function useDeleteVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (videoId: number) => deleteVideo(videoId),
    onSuccess: (_data, videoId) => {
      queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      queryClient.removeQueries({ queryKey: ["video", videoId] });
    },
  });
}
