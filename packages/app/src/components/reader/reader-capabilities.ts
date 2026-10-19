import type { BookFormat } from "@/lib/reader/document-loader";

export type ReaderTranslationMode = "none" | "epub" | "pdf-high-fidelity";

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
