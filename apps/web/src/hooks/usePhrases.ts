import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPhrase,
  deletePhrase,
  fetchPhrases,
  translateText,
  updatePhrase,
  type PhraseCreatePayload,
  type PhraseRead,
  type PhraseUpdatePayload,
} from "../lib/api";

export function usePhrases(videoId?: number | null, q?: string) {
  return useQuery<PhraseRead[]>({
    queryKey: ["phrases", { videoId: videoId ?? null, q: q ?? "" }],
    queryFn: () => fetchPhrases({ videoId, q }),
    refetchInterval: (query) => {
      const items = query.state.data;
      if (!items) {
        return false;
      }
      const isProcessing = items.some(
        (p) => p.clip_status === "pending" || p.clip_status === "processing",
      );
      return isProcessing ? 1500 : false;
    },
  });
}

export function useCreatePhrase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: PhraseCreatePayload) => createPhrase(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phrases"] });
    },
  });
}

export function useUpdatePhrase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      phraseId,
      payload,
    }: {
      phraseId: number;
      payload: PhraseUpdatePayload;
    }) => updatePhrase(phraseId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phrases"] });
    },
  });
}

export function useDeletePhrase() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (phraseId: number) => deletePhrase(phraseId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["phrases"] });
    },
  });
}

export function useTranslateText() {
  return useMutation({
    mutationFn: ({ text, targetLang }: { text: string; targetLang?: string }) =>
      translateText(text, targetLang ?? "es"),
  });
}
