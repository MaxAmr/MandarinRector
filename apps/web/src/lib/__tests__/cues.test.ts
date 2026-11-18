import { describe, expect, it } from "vitest";
import {
  applyOffset,
  findActiveCueIndices,
  findBestOverlapIndex,
  findCueIndexAt,
  type TimedCue,
} from "../cues";

const SAMPLE_CUES: TimedCue[] = [
  { idx: 0, start_ms: 1000, end_ms: 2500, text: "第一句" },
  { idx: 1, start_ms: 3000, end_ms: 4500, text: "第二句" },
  { idx: 2, start_ms: 5000, end_ms: 6500, text: "第三句" },
];

describe("findCueIndexAt y findActiveCueIndices", () => {
  it("maneja listas vacías correctamente", () => {
    expect(findCueIndexAt([], 1500)).toBe(-1);
    expect(findActiveCueIndices([], 1500)).toEqual([]);
  });

  it("retorna -1 antes del primer cue", () => {
    expect(findCueIndexAt(SAMPLE_CUES, 0)).toBe(-1);
    expect(findCueIndexAt(SAMPLE_CUES, 999)).toBe(-1);
    expect(findActiveCueIndices(SAMPLE_CUES, 999)).toEqual([]);
  });

  it("encuentra el cue activo cuando el tiempo cae dentro del intervalo", () => {
    expect(findCueIndexAt(SAMPLE_CUES, 1000)).toBe(0);
    expect(findCueIndexAt(SAMPLE_CUES, 1800)).toBe(0);
    expect(findActiveCueIndices(SAMPLE_CUES, 1800)).toEqual([0]);

    // Avance monótono (verifica también el caché de índice vecino)
    expect(findCueIndexAt(SAMPLE_CUES, 3200)).toBe(1);
    expect(findActiveCueIndices(SAMPLE_CUES, 3200)).toEqual([1]);
  });

  it("mantiene el índice sticky entre cues pero findActiveCueIndices devuelve vacío", () => {
    // Entre 2500 y 3000 no hay cue activo, pero el sticky es el 0
    expect(findCueIndexAt(SAMPLE_CUES, 2500)).toBe(0);
    expect(findCueIndexAt(SAMPLE_CUES, 2800)).toBe(0);
    expect(findActiveCueIndices(SAMPLE_CUES, 2500)).toEqual([]);
    expect(findActiveCueIndices(SAMPLE_CUES, 2800)).toEqual([]);
  });

  it("mantiene el último índice después del último cue", () => {
    expect(findCueIndexAt(SAMPLE_CUES, 9000)).toBe(2);
    expect(findActiveCueIndices(SAMPLE_CUES, 9000)).toEqual([]);
  });

  it("soporta cues solapados y cues con idéntico start_ms", () => {
    const overlapping: TimedCue[] = [
      { idx: 0, start_ms: 1000, end_ms: 4000, text: "Base larga" },
      { idx: 1, start_ms: 2000, end_ms: 3500, text: "Solapado A" },
      { idx: 2, start_ms: 2000, end_ms: 3000, text: "Mismo start_ms B" },
    ];

    expect(findCueIndexAt(overlapping, 2000)).toBe(2);
    expect(findActiveCueIndices(overlapping, 2500)).toEqual([0, 1, 2]);
    expect(findActiveCueIndices(overlapping, 3200)).toEqual([0, 1]);
    expect(findActiveCueIndices(overlapping, 3700)).toEqual([0]);
  });
});

describe("findBestOverlapIndex", () => {
  it("retorna null si la secundaria está vacía o no hay solapamiento", () => {
    const primary = { start_ms: 2000, end_ms: 3500, text: "你好" };
    expect(findBestOverlapIndex(primary, [])).toBeNull();

    const nonOverlapping: TimedCue[] = [
      { start_ms: 500, end_ms: 2000, text: "Antes" },
      { start_ms: 3500, end_ms: 5000, text: "Después" },
    ];
    expect(findBestOverlapIndex(primary, nonOverlapping)).toBeNull();
  });

  it("elige el cue secundario con mayor solapamiento temporal", () => {
    const primary = { start_ms: 2000, end_ms: 5000, text: "中文句子" };
    const secondary: TimedCue[] = [
      { start_ms: 1500, end_ms: 2800, text: "Corto (800 ms)" },
      { start_ms: 2200, end_ms: 4800, text: "Largo (2600 ms)" },
      { start_ms: 4500, end_ms: 6000, text: "Cola (500 ms)" },
    ];
    expect(findBestOverlapIndex(primary, secondary)).toBe(1);
  });

  it("desempata igual solapamiento por menor distancia entre start_ms", () => {
    const primary = { start_ms: 2000, end_ms: 4000, text: "测试" };
    const secondary: TimedCue[] = [
      // Solapamiento: [2000, 3000] = 1000 ms; |1000 - 2000| = 1000 ms
      { start_ms: 1000, end_ms: 3000, text: "Candidato lejano" },
      // Solapamiento: [2200, 3200] = 1000 ms; |2200 - 2000| = 200 ms
      { start_ms: 2200, end_ms: 3200, text: "Candidato cercano al inicio" },
    ];
    expect(findBestOverlapIndex(primary, secondary)).toBe(1);
  });
});

describe("applyOffset", () => {
  it("desplaza start_ms y end_ms preservando el resto de propiedades", () => {
    const original: TimedCue = { idx: 3, start_ms: 1500, end_ms: 3000, text: "你好" };
    expect(applyOffset(original, -200)).toEqual({
      idx: 3,
      start_ms: 1300,
      end_ms: 2800,
      text: "你好",
    });
    expect(applyOffset(original, 0)).toBe(original);
  });
});
