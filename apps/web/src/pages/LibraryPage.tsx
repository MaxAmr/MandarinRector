import { Film } from "lucide-react";
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { UploadDialog } from "../components/UploadDialog";
import { VideoCard } from "../components/VideoCard";
import { useDeleteVideo, useRenameVideo, useVideos } from "../hooks/useVideos";

export const LibraryPage: React.FC = () => {
  const { data: videos, isLoading, isError, error, refetch } = useVideos();
  const renameMutation = useRenameVideo();
  const deleteMutation = useDeleteVideo();

  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const handleRename = async (videoId: number, newTitle: string) => {
    await renameMutation.mutateAsync({ videoId, title: newTitle });
  };

  const handleDelete = async (videoId: number) => {
    await deleteMutation.mutateAsync(videoId);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Cabecera */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-lg font-bold text-app shadow">
              漢
            </span>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              Mandarin Reactor
            </h1>
          </div>
          <p className="mt-1 text-xs text-ink2">
            Biblioteca de estudio inmersivo de video local y subtítulos sincronizados
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            to="/phrases"
            className="inline-flex items-center gap-1.5 rounded-lg border border-lineStrong bg-surface px-4 py-2.5 text-sm font-semibold text-accent transition hover:border-accent/50 hover:bg-surface2"
          >
            Frases y Anki
          </Link>

          <button
            type="button"
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-app transition hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <span>+ Subir video</span>
          </button>
        </div>
      </header>

      {/* Estados: Cargando / Error / Vacío / Grilla */}
      {isLoading && (
        <div
          aria-label="Cargando biblioteca"
          className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={idx}
              className="aspect-[4/3] animate-pulse rounded-lg border border-line bg-surface/60"
            />
          ))}
        </div>
      )}

      {isError && (
        <div
          role="alert"
          className="rounded-lg border border-rose-500/40 bg-rose-950/30 p-6 text-center"
        >
          <p className="text-sm font-semibold text-rose-300">
            No se pudo cargar la biblioteca de videos
          </p>
          <p className="mt-1 text-xs text-ink2">
            {error instanceof Error ? error.message : "Error de conexión con la API"}
          </p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-4 rounded-lg bg-surface2 px-4 py-2 text-xs font-medium text-ink hover:bg-line"
          >
            Reintentar
          </button>
        </div>
      )}

      {!isLoading && !isError && videos && videos.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line bg-surface/30 px-6 py-16 text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-lg bg-accent/15 text-2xl text-accent">
            <Film size={24} aria-hidden="true" />
          </div>
          <h2 className="text-base font-semibold text-ink">Tu biblioteca está vacía</h2>
          <p className="mt-1 max-w-md text-xs text-ink2">
            Subí un video en formato MP4, MKV, WebM, MOV, AVI o M4V para comenzar a
            practicar comprensión auditiva y lectura en mandarín.
          </p>
          <button
            type="button"
            onClick={() => setIsUploadOpen(true)}
            className="mt-5 rounded-lg bg-accent px-5 py-2.5 text-xs font-semibold text-app transition hover:bg-accent/90"
          >
            + Subir primer video
          </button>
        </div>
      )}

      {!isLoading && !isError && videos && videos.length > 0 && (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {videos.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <UploadDialog isOpen={isUploadOpen} onClose={() => setIsUploadOpen(false)} />
    </div>
  );
};
