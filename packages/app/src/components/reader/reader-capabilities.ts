import type { BookFormat } from "@/lib/reader/document-loader";

export type ReaderTranslationMode = "none" | "epub" | "pdf-high-fidelity";

export function supportsDesktopPdfEngine(
  isDesktop: boolean,
  userAgent: string,
  platform: string,
): boolean {
  // iPadOS can advertise MacIntel; it cannot launch the bundled native engine.
  return isDesktop && (/Windows|Macintosh|Mac OS X/i.test(userAgent) || /^(Win|Mac)/i.test(platform));
}

export function getReaderTranslationMode(
  format: BookFormat,
  supportsHighFidelityPdf: boolean,
): ReaderTranslationMode {
  if (format === "EPUB") return "epub";
  if (format === "PDF" && supportsHighFidelityPdf) return "pdf-high-fidelity";
  return "none";
}

// Pointer events are primary. Mouseup is retained as a WebView fallback because
// Chromium can finish a native text selection without delivering pointerup to
// the EPUB iframe document.
export const selectionCompletionEvents = ["pointerup", "mouseup"] as const;

export function shouldPublishSelection(
  signature: string,
  now: number,
  previousSignature: string,
  previousAt: number,
  dedupeMs = 250,
): boolean {
  return signature !== previousSignature || now - previousAt >= dedupeMs;
}
