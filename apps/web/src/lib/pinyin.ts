const TONE_DIACRITICS_RE = /[\u0304\u0301\u030c\u0300]/g;

/**
 * Convierte una sílaba en pinyin con marca diacrítica a formato numérico (TONE3),
 * preservando la diéresis (`ü`, U+0308).
 *
 * Ejemplos:
 * - `toNumeric("nǐ", 3)` -> `"ni3"`
 * - `toNumeric("lǜ", 4)` -> `"lü4"`
 * - `toNumeric("nǚ", 3)` -> `"nü3"`
 * - `toNumeric("ma", 5)` -> `"ma5"`
 */
export function toNumeric(syllable: string, tone: number | null | undefined): string {
  const normalizedBase = syllable
    .normalize("NFD")
    .replace(TONE_DIACRITICS_RE, "")
    .normalize("NFC");

  const validTone = typeof tone === "number" && tone >= 1 && tone <= 5 ? tone : 5;
  return `${normalizedBase}${validTone}`;
}

export function formatPinyinSyllable(
  syllable: string,
  tone: number | null | undefined,
  style: "marks" | "numbers",
): string {
  if (style === "numbers") {
    return toNumeric(syllable, tone);
  }
  return syllable;
}
