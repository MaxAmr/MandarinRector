import { X } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUploadVideo } from "../hooks/useUploadVideo";
import { VIDEOS_QUERY_KEY } from "../hooks/useVideos";
import { ApiError, createVideoFromUrl } from "../lib/api";
import { formatBytes } from "../lib/format";

const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"];
const MAX_VIDEO_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB

export interface UploadDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export const UploadDialog: React.FC<UploadDialogProps> = ({ isOpen, onClose }) => {
  const queryClient = useQueryClient();
  const {
    isUploading,
    percent,
    loadedBytes,
    totalBytes,
    error: uploadError,
    upload,
    cancel,
    reset,
  } = useUploadVideo();

  const [mode, setMode] = useState<"file" | "url">("file");

  // Estado modo archivo local
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Estado modo URL (yt-dlp)
  const [videoUrl, setVideoUrl] = useState("");
  const [urlTitle, setUrlTitle] = useState("");
  const [autoSubtitles, setAutoSubtitles] = useState(true);
  const [maxHeight, setMaxHeight] = useState(1080);
  const [isSubmittingUrl, setIsSubmittingUrl] = useState(false);

  const validateAndPickFile = useCallback(
    (file: File) => {
      setClientError(null);
      reset();

      const dotIdx = file.name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : "";
      if (!ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
        setClientError(
          `Extensión no soportada (${ext || "sin extensión"}). Permitidas: ${ALLOWED_VIDEO_EXTENSIONS.join(", ")}`,
        );
        setSelectedFile(null);
        return;
      }

      if (file.size === 0) {
        setClientError("El archivo seleccionado está vacío.");
        setSelectedFile(null);
        return;
      }

      if (file.size > MAX_VIDEO_UPLOAD_BYTES) {
        setClientError(
          `El archivo supera el límite máximo permitido de ${formatBytes(MAX_VIDEO_UPLOAD_BYTES)}.`,
        );
        setSelectedFile(null);
        return;
      }

      setSelectedFile(file);
      const stem = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
      setTitle((prev) => (prev.trim() ? prev : stem));
    },
    [reset],
  );

  const handleClose = useCallback(() => {
    if (isUploading) {
      cancel();
    }
    setSelectedFile(null);
    setTitle("");
    setVideoUrl("");
    setUrlTitle("");
    setClientError(null);
    setIsSubmittingUrl(false);
    reset();
    onClose();
  }, [isUploading, cancel, reset, onClose]);

  if (!isOpen) {
    return null;
  }

