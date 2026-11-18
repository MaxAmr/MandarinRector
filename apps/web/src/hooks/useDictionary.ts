import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchDictionaryStatus,
  importDictionary,
  lookupDictionaryWord,
  type DictionaryLookupResponse,
  type DictionaryStatusResponse,
} from "../lib/api";

export function useDictionaryStatus() {
  return useQuery<DictionaryStatusResponse>({
    queryKey: ["dictionary", "status"],
    queryFn: fetchDictionaryStatus,
    staleTime: 60_000,
  });
}

export function useDictionaryWord(word: string | null) {
  return useQuery<DictionaryLookupResponse>({
    queryKey: ["dictionary", "word", word],
    queryFn: () => {
      if (!word) {
        throw new Error("Palabra vacía");
      }
      return lookupDictionaryWord(word);
    },
    enabled: Boolean(word && word.trim().length > 0),
    staleTime: Infinity,
    gcTime: 30 * 60 * 1000,
  });
}

export function useImportDictionary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (download: boolean) => importDictionary(download),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dictionary"] });
    },
  });
}
