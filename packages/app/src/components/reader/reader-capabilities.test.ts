import { describe, expect, it } from "vitest";
import {
  getReaderTranslationMode,
  selectionCompletionEvents,
  shouldPublishSelection,
  supportsDesktopPdfEngine,
} from "./reader-capabilities";

describe("reader capabilities", () => {
  it("enables the packaged PDF engine on Windows and macOS desktop only", () => {
    expect(supportsDesktopPdfEngine(true, "Windows NT 10.0", "Win32")).toBe(true);
    expect(supportsDesktopPdfEngine(true, "Macintosh; Intel Mac OS X 10_15_7", "MacIntel")).toBe(true);
    expect(supportsDesktopPdfEngine(false, "Macintosh; Intel Mac OS X", "MacIntel")).toBe(false);
    expect(supportsDesktopPdfEngine(true, "X11; Linux x86_64", "Linux x86_64")).toBe(false);
  });

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
