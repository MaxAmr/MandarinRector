import type { CueRead } from "./api";

export interface TimedCue {
  idx?: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

const lastIndexCache = new WeakMap<readonly TimedCue[], number>();

function isLastStartLessOrEqual(
  cues: readonly TimedCue[],
  index: number,
  timeMs: number,
): boolean {
  const n = cues.length;
  if (index < 0 || index >= n) {
    return false;
  }
  if (cues[index].start_ms > timeMs) {
    return false;
  }
  return index === n - 1 || cues[index + 1].start_ms > timeMs;
}

/**
 * Búsqueda binaria con caché monótona del último cue con `start_ms <= timeMs` (cue "sticky").
 * Retorna `-1` si la lista está vacía o `timeMs < cues[0].start_ms`.
 */
export function findCueIndexAt<T extends TimedCue>(
  cues: readonly T[],
  timeMs: number,
): number {
  const n = cues.length;
  if (n === 0 || timeMs < cues[0].start_ms) {
    return -1;
  }

  const cached = lastIndexCache.get(cues);
  if (cached !== undefined) {
    if (isLastStartLessOrEqual(cues, cached, timeMs)) {
      return cached;
    }
    if (isLastStartLessOrEqual(cues, cached + 1, timeMs)) {
      lastIndexCache.set(cues, cached + 1);
      return cached + 1;
    }
  }

  let low = 0;
  let high = n - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (cues[mid].start_ms <= timeMs) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (result >= 0) {
    lastIndexCache.set(cues, result);
  }
  return result;
}

/**
 * Parte de `findCueIndexAt` y retrocede hasta `lookback` posiciones devolviendo
 * los índices (en orden ascendente) de los cues realmente activos (`start_ms <= timeMs < end_ms`).
 */
export function findActiveCueIndices<T extends TimedCue>(
  cues: readonly T[],
  timeMs: number,
  lookback = 5,
): number[] {
  const stickyIdx = findCueIndexAt(cues, timeMs);
  if (stickyIdx === -1) {
    return [];
  }

  const minIdx = Math.max(0, stickyIdx - Math.max(0, lookback));
  const active: number[] = [];

  for (let i = minIdx; i <= stickyIdx; i += 1) {
    const cue = cues[i];
    if (cue.start_ms <= timeMs && cue.end_ms > timeMs) {
      active.push(i);
    }
  }

  return active;
}

/**
 * Devuelve el índice del cue secundario con MAYOR solapamiento temporal contra `[primaryCue.start_ms, primaryCue.end_ms]`.
 * En caso de empate de solapamiento, gana el de menor distancia entre inicios `|sec.start_ms - primaryCue.start_ms|`.
 * Si no hay solapamiento (`overlap <= 0`), devuelve `null`.
 *
 * Punto de extensión (Fase 5): Esta firma se mantiene aislada para ser reemplazada
 * por el emparejado persistido en servidor en fases futuras.
 */
export function findBestOverlapIndex<
  P extends Pick<TimedCue, "start_ms" | "end_ms">,
  S extends TimedCue,
>(primaryCue: P, secondaryCues: readonly S[]): number | null {
  const n = secondaryCues.length;
  if (n === 0 || primaryCue.end_ms <= primaryCue.start_ms) {
    return null;
  }

  // Ningún cue con start_ms >= primaryCue.end_ms puede tener solapamiento > 0
  const maxCandidateIdx = findCueIndexAt(secondaryCues, primaryCue.end_ms - 1);
  if (maxCandidateIdx === -1) {
    return null;
  }

  // Buscamos el primer candidato cuyo start_ms sea >= primaryCue.start_ms, y retrocedemos un margen
  // para cubrir cues secundarios que hayan comenzado antes de primaryCue.start_ms pero sigan activos.
  let low = 0;
  let high = maxCandidateIdx;
  let firstAfterStart = maxCandidateIdx;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (secondaryCues[mid].start_ms >= primaryCue.start_ms) {
      firstAfterStart = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  const scanStart = Math.max(0, firstAfterStart - 16);

  let bestIdx: number | null = null;
  let bestOverlap = 0;
  let bestStartDistance = Number.POSITIVE_INFINITY;

  for (let i = scanStart; i <= maxCandidateIdx; i += 1) {
    const sec = secondaryCues[i];
    const overlapStart = Math.max(primaryCue.start_ms, sec.start_ms);
    const overlapEnd = Math.min(primaryCue.end_ms, sec.end_ms);
    const overlap = overlapEnd - overlapStart;

    if (overlap <= 0) {
      continue;
    }

    const startDistance = Math.abs(sec.start_ms - primaryCue.start_ms);
    if (
      overlap > bestOverlap ||
      (overlap === bestOverlap && startDistance < bestStartDistance)
    ) {
      bestOverlap = overlap;
      bestStartDistance = startDistance;
      bestIdx = i;
    }
  }

  return bestIdx;
}

/**
 * Desplaza un cue aplicando `offsetMs` a `start_ms` y `end_ms`.
 */
export function applyOffset<T extends TimedCue>(cue: T, offsetMs: number): T {
  if (offsetMs === 0) {
    return cue;
  }
  return {
    ...cue,
    start_ms: cue.start_ms + offsetMs,
    end_ms: cue.end_ms + offsetMs,
  };
}

export function applyOffsetToCues(cues: readonly CueRead[], offsetMs: number): CueRead[] {
  if (offsetMs === 0) {
    return cues as CueRead[];
  }
  return cues.map((cue) => applyOffset(cue, offsetMs));
}
