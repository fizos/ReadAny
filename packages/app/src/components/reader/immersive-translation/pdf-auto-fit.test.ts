import { describe, expect, it } from "vitest";
import { derivePdfSourceFontSize, fitPdfTranslationText } from "./pdf-auto-fit";

describe("PDF translation auto-fit", () => {
  it("finds the largest fitting font within the bounded search", () => {
    const result = fitPdfTranslationText({
      maxIterations: 8,
      measure: (fontSize) => ({
        clientWidth: 100,
        clientHeight: 100,
        scrollWidth: fontSize > 13 ? 101 : 100,
        scrollHeight: 100,
      }),
    });

    expect(result.fontSize).toBeGreaterThanOrEqual(8);
    expect(result.fontSize).toBeLessThanOrEqual(13);
    expect(result.overflow).toBe(false);
    expect(result.iterations).toBe(8);
  });

  it("keeps the minimum size and marks deterministic overflow when no size fits", () => {
    const result = fitPdfTranslationText({
      measure: () => ({ clientWidth: 40, clientHeight: 20, scrollWidth: 80, scrollHeight: 120 }),
    });
    expect(result).toMatchObject({ fontSize: 8, overflow: true });
  });

  it("derives source typography from page-relative line geometry", () => {
    expect(derivePdfSourceFontSize(900, 0.04, 2)).toBeCloseTo(14.76, 2);
    expect(derivePdfSourceFontSize(900, 0.001, 1)).toBe(8);
  });
});