  const handleFileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile) {
      setClientError("Seleccioná un archivo de video para subir.");
      return;
    }
    const created = await upload(selectedFile, title.trim() || undefined);
    if (created) {
      handleClose();
    }
  };

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setClientError(null);
    const trimmedUrl = videoUrl.trim();
    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
      setClientError("Ingresá una URL válida que comience con http:// o https://");
      return;
    }

    setIsSubmittingUrl(true);
    try {
      await createVideoFromUrl({
        url: trimmedUrl,
        title: urlTitle.trim() || undefined,
        auto_subtitles: autoSubtitles,
        max_height: maxHeight,
      });
      await queryClient.invalidateQueries({ queryKey: VIDEOS_QUERY_KEY });
      handleClose();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.detail
          : err instanceof Error
            ? err.message
            : "No se pudo iniciar la descarga desde la URL.";
      setClientError(msg);
    } finally {
      setIsSubmittingUrl(false);
    }
  };

  const displayError = clientError ?? uploadError;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="video-upload-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 id="video-upload-dialog-title" className="text-base font-semibold text-ink">
            Añadir video a la biblioteca
          </h2>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Cerrar diálogo de subida"
            className="rounded-lg p-1 text-ink2 hover:bg-surface2 hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        {/* Selector de pestaña: Archivo local vs Link (yt-dlp) */}
        <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-lg bg-app p-1">
          <button
            type="button"
            onClick={() => {
              setMode("file");
              setClientError(null);
            }}
            aria-pressed={mode === "file"}
            className={`rounded-lg py-2 text-xs font-semibold transition ${
              mode === "file" ? "bg-accent text-app" : "text-ink hover:text-white"
            }`}
          >
            📁 Archivo local
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("url");
              setClientError(null);
            }}
            aria-pressed={mode === "url"}
            className={`rounded-lg py-2 text-xs font-semibold transition ${
              mode === "url" ? "bg-accent text-app" : "text-ink hover:text-white"
            }`}
          >
            Enlace de YouTube o Bilibili
          </button>
        </div>

        {mode === "file" ? (
          <form onSubmit={handleFileSubmit} className="mt-4 space-y-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!isUploading) setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (isUploading) return;
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) {
                  validateAndPickFile(dropped);
                }
              }}
              className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition ${
                isDragging
                  ? "border-accent bg-accent/10"
                  : "border-lineStrong bg-app/60 hover:border-lineStrong"
              }`}
            >
              <input
                id="video-file-input"
                type="file"
                disabled={isUploading}
                accept=".mp4,.mkv,.webm,.mov,.avi,.m4v,video/*"
                onChange={(e) => {
                  const picked = e.target.files?.[0];
                  if (picked) {
                    validateAndPickFile(picked);
                  }
                }}
                className="sr-only"
              />
              <label
                htmlFor="video-file-input"
                className={`text-xs text-ink ${
                  isUploading ? "cursor-not-allowed" : "cursor-pointer"
                }`}
              >
                {selectedFile ? (
                  <div>
                    <p className="font-semibold text-accent">{selectedFile.name}</p>
                    <p className="mt-1 text-[11px] text-ink2">
                      {formatBytes(selectedFile.size)}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="font-medium text-ink">
                      Arrastrá tu archivo de video o{" "}
                      <span className="text-accent underline">
                        hacé click para elegir
                      </span>
                    </p>
                    <p className="mt-1 text-[11px] text-ink2">
                      Formatos permitidos: .mp4, .mkv, .webm, .mov, .avi, .m4v (máx. 8
                      GiB)
                    </p>
                  </div>
                )}
              </label>
            </div>

            <div>
              <label
                htmlFor="video-title-input"
                className="block text-xs font-medium text-ink"
              >
                Título (opcional)
              </label>
              <input
                id="video-title-input"
                type="text"
                disabled={isUploading}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Por defecto: nombre del archivo sin extensión"
                className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            {isUploading && (
              <div className="space-y-1.5 rounded-lg border border-line bg-app p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-accent">
                    Subiendo video... {percent}%
                  </span>
                  <span className="font-mono text-[11px] text-ink2">
                    {formatBytes(loadedBytes)} / {formatBytes(totalBytes)}
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface2">
                  <div
                    className="h-full bg-accent transition-all duration-150"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </div>
            )}

            {displayError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-300"
              >
                {displayError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              {isUploading ? (
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500"
                >
                  Cancelar subida
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-lg bg-surface2 px-4 py-2 text-xs font-medium text-ink hover:bg-line"
                  >
                    Cerrar
                  </button>
                  <button
                    type="submit"
                    disabled={!selectedFile}
                    className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app hover:bg-accent/90 disabled:opacity-50"
                  >
                    Subir video
                  </button>
                </>
              )}
            </div>
          </form>
        ) : (
          <form onSubmit={handleUrlSubmit} className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="video-url-input"
                className="block text-xs font-medium text-ink"
              >
                URL del video (YouTube, Bilibili, etc.)
              </label>
              <input
                id="video-url-input"
                type="url"
                required
                disabled={isSubmittingUrl}
                value={videoUrl}
                onChange={(e) => setVideoUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none disabled:opacity-50"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="url-title-input"
                  className="block text-xs font-medium text-ink"
                >
                  Título personalizado (opcional)
                </label>
                <input
                  id="url-title-input"
                  type="text"
                  disabled={isSubmittingUrl}
                  value={urlTitle}
                  onChange={(e) => setUrlTitle(e.target.value)}
                  placeholder="Por defecto se extrae automáticamente de la plataforma"
                  className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink placeholder-ink2 focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="url-max-height"
                  className="block text-xs font-medium text-ink"
                >
                  Calidad máx.
                </label>
                <select
                  id="url-max-height"
                  value={maxHeight}
                  onChange={(e) => setMaxHeight(Number.parseInt(e.target.value, 10))}
                  className="mt-1 w-full rounded-lg border border-lineStrong bg-app px-3 py-2 text-xs text-ink focus:border-accent focus:outline-none"
                >
                  <option value={1080}>1080p Full HD</option>
                  <option value={720}>720p HD</option>
                  <option value={480}>480p SD</option>
                </select>
              </div>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={autoSubtitles}
                onChange={(e) => setAutoSubtitles(e.target.checked)}
                className="h-4 w-4 rounded border-lineStrong bg-app text-accent focus:ring-accent"
              />
              <span>
                Descargar subtítulos disponibles automáticamente (Chino + Español/Inglés)
                y tokenizar con jieba/pypinyin
              </span>
            </label>

            {displayError && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-2 text-xs text-rose-300"
              >
                {displayError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSubmittingUrl}
                className="rounded-lg bg-surface2 px-4 py-2 text-xs font-medium text-ink hover:bg-line"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!videoUrl.trim() || isSubmittingUrl}
                className="rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app hover:bg-accent/90 disabled:opacity-50"
              >
                {isSubmittingUrl ? "Iniciando descarga..." : "Descargar e importar"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
