import type { ImmersiveSourceResult, ImmersiveSourceSnapshot } from "./types";

export type PdfTextLayerState = "loading" | "ready" | "error" | "missing";

/** Map the PDF text-layer lifecycle to the source API's typed result. */
export function classifyPdfSourceResult(
  state: PdfTextLayerState,
  snapshot: ImmersiveSourceSnapshot | undefined,
  errorMessage = "PDF text layer failed to render",
): ImmersiveSourceResult {
  if (state === "loading" || state === "missing") {
    return { status: "retryable", reason: "text-layer-not-ready" };
  }
  if (state === "error") {
    return { status: "error", message: errorMessage };
  }
  if (!snapshot || snapshot.blocks.length === 0) {
    return { status: "unsupported", reason: "no-extractable-text" };
  }
  return { status: "ready", snapshot };
}
