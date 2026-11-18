import { X } from "lucide-react";
import React from "react";

export interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUT_ITEMS: Array<{ key: string; description: string }> = [
  { key: "Espacio", description: "Reproducir / Pausar el video" },
  { key: "← / →", description: "Retroceder / Avanzar 5 segundos" },
  { key: "[ / ]", description: "Disminuir / Aumentar velocidad (preserva tono)" },
  { key: "M", description: "Silenciar / Activar sonido (Mute)" },
  { key: "F", description: "Alternar pantalla completa (conserva subtítulos)" },
  {
    key: "A",
    description:
      "Cue anterior (si estás a ≥400 ms del inicio del cue actual, lo reinicia)",
  },
  { key: "D", description: "Saltar al cue siguiente" },
  { key: "R", description: "Repetir el cue actual desde su inicio" },
  { key: "L", description: "Activar / Desactivar loop continuo del cue actual" },
  {
    key: "P",
    description: "Pausar automáticamente al finalizar cada cue (shadowing)",
  },
  { key: "C", description: "Mostrar / Ocultar overlay de subtítulos sobre el video" },
  { key: "T", description: "Mostrar / Ocultar pista secundaria (traducción)" },
  { key: "Y", description: "Mostrar / Ocultar pinyin (<ruby>) en el overlay" },
  { key: "K", description: "Activar / Desactivar coloreado por tono (tonos 1–5)" },
  { key: "S", description: "Guardar frase actual y cortar clip MP4/MP3 con ffmpeg" },
  { key: "G / H", description: "Ajustar offset de sincronía −100 ms / +100 ms" },
  { key: "?", description: "Abrir / Cerrar esta guía de atajos" },
];

export const ShortcutsModal: React.FC<ShortcutsModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-app/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-line bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line pb-3">
          <h2 id="shortcuts-modal-title" className="text-base font-semibold text-ink">
            Atajos de teclado de estudio
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar modal de atajos"
            className="rounded-lg p-1 text-ink2 hover:bg-surface2 hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>

        <div className="mt-4 divide-y divide-line/70 text-xs">
          {SHORTCUT_ITEMS.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4 py-2">
              <span className="text-ink">{item.description}</span>
              <kbd className="shrink-0 rounded-md border border-lineStrong bg-app px-2 py-1 font-mono text-[11px] font-semibold text-accent">
                {item.key}
              </kbd>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[11px] text-ink2">
          Los atajos se desactivan automáticamente mientras el foco está en un campo de
          texto o selector.
        </p>
      </div>
    </div>
  );
};
