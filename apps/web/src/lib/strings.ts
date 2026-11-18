/** Textos de UI centralizados (español). */
export const S = {
  library: "Biblioteca",
  back: "Volver a la biblioteca",
  saveSentence: "Guardar frase",
  backToCurrent: "Línea actual",
  searchCues: "Buscar en subtítulos",
  cueCount: (shown: number, total: number) =>
    shown === total ? `${total} líneas` : `${shown} de ${total} líneas`,
  videoNotFound: "Video no encontrado o no disponible",
  toneScope: {
    label: "Color por tono",
    off: "Nunca",
    active: "Solo línea activa",
    all: "Todas las líneas",
  },
} as const;
