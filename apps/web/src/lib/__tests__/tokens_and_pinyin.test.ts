import { describe, expect, it } from "vitest";
import { toNumeric } from "../pinyin";
import {
  isHanChar,
  parseTokens,
  tokensToPinyinString,
  tokensToPlainText,
  type CueTokens,
} from "../tokens";

const SAMPLE_CUE_TOKENS: CueTokens = {
  v: 1,
  t: [
    { w: "你好", p: ["nǐ", "hǎo"], n: [3, 3], k: "w" },
    { w: "，", k: "p" },
    { w: "2024", k: "l" },
    { w: "年", p: ["nián"], n: [2], k: "w" },
    { w: " ", k: "s" },
    { w: "OK", k: "l" },
    { w: "\n", k: "b" },
    { w: "绿女", p: ["lǜ", "nǚ"], n: [4, 3], k: "w" },
    { w: "！", k: "p" },
  ],
};

describe("tokens.ts — parseTokens, tokensToPlainText, isHanChar", () => {
  it("reconstruye exactamente el texto original con puntuación, latín, números y saltos de línea", () => {
    const reconstructed = tokensToPlainText(SAMPLE_CUE_TOKENS);
    expect(reconstructed).toBe("你好，2024年 OK\n绿女！");
  });

  it("valida v === 1 y rechaza versiones desconocidas o datos malformados sin lanzar", () => {
    expect(parseTokens(SAMPLE_CUE_TOKENS)).toEqual(SAMPLE_CUE_TOKENS);
    expect(parseTokens({ v: 2, t: [] })).toBeNull();
    expect(parseTokens(null)).toBeNull();
    expect(parseTokens("no-es-objeto")).toBeNull();
    // Longitud de p distinta de la cantidad de caracteres de w
    expect(
      parseTokens({
        v: 1,
        t: [{ w: "你好", p: ["nǐ"], n: [3, 3], k: "w" }],
      }),
    ).toBeNull();
    // Tono fuera de rango 1..5
    expect(
      parseTokens({
        v: 1,
        t: [{ w: "你", p: ["nǐ"], n: [9], k: "w" }],
      }),
    ).toBeNull();
  });

  it("soporta caracteres Han fuera del BMP (Extensión B) en parseTokens e isHanChar", () => {
    const extBChar = "𠮷"; // U+20BB7
    const cp = extBChar.codePointAt(0)!;
    expect(isHanChar(cp)).toBe(true);
    expect(isHanChar("〇".codePointAt(0)!)).toBe(true);
    expect(isHanChar("A".codePointAt(0)!)).toBe(false);

    const parsed = parseTokens({
      v: 1,
      t: [{ w: "𠮷", p: [null], n: [null], k: "w" }],
    });
    expect(parsed).not.toBeNull();
  });

  it("convierte tokens a string de pinyin para frases guardadas (Fase 6)", () => {
    expect(tokensToPinyinString(SAMPLE_CUE_TOKENS)).toBe("nǐ hǎo nián lǜ nǚ");
  });
});

describe("pinyin.ts — toNumeric", () => {
  it("convierte marcas tonales a dígitos conservando la diéresis ü", () => {
    expect(toNumeric("nǐ", 3)).toBe("ni3");
    expect(toNumeric("hǎo", 3)).toBe("hao3");
    expect(toNumeric("ma", 5)).toBe("ma5");
    expect(toNumeric("lǜ", 4)).toBe("lü4");
    expect(toNumeric("nǚ", 3)).toBe("nü3");
    expect(toNumeric("ǖ", 1)).toBe("ü1");
    expect(toNumeric("ǘ", 2)).toBe("ü2");
    expect(toNumeric("ǚ", 3)).toBe("ü3");
    expect(toNumeric("ǜ", 4)).toBe("ü4");
  });
});
