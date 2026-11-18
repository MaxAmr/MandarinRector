import { X } from "lucide-react";
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { VideoListItem } from "../lib/api";
import { formatDuration } from "../lib/format";

export interface VideoCardProps {
  video: VideoListItem;
  onRename: (videoId: number, newTitle: string) => Promise<void>;
  onDelete: (videoId: number) => Promise<void>;
}

export const VideoCard: React.FC<VideoCardProps> = ({ video, onRename, onDelete }) => {
  const navigate = useNavigate();
  const [isRenaming, setIsRenaming] = useState(false);
  const [titleInput, setTitleInput] = useState(video.title);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const isReady = video.status === "ready";
  const isProcessing = video.status === "processing";
  const isError = video.status === "error";

  const handleNavigate = () => {
    if (isReady && !isRenaming && !confirmingDelete) {
      navigate(`/watch/${video.id}`);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = titleInput.trim();
    if (!trimmed || trimmed === video.title) {
      setIsRenaming(false);
      setTitleInput(video.title);
      return;
    }
    setIsBusy(true);
    try {
      await onRename(video.id, trimmed);
      setIsRenaming(false);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    setIsBusy(true);
    try {
      await onDelete(video.id);
    } finally {
      setIsBusy(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <article
      className={`group flex flex-col overflow-hidden rounded-lg border border-line bg-surface/80 shadow-lg transition ${
        isReady ? "hover:border-accent/60" : "opacity-85"
      }`}
    >
      {/* Thumbnail clickable si status === ready */}
      <div
        role={isReady ? "button" : undefined}
        tabIndex={isReady ? 0 : -1}
        aria-disabled={!isReady}
        onClick={handleNavigate}
        onKeyDown={(e) => {
          if (isReady && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            handleNavigate();
          }
        }}
        className={`relative aspect-video w-full overflow-hidden bg-app ${
          isReady ? "cursor-pointer" : "cursor-not-allowed"
        }`}
      >
        {video.thumbnail_url ? (
          <img
            src={video.thumbnail_url}
            alt={video.title}
            loading="lazy"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-ink2">
            {isProcessing ? "Generando vista previa..." : "Sin miniatura"}
          </div>
        )}

        {/* Badge de estado arriba a la izquierda */}
        <div className="absolute left-2.5 top-2.5 flex items-center gap-1.5">
          {isProcessing && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/95 px-2.5 py-1 text-[11px] font-semibold text-app shadow">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-line border-t-transparent" />
              Procesando
            </span>
          )}
          {isReady && (
            <span className="rounded-full bg-emerald-500/90 px-2.5 py-0.5 text-[11px] font-semibold text-app shadow">
              Listo
            </span>
          )}
          {isError && (
            <span
              title={video.error_message ?? "Error durante el procesamiento multimedia"}
              className="cursor-help rounded-full bg-rose-600/95 px-2.5 py-0.5 text-[11px] font-semibold text-white shadow"
            >
              Error
            </span>
          )}
        </div>

        {/* Duración y resolución abajo a la derecha */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5">
          {video.width && video.height && (
            <span className="rounded bg-app/85 px-1.5 py-0.5 font-mono text-[10px] text-ink">
              {video.width}×{video.height}
            </span>
          )}
          <span className="rounded bg-app/85 px-1.5 py-0.5 font-mono text-xs font-medium text-white">
            {formatDuration(video.duration)}
          </span>
        </div>
      </div>

      {/* Cuerpo de la tarjeta */}
      <div className="flex flex-1 flex-col justify-between p-3.5">
        <div>
          {isRenaming ? (
            <form onSubmit={handleRenameSubmit} className="flex items-center gap-1.5">
              <input
                type="text"
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                aria-label="Nuevo título del video"
                autoFocus
                className="min-w-0 flex-1 rounded-lg border border-accent bg-app px-2.5 py-1 text-xs text-ink focus:outline-none"
              />
              <button
                type="submit"
                disabled={isBusy}
                className="rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-app hover:bg-accent/90"
              >
                OK
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsRenaming(false);
                  setTitleInput(video.title);
                }}
                className="rounded-lg bg-surface2 px-2 py-1 text-xs text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </form>
          ) : (
            <h3
              onClick={handleNavigate}
              className={`line-clamp-2 text-sm font-semibold text-ink ${
                isReady ? "cursor-pointer hover:text-accent" : ""
              }`}
            >
              {video.title}
            </h3>
          )}

          {isError && video.error_message && (
            <p
              title={video.error_message}
              className="mt-1 line-clamp-2 text-[11px] text-rose-400"
            >
              {video.error_message}
            </p>
          )}
        </div>

        {/* Pie de tarjeta con contador de subtítulos y acciones */}
        <div className="mt-3 flex items-center justify-between border-t border-line/80 pt-2.5 text-xs">
          <span className="text-[11px] text-ink2">
            {video.subtitle_count > 0
              ? `${video.subtitle_count} pista(s) CC`
              : "Sin subtítulos"}
          </span>

          <div className="flex items-center gap-1.5">
            {!isRenaming && !confirmingDelete && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setTitleInput(video.title);
                    setIsRenaming(true);
                  }}
                  aria-label={`Renombrar ${video.title}`}
                  className="rounded-md bg-surface2 px-2 py-1 text-[11px] text-ink transition hover:bg-line hover:text-white"
                >
                  Renombrar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  aria-label={`Eliminar ${video.title}`}
                  className="rounded-md bg-rose-950/60 px-2 py-1 text-[11px] text-rose-300 transition hover:bg-rose-900/60"
                >
                  Eliminar
                </button>
              </>
            )}

            {confirmingDelete && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={handleDeleteConfirm}
                  className="rounded-md bg-rose-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
                >
                  Confirmar
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setConfirmingDelete(false)}
                  className="rounded-md bg-surface2 px-2 py-1 text-[11px] text-ink"
                >
                  Cancelar
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
