import { describe, expect, it } from "vitest";
import { PDF_THEME_FILTERS } from "./theme";

describe("PDF paper colors", () => {
  it.each(["light", "green", "sepia"] as const)("preserves document pixels in %s", theme => {
    expect(PDF_THEME_FILTERS[theme] || "none").toBe("none");
  });
  it("retains dark-mode inversion", () => {
    expect(PDF_THEME_FILTERS.dark).toBe("invert(0.93)");
  });
});
