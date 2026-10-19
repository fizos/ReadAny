import { describe, expect, it } from "vitest";
import {
  getReaderTranslationMode,
  selectionCompletionEvents,
  shouldPublishSelection,
} from "./reader-capabilities";

describe("reader capabilities", () => {
  it("keeps a translation entry for EPUB without routing it to the PDF engine", () => {
    expect(getReaderTranslationMode("EPUB", true)).toBe("epub");
    expect(getReaderTranslationMode("PDF", true)).toBe("pdf-high-fidelity");
    expect(getReaderTranslationMode("PDF", false)).toBe("none");
  });

  it("has a mouse completion fallback for EPUB selections in WebView", () => {
    expect(selectionCompletionEvents).toContain("pointerup");
    expect(selectionCompletionEvents).toContain("mouseup");
  });

  it("deduplicates paired pointer and mouse completion events", () => {
    expect(shouldPublishSelection("2:selected text", 1_100, "2:selected text", 1_000)).toBe(false);
    expect(shouldPublishSelection("2:selected text", 1_300, "2:selected text", 1_000)).toBe(true);
    expect(shouldPublishSelection("2:new text", 1_050, "2:selected text", 1_000)).toBe(true);
  });
});
