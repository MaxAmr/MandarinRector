import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, uploadVideoWithProgress, type VideoRead } from "../lib/api";
import { VIDEOS_QUERY_KEY } from "./useVideos";

export interface UploadProgressState {
  isUploading: boolean;
  percent: number;
  loadedBytes: number;
  totalBytes: number;
  error: string | null;
}

export function useUploadVideo() {
  const queryClient = useQueryClient();
  const abortRef = useRef<(() => void) | null>(null);

  const [state, setState] = useState<UploadProgressState>({
    isUploading: false,
    percent: 0,
    loadedBytes: 0,
    totalBytes: 0,
    error: null,
  });

  const reset = useCallback(() => {
    setState({
      isUploading: false,
      percent: 0,
      loadedBytes: 0,
      totalBytes: 0,
      error: null,
    });
  }, []);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
  }, []);

  const upload = useCallback(
    async (file: File, title?: string): Promise<VideoRead | null> => {
      setState({
        isUploading: true,
        percent: 0,
        loadedBytes: 0,
        totalBytes: file.size,
        error: null,
      });

      const handle = uploadVideoWithProgress({
        file,
        title,
        onProgress: (percent, loadedBytes, totalBytes) => {
          setState((prev) => ({
            ...prev,
            percent,
            loadedBytes,
            totalBytes,
          }));
        },
      });

      abortRef.current = handle.abort;

      try {
        const created = await handle.promise;
        abortRef.current = null;
        setState((prev) => ({
          ...prev,
          isUploading: false,
          percent: 100,
        }));
        await queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
        return created;
      } catch (err) {
        abortRef.current = null;
        const message =
          err instanceof ApiError
            ? err.detail
            : err instanceof Error
              ? err.message
              : "Error inesperado al subir el video.";
        setState((prev) => ({
          ...prev,
          isUploading: false,
          error: message,
        }));
        return null;
      }
    },
    [queryClient],
  );

  return {
    ...state,
    upload,
    cancel,
    reset,
  };
}
