import type { CueTokens } from "./tokens";

export type VideoStatus = "processing" | "ready" | "error";

export type SubtitleLang = "zh" | "es" | "en" | "ja" | "ko" | "und";

export type ChineseScript = "hans" | "hant" | "mixed" | null;

export type TokensStatus =
  "not_applicable" | "pending" | "processing" | "ready" | "error";

export interface SubtitleTrackRead {
  id: number;
  video_id: number;
  lang: SubtitleLang;
  label: string;
  is_primary: boolean;
  source_format: "srt" | "ass" | "ssa" | "vtt";
  original_filename: string;
  detected_encoding: string | null;
  cue_count: number;
  offset_ms: number;
  created_at: string;
  script: ChineseScript;
  tokens_status: TokensStatus;
  tokens_version: number | null;
  tokens_error: string | null;
}

export interface SubtitleUploadResponse extends SubtitleTrackRead {
  warnings: string[];
  skipped: number;
  lang_detected: boolean;
}

export interface SubtitleTrackUpdatePayload {
  label?: string;
  lang?: SubtitleLang;
  is_primary?: boolean;
  offset_ms?: number;
}

export interface CueRead {
  idx: number;
  start_ms: number;
  end_ms: number;
  text: str;
  tokens?: CueTokens | null;
  translation_text?: string | null;
}

type str = string;

export interface TrackCuesResponse {
  track_id: number;
  cues: CueRead[];
}

export interface VideoListItem {
  id: number;
  title: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  status: VideoStatus;
  error_message: string | null;
  thumbnail_url: string | null;
  subtitle_count: number;
  created_at: string;
}

export interface VideoRead {
  id: number;
  title: string;
  original_filename: string;
  original_path: string;
  playback_path: string | null;
  thumbnail_path: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container: string | null;
  size_bytes: number;
  status: VideoStatus;
  error_message: string | null;
  created_at: string;
  stream_url: string;
  thumbnail_url: string | null;
  subtitle_tracks: SubtitleTrackRead[];
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function parseErrorDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "detail" in body) {
      const detail = (body as { detail: unknown }).detail;
      if (typeof detail === "string") {
        return detail;
      }
      if (Array.isArray(detail) && detail.length > 0) {
        const first = detail[0] as { msg?: string };
        if (typeof first?.msg === "string") {
          return first.msg;
        }
      }
    }
  } catch {
    // Ignorar error de parseo JSON
  }
  return `Error HTTP ${response.status} (${response.statusText || "Solicitud fallida"})`;
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function fetchVideos(): Promise<VideoListItem[]> {
  return requestJson<VideoListItem[]>("/api/videos");
}

export async function fetchVideo(videoId: number): Promise<VideoRead> {
  return requestJson<VideoRead>(`/api/videos/${videoId}`);
}

export async function updateVideoTitle(
  videoId: number,
  title: string,
): Promise<VideoRead> {
  return requestJson<VideoRead>(`/api/videos/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteVideo(videoId: number): Promise<void> {
  return requestJson<void>(`/api/videos/${videoId}`, {
    method: "DELETE",
  });
}

export interface VideoFromUrlPayload {
  url: string;
  title?: string;
  auto_subtitles?: boolean;
  max_height?: number;
}

export async function createVideoFromUrl(
  payload: VideoFromUrlPayload,
): Promise<VideoRead> {
  return requestJson<VideoRead>("/api/videos/from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface UploadVideoOptions {
  file: File;
  title?: string;
  onProgress?: (percent: number, loadedBytes: number, totalBytes: number) => void;
}

export interface UploadVideoHandle {
  promise: Promise<VideoRead>;
  abort: () => void;
}

export function uploadVideoWithProgress(options: UploadVideoOptions): UploadVideoHandle {
  const xhr = new XMLHttpRequest();

  const promise = new Promise<VideoRead>((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", options.file);
    if (options.title && options.title.trim()) {
      formData.append("title", options.title.trim());
    }

    xhr.open("POST", "/api/videos", true);

    xhr.upload.onprogress = (event: ProgressEvent<EventTarget>) => {
      if (event.lengthComputable && options.onProgress) {
        const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
        options.onProgress(percent, event.loaded, event.total);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const parsed = JSON.parse(xhr.responseText) as VideoRead;
          resolve(parsed);
        } catch {
          reject(new ApiError(xhr.status, "Respuesta JSON inválida del servidor."));
        }
        return;
      }

      let detail = `Error HTTP ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { detail?: unknown };
        if (typeof parsed.detail === "string") {
          detail = parsed.detail;
        }
      } catch {
        // Ignorar
      }
      reject(new ApiError(xhr.status, detail));
    };

    xhr.onerror = () => {
      reject(new ApiError(0, "Error de red durante la subida del video."));
    };

    xhr.onabort = () => {
      reject(new ApiError(499, "Subida cancelada por el usuario."));
    };

    xhr.send(formData);
  });

  return {
    promise,
    abort: () => xhr.abort(),
  };
}

