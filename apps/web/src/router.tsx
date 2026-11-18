import React from "react";
import { createBrowserRouter, Link } from "react-router-dom";
import { LibraryPage } from "./pages/LibraryPage";
import { PhrasesPage } from "./pages/PhrasesPage";
import { WatchPage } from "./pages/WatchPage";

// eslint-disable-next-line react-refresh/only-export-components
const NotFoundPage: React.FC = () => (
  <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
    <span className="font-mono text-4xl font-bold text-accent">404</span>
    <h1 className="mt-2 text-lg font-semibold text-ink">Página no encontrada</h1>
    <p className="mt-1 text-xs text-ink2">
      La ruta solicitada no existe dentro de Mandarin Reactor.
    </p>
    <Link
      to="/"
      className="mt-5 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-app transition hover:bg-accent/90"
    >
      Volver a la biblioteca
    </Link>
  </div>
);

export const router = createBrowserRouter([
  {
    path: "/",
    element: <LibraryPage />,
  },
  {
    path: "/watch/:id",
    element: <WatchPage />,
  },
  {
    path: "/phrases",
    element: <PhrasesPage />,
  },
  {
    path: "*",
    element: <NotFoundPage />,
  },
]);
