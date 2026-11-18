import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CueTokens } from "../../lib/tokens";
import { CueText } from "../CueText";

const SAMPLE_TOKENS: CueTokens = {
  v: 1,
  t: [
    { w: "你好", p: ["nǐ", "hǎo"], n: [3, 3], k: "w" },
    { w: "，", k: "p" },
    { w: "2024", k: "l" },
    { w: "年", p: ["nián"], n: [2], k: "w" },
  ],
};

describe("CueText component", () => {
  it("renderiza exactamente un <ruby> por cada carácter Han y <rt aria-hidden='true'> cuando showPinyin=true", () => {
    const { container } = render(
      <CueText
        text="你好，2024年"
        tokens={SAMPLE_TOKENS}
        lang="zh"
        script="hans"
        variant="overlay"
        showPinyin={true}
        colorTones={true}
        pinyinStyle="marks"
        cueIdx={7}
      />,
    );

    const rubies = container.querySelectorAll("ruby");
    // "你", "好", "年" -> 3 caracteres Han
    expect(rubies.length).toBe(3);

    const rts = container.querySelectorAll("rt");
    expect(rts.length).toBe(3);
    rts.forEach((rt) => {
      expect(rt.getAttribute("aria-hidden")).toBe("true");
    });

    const words = container.querySelectorAll(".zh-word");
    expect(words.length).toBe(2);
    expect(words[0].getAttribute("data-token-idx")).toBe("0");
    expect(words[0].getAttribute("data-cue-idx")).toBe("7");
    expect(words[1].getAttribute("data-token-idx")).toBe("3");
  });

  it("omite los elementos <rt> por completo cuando showPinyin=false", () => {
    const { container } = render(
      <CueText text="你好，2024年" tokens={SAMPLE_TOKENS} lang="zh" showPinyin={false} />,
    );

    expect(container.querySelectorAll("ruby").length).toBe(3);
    expect(container.querySelectorAll("rt").length).toBe(0);
  });

  it("degrada a texto plano cuando no hay tokens o son inválidos", () => {
    const { container } = render(<CueText text="Hola mundo" tokens={null} lang="es" />);
    expect(container.querySelectorAll("ruby").length).toBe(0);
    expect(container.textContent).toBe("Hola mundo");
  });

  it("asigna lang='zh-Hant' cuando la pista es tradicional (script='hant')", () => {
    const { container } = render(
      <CueText
        text="我們去銀行"
        tokens={{
          v: 1,
          t: [{ w: "銀行", p: ["yín", "háng"], n: [2, 2], k: "w" }],
        }}
        lang="zh"
        script="hant"
        showPinyin={true}
      />,
    );

    const rootSpan = container.querySelector("span[lang]");
    expect(rootSpan?.getAttribute("lang")).toBe("zh-Hant");
  });

  it("muestra tonos numéricos cuando pinyinStyle='numbers'", () => {
    const { container } = render(
      <CueText
        text="你好"
        tokens={SAMPLE_TOKENS}
        lang="zh"
        showPinyin={true}
        pinyinStyle="numbers"
      />,
    );

    const rtTexts = Array.from(container.querySelectorAll("rt")).map(
      (el) => el.textContent,
    );
    expect(rtTexts).toEqual(["ni3", "hao3", "nian2"]);
  });

  it("invoca onWordActivate con stopPropagation y metadatos al hacer click en .zh-word", () => {
    const parentClick = vi.fn();
    const onWordActivate = vi.fn();

    const { container } = render(
      <div onClick={parentClick}>
        <CueText
          text="你好，2024年"
          tokens={SAMPLE_TOKENS}
          lang="zh"
          variant="panel"
          showPinyin={true}
          cueIdx={4}
          onWordActivate={onWordActivate}
        />
      </div>,
    );

    const firstWord = container.querySelector(".zh-word") as HTMLElement;
    expect(firstWord).not.toBeNull();
    fireEvent.click(firstWord);

    expect(parentClick).not.toHaveBeenCalled();
    expect(onWordActivate).toHaveBeenCalledTimes(1);
    expect(onWordActivate.mock.calls[0][0]).toMatchObject({
      cueIdx: 4,
      tokenIdx: 0,
      word: "你好",
      source: "panel",
      pinned: true,
    });
  });
});