export async function fetchSubtitleTracks(videoId: number): Promise<SubtitleTrackRead[]> {
  return requestJson<SubtitleTrackRead[]>(`/api/videos/${videoId}/subtitles`);
}

export interface UploadSubtitleOptions {
  videoId: number;
  file: File;
  lang?: string;
  label?: string;
  isPrimary?: boolean;
}

export async function uploadSubtitleTrack(
  options: UploadSubtitleOptions,
): Promise<SubtitleUploadResponse> {
  const formData = new FormData();
  formData.append("file", options.file);
  if (options.lang && options.lang !== "auto") {
    formData.append("lang", options.lang);
  }
  if (options.label && options.label.trim()) {
    formData.append("label", options.label.trim());
  }
  if (options.isPrimary !== undefined) {
    formData.append("is_primary", String(options.isPrimary));
  }

  return requestJson<SubtitleUploadResponse>(`/api/videos/${options.videoId}/subtitles`, {
    method: "POST",
    body: formData,
  });
}

export async function fetchTrackCues(trackId: number): Promise<TrackCuesResponse> {
  return requestJson<TrackCuesResponse>(`/api/subtitles/${trackId}/cues`);
}

export async function updateSubtitleTrack(
  trackId: number,
  payload: SubtitleTrackUpdatePayload,
): Promise<SubtitleTrackRead> {
  return requestJson<SubtitleTrackRead>(`/api/subtitles/${trackId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function triggerSubtitleTokenize(
  trackId: number,
  force = true,
): Promise<SubtitleTrackRead> {
  return requestJson<SubtitleTrackRead>(
    `/api/subtitles/${trackId}/tokenize?force=${String(force)}`,
    {
      method: "POST",
    },
  );
}

export async function deleteSubtitleTrack(trackId: number): Promise<void> {
  return requestJson<void>(`/api/subtitles/${trackId}`, {
    method: "DELETE",
  });
}

// --- Fase 4: Diccionario CC-CEDICT ---

export interface DictionaryEntryRead {
  id: number;
  traditional: string;
  simplified: string;
  pinyin_numeric: string;
  pinyin_marks: string;
  definitions: string[];
  classifiers: string[];
}

export interface CharBreakdownItem {
  char: string;
  entries: DictionaryEntryRead[];
}

export interface DictionaryLookupResponse {
  query: string;
  normalized_simplified: string;
  dictionary_loaded: boolean;
  entries: DictionaryEntryRead[];
  char_entries: CharBreakdownItem[];
}

export interface DictionaryStatusResponse {
  loaded: boolean;
  entry_count: number;
  cedict_file_exists: boolean;
  cedict_path: string;
}

export async function fetchDictionaryStatus(): Promise<DictionaryStatusResponse> {
  return requestJson<DictionaryStatusResponse>("/api/dictionary/status");
}

export async function importDictionary(
  download = true,
): Promise<DictionaryStatusResponse> {
  return requestJson<DictionaryStatusResponse>(
    `/api/dictionary/import?download=${String(download)}`,
    {
      method: "POST",
    },
  );
}

export async function lookupDictionaryWord(
  word: string,
): Promise<DictionaryLookupResponse> {
  return requestJson<DictionaryLookupResponse>(
    `/api/dictionary/${encodeURIComponent(word)}`,
  );
}

// --- Fases 5 y 6: Traducción de frases, guardado de Phrase y corte de clips ---

export type ClipStatus = "pending" | "processing" | "ready" | "error";

export interface TranslateResponse {
  source_text: string;
  target_lang: string;
  translated_text: string;
  provider: string;
  cached: boolean;
}

export interface PhraseCreatePayload {
  video_id: number;
  track_id?: number | null;
  cue_idx?: number | null;
  hanzi?: string;
  focus_word?: string | null;
  pinyin?: string;
  translation?: string;
  notes?: string | null;
  start_ms?: number;
  end_ms?: number;
  pad_ms?: number;
  apply_track_offset?: boolean;
}

export interface PhraseUpdatePayload {
  hanzi?: string;
  focus_word?: string | null;
  pinyin?: string;
  translation?: string;
  notes?: string | null;
  start_ms?: number;
  end_ms?: number;
}

export interface PhraseRead {
  id: number;
  video_id: number;
  track_id: number | null;
  cue_idx: number | null;
  hanzi: string;
  focus_word: string | null;
  pinyin: string;
  translation: string;
  notes: string | null;
  start_ms: number;
  end_ms: number;
  clip_status: ClipStatus;
  clip_error: string | null;
  clip_video_url: string | null;
  clip_audio_url: string | null;
  clip_thumb_url: string | null;
  created_at: string;
}

export async function translateText(
  text: string,
  targetLang = "es",
): Promise<TranslateResponse> {
  return requestJson<TranslateResponse>("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, target_lang: targetLang }),
  });
}

export async function pairVideoSubtitles(
  videoId: number,
  secondaryTrackId?: number | null,
): Promise<{ video_id: number; matched_cues: number }> {
  const qs =
    secondaryTrackId !== undefined && secondaryTrackId !== null
      ? `?secondary_track_id=${secondaryTrackId}`
      : "";
  return requestJson<{ video_id: number; matched_cues: number }>(
    `/api/videos/${videoId}/subtitles/pair${qs}`,
    {
      method: "POST",
    },
  );
}

export async function fetchPhrases(params?: {
  videoId?: number | null;
  q?: string;
}): Promise<PhraseRead[]> {
  const search = new URLSearchParams();
  if (params?.videoId !== undefined && params.videoId !== null) {
    search.set("video_id", String(params.videoId));
  }
  if (params?.q && params.q.trim()) {
    search.set("q", params.q.trim());
  }
  const queryStr = search.toString();
  return requestJson<PhraseRead[]>(`/api/phrases${queryStr ? `?${queryStr}` : ""}`);
}

export async function createPhrase(payload: PhraseCreatePayload): Promise<PhraseRead> {
  return requestJson<PhraseRead>("/api/phrases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function updatePhrase(
  phraseId: number,
  payload: PhraseUpdatePayload,
): Promise<PhraseRead> {
  return requestJson<PhraseRead>(`/api/phrases/${phraseId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deletePhrase(phraseId: number): Promise<void> {
  return requestJson<void>(`/api/phrases/${phraseId}`, {
    method: "DELETE",
  });
}

// --- Fase 7: Exportación a Anki (.apkg y AnkiConnect) ---

export type AnkiCardType = "listening" | "reading" | "production";

export interface AnkiExportPayload {
  video_id?: number | null;
  phrase_ids?: number[] | null;
  deck_name?: string;
  include_video?: boolean;
  card_types?: AnkiCardType[];
  anki_connect_url?: string;
}

export interface AnkiConnectExportResponse {
  deck_name: string;
  added: number;
  skipped: number;
}

export async function downloadAnkiApkg(payload: AnkiExportPayload): Promise<void> {
  const response = await fetch("/api/export/anki", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await parseErrorDetail(response);
    throw new ApiError(response.status, detail);
  }
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (payload.deck_name || "mandarin_clips")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  a.download = `${safeName || "mandarin_clips"}.apkg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export async function exportToAnkiConnect(
  payload: AnkiExportPayload,
): Promise<AnkiConnectExportResponse> {
  return requestJson<AnkiConnectExportResponse>("/api/export/ankiconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}
