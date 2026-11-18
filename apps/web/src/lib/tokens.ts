export type ToneNumber = 1 | 2 | 3 | 4 | 5;

export interface WordToken {
  k: "w";
  w: string;
  p: Array<string | null>;
  n: Array<ToneNumber | null>;
}

export interface NonWordToken {
  k: "p" | "l" | "s" | "b";
  w: string;
}

export type Token = WordToken | NonWordToken;

export interface CueTokens {
  v: 1;
  t: Token[];
}

/**
 * Evalúa si un code point Unicode pertenece a los rangos Han definidos en el contrato:
 * U+4E00–U+9FFF, U+3400–U+4DBF, U+20000–U+2A6DF, U+F900–U+FAFF y U+3007 (〇).
 */
export function isHanChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    codePoint === 0x3007
  );
}

function isValidTone(value: unknown): value is ToneNumber | null {
  if (value === null) {
    return true;
  }
  return (
    typeof value === "number" &&
    (value === 1 || value === 2 || value === 3 || value === 4 || value === 5)
  );
}

function isValidToken(item: unknown): item is Token {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  const k = obj.k;
  const w = obj.w;

  if (typeof w !== "string") {
    return false;
  }

  if (k === "w") {
    const p = obj.p;
    const n = obj.n;
    if (!Array.isArray(p) || !Array.isArray(n)) {
      return false;
    }
    const codePoints = Array.from(w);
    if (
      codePoints.length === 0 ||
      p.length !== codePoints.length ||
      n.length !== codePoints.length
    ) {
      return false;
    }
    for (let i = 0; i < codePoints.length; i += 1) {
      const pVal = p[i];
      const nVal = n[i];
      if (pVal !== null && typeof pVal !== "string") {
        return false;
      }
      if (!isValidTone(nVal)) {
        return false;
      }
    }
    return true;
  }

  if (k === "p" || k === "l" || k === "s" || k === "b") {
    return true;
  }

  return false;
}

/**
 * Guard de runtime que valida `v === 1` y la estructura de cada token.
 * Si el formato es desconocido o malformado, retorna `null` sin lanzar excepciones
 * para que la UI degrade limpiamente al texto plano.
 */
export function parseTokens(raw: unknown): CueTokens | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.v !== 1 || !Array.isArray(obj.t)) {
    return null;
  }
  const tokens: Token[] = [];
  for (const item of obj.t) {
    if (!isValidToken(item)) {
      return null;
    }
    tokens.push(item);
  }
  return { v: 1, t: tokens };
}

/**
 * Reconstruye el texto plano original (`Cue.text`) concatenando `t.w`.
 */
export function tokensToPlainText(tokensOrPayload: CueTokens | readonly Token[]): string {
  const list = Array.isArray(tokensOrPayload)
    ? tokensOrPayload
    : (tokensOrPayload as CueTokens).t;
  return list.map((tok) => tok.w).join("");
}

/**
 * Convierte los tokens de un cue en una cadena de pinyin separada por espacios (`"nǐ hǎo ma"`).
 * Punto de extensión (Fase 6): permite copiar el pinyin a una `Phrase` guardada sin recalcular.
 */
export function tokensToPinyinString(
  tokensOrPayload: CueTokens | readonly Token[],
): string {
  const list = Array.isArray(tokensOrPayload)
    ? tokensOrPayload
    : (tokensOrPayload as CueTokens).t;
  const syllables: string[] = [];
  for (const tok of list) {
    if (tok.k === "w") {
      for (const syl of tok.p) {
        if (syl) {
          syllables.push(syl);
        }
      }
    }
  }
  return syllables.join(" ");
}
