/**
 * Source-side data used by immersive translation.
 *
 * These types intentionally live next to the reader rather than in the
 * chapter-translator package.  A PDF line has geometry and page identity,
 * while an EPUB block has DOM semantics; neither should be forced into the
 * existing ChapterParagraph shape.
 */

export type ImmersiveSourceKind = "epub" | "pdf";
export type ImmersiveContentKind = "prose" | "code";

/** A page-local rectangle whose coordinates are normalized to 0..1. */
export interface ImmersiveNormalizedRect {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export interface EpubSourceBlock {
  kind: "epub";
  contentKind: ImmersiveContentKind;
  id: string;
  text: string;
  tagName: string;
  sourceIndex: number;
}

/** A raw span collected from a PDF text layer before line grouping. */
export interface PdfRawTextSpan {
  text: string;
  sourceIndex: number;
  rect: ImmersiveNormalizedRect;
  /** Baseline in normalized page coordinates. */
  baseline: number;
  rotation: number;
}

/** A line assembled from one or more adjacent PDF text-layer spans. */
export interface PdfTextLine {
  text: string;
  sourceIndex: number;
  rect: ImmersiveNormalizedRect;
  baseline: number;
  spans: PdfRawTextSpan[];
  /** True when the line is a page-wide/header/footer/section separator. */
  spanning: boolean;
}

/** Short aliases for callers that model the pipeline as span -> line -> block. */
export type PdfRawSpan = PdfRawTextSpan;
export type PdfLine = PdfTextLine;

export interface PdfSourceBlock {
  kind: "pdf";
  contentKind: ImmersiveContentKind;
  id: string;
  fingerprint: string;
  text: string;
  /** PDF source blocks are line-shaped after geometry grouping. */
  tagName: "line";
  pageKey: string;
  pageWidth: number;
  pageHeight: number;
  rotation: number;
  rect: ImmersiveNormalizedRect;
  regionIndex: number;
  columnIndex: number;
  sourceIndex: number;
  spanning: boolean;
  spans: PdfRawTextSpan[];
  /** Source lines are kept verbatim and in page reading order for code blocks. */
  sourceLines: string[];
}

export type ImmersiveSourceBlock = EpubSourceBlock | PdfSourceBlock;

export interface ImmersiveSourceSnapshot {
  kind: ImmersiveSourceKind;
  bookId: string;
  sectionIndex: number;
  /** EPUB uses a section key; PDF uses a stable page key. */
  pageKey: string;
  /** Stable source fingerprint, independent of PDF zoom. */
  fingerprint: string;
  blocks: ImmersiveSourceBlock[];
  expectedBlockIds: string[];
  /** Bounded original neighbors, used as reference only, never translation targets. */
  nearbyText?: string;
  /** Present for PDF snapshots; kept optional so EPUB callers stay simple. */
  pageWidth?: number;
  pageHeight?: number;
  rotation?: number;
}

export type ImmersiveSourceResult =
  | { status: "ready"; snapshot: ImmersiveSourceSnapshot }
  | { status: "retryable"; reason: "text-layer-not-ready" }
  | { status: "unsupported"; reason: "no-extractable-text" }
  | { status: "error"; message: string };
