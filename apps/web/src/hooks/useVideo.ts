import { useQuery } from "@tanstack/react-query";
import { fetchVideo, type VideoRead } from "../lib/api";

export function useVideo(videoId: number | null) {
  return useQuery<VideoRead>({
    queryKey: ["video", videoId],
    queryFn: () => {
      if (videoId === null) {
        throw new Error("videoId inválido");
      }
      return fetchVideo(videoId);
    },
    enabled: videoId !== null && Number.isFinite(videoId) && videoId > 0,
    refetchInterval: (query) => {
      const video = query.state.data;
      if (!video) {
        return false;
      }
      if (video.status === "processing") {
        return 2000;
      }
      const hasTokenizingTrack = video.subtitle_tracks.some(
        (t) => t.tokens_status === "pending" || t.tokens_status === "processing",
      );
      return hasTokenizingTrack ? 1500 : false;
    },
  });
}
