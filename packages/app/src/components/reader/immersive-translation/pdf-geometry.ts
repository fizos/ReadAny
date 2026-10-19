import type {
  EpubSourceBlock,
  ImmersiveContentKind,
  ImmersiveNormalizedRect,
  ImmersiveSourceSnapshot,
  PdfRawTextSpan,
  PdfSourceBlock,
  PdfTextLine,
} from "./types";

const FINGERPRINT_DIGITS = 6;
const MIN_LINE_TOLERANCE = 0.006;
const SPANNING_WIDTH = 0.78;
const NO_COLUMN = -1;
const AFTER_COLUMNS = Number.MAX_SAFE_INTEGER;

export interface PdfRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
}

export interface PdfTextSpanInput {
  text: string;
  rect: PdfRectLike;
  /** Baseline in the same coordinate system as rect, if available. */
  baseline?: number;
  sourceIndex?: number;
}

export interface PdfTextLayerSpanOptions {
  pageRect: PdfRectLike;
  rotation?: number;
}

export interface PdfSourceBuildOptions {
  bookId: string;
  sectionIndex: number;
  pageKey: string;
  pageWidth: number;
  pageHeight: number;
  rotation?: number;
  spans: readonly (PdfTextSpanInput | PdfRawTextSpan)[];
}

/** Normalize a text-layer rectangle against its page/text-layer bounds. */
export function normalizePdfRect(
  rect: PdfRectLike,
  pageRect: PdfRectLike,
): ImmersiveNormalizedRect {
  const pageWidth = Math.max(Math.abs(pageRect.width), Number.EPSILON);
  const pageHeight = Math.max(Math.abs(pageRect.height), Number.EPSILON);
  const right = rect.right ?? rect.left + rect.width;
  const bottom = rect.bottom ?? rect.top + rect.height;
  const left = rounded(clamp((rect.left - pageRect.left) / pageWidth));
  const top = rounded(clamp((rect.top - pageRect.top) / pageHeight));
  const normalizedRight = rounded(clamp((right - pageRect.left) / pageWidth));
  const normalizedBottom = rounded(clamp((bottom - pageRect.top) / pageHeight));

  return {
    left,
    top,
    width: rounded(Math.max(0, normalizedRight - left)),
    height: rounded(Math.max(0, normalizedBottom - top)),
    right: normalizedRight,
    bottom: normalizedBottom,
  };
}

/**
 * Collect visible spans from a PDF.js text layer.  The returned rectangles
 * are normalized to the text layer, so browser zoom and page scale disappear
 * from all later grouping/fingerprint decisions.
 */
export function collectPdfTextLayerSpans(
  textLayer: Element,
  options: PdfTextLayerSpanOptions,
): PdfRawTextSpan[] {
  const pageRect = options.pageRect;
  const rotation = normalizeRotation(options.rotation ?? 0);
  const spans: PdfRawTextSpan[] = [];
  const elements = textLayer.querySelectorAll("span");

  elements.forEach((element, index) => {
    const text = preserveSourceText(element.textContent ?? "");
    const rect = element.getBoundingClientRect();
    if (!text.trim() || rect.width <= 0 || rect.height <= 0) return;
    const normalizedRect = normalizePdfRect(rect, pageRect);
    spans.push({
      text,
      rect: normalizedRect,
      baseline: normalizedRect.bottom,
      rotation,
      sourceIndex: index,
    });
  });

  return spans;
}

/** Group PDF spans into lines, then classify page-wide/cross-gutter lines. */
export function groupPdfTextLayerLines(spans: readonly PdfRawTextSpan[]): PdfTextLine[] {
  const usable = spans
    .filter(
      (span) =>
        preserveSourceText(span.text).trim().length > 0 &&
        span.rect.width > 0 &&
        span.rect.height > 0,
    )
    .map((span, index) => ({
      ...span,
      text: preserveSourceText(span.text),
      sourceIndex: Number.isFinite(span.sourceIndex) ? span.sourceIndex : index,
    }))
    .sort(
      (a, b) =>
        a.baseline - b.baseline || a.rect.left - b.rect.left || a.sourceIndex - b.sourceIndex,
    );

  const lineHeight = median(usable.map((span) => span.rect.height)) || 0.01;
  const baselineTolerance = Math.max(MIN_LINE_TOLERANCE, lineHeight * 0.65);
  const horizontalTolerance = Math.max(0.012, lineHeight * 1.8);
  const lines: Array<{ spans: PdfRawTextSpan[]; baseline: number }> = [];

  for (const span of usable) {
    let bestLine: (typeof lines)[number] | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const distance = Math.abs(span.baseline - line.baseline);
      if (
        distance > baselineTolerance ||
        !isHorizontallyAdjacent(span, line.spans, horizontalTolerance)
      ) {
        continue;
      }
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = line;
      }
    }

    if (bestLine) {
      bestLine.spans.push(span);
      bestLine.baseline = average(bestLine.spans.map((item) => item.baseline));
    } else {
      lines.push({ spans: [span], baseline: span.baseline });
    }
  }

  return lines
    .map((line) => {
      const lineSpans = [...line.spans].sort(
        (a, b) => a.rect.left - b.rect.left || a.sourceIndex - b.sourceIndex,
      );
      const rect = unionRects(lineSpans.map((span) => span.rect));
      return {
        text: joinSpanText(lineSpans),
        sourceIndex: Math.min(...lineSpans.map((span) => span.sourceIndex)),
        rect,
        baseline: average(lineSpans.map((span) => span.baseline)),
        spans: lineSpans,
        spanning: isSpanningLine(rect),
      } satisfies PdfTextLine;
    })
    .sort(
      (a, b) =>
        a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.sourceIndex - b.sourceIndex,
    );
}

/**
 * Build stable, page-local PDF source blocks.  Regions are split by spanning
 * lines and columns are inferred independently in each region, preventing a
 * two-column page from joining adjacent rows from different columns.
 */
export function buildPdfSourceBlocks(options: PdfSourceBuildOptions): PdfSourceBlock[] {
  const lines = refineCrossGutterSpanning(
    groupPdfTextLayerLines(
      options.spans.map((span, index) => toNormalizedRawSpan(span, options, index)),
    ),
  );
  const records: Array<{ line: PdfTextLine; regionIndex: number }> = [];
  let regionIndex = 0;
  for (const line of lines) {
    records.push({ line, regionIndex });
    if (line.spanning) regionIndex++;
  }

  const regionLines = new Map<number, PdfTextLine[]>();
  for (const record of records) {
    if (record.line.spanning) continue;
    const linesInRegion = regionLines.get(record.regionIndex) ?? [];
    linesInRegion.push(record.line);
    regionLines.set(record.regionIndex, linesInRegion);
  }

  const columnByLine = new Map<PdfTextLine, number>();
  for (const linesInRegion of regionLines.values()) {
    const columns = detectColumns(linesInRegion);
    for (const [columnIndex, columnLines] of columns.entries()) {
      for (const line of columnLines) columnByLine.set(line, columnIndex);
    }
  }

  const hasEarlierLine = new Set<number>();
  const blocks = records.map(({ line, regionIndex: lineRegion }) => {
    let columnIndex = columnByLine.get(line) ?? NO_COLUMN;
    if (line.spanning) {
      const hadEarlier = hasEarlierLine.has(lineRegion);
      columnIndex = hadEarlier ? AFTER_COLUMNS : NO_COLUMN;
    } else {
      hasEarlierLine.add(lineRegion);
    }

    const rect = line.rect;
    const fingerprint = fingerprintPdfBlock(
      options.pageKey,
      rect,
      line.text,
      lineRegion,
      columnIndex,
    );
    return {
      kind: "pdf" as const,
      contentKind: "prose" as const,
      id: `pdf_${shortHash(fingerprint)}`,
      fingerprint,
      text: line.text,
      tagName: "line" as const,
      pageKey: options.pageKey,
      pageWidth: options.pageWidth,
      pageHeight: options.pageHeight,
      rotation: normalizeRotation(options.rotation ?? line.spans[0]?.rotation ?? 0),
      rect,
      regionIndex: lineRegion,
      columnIndex,
      sourceIndex: line.sourceIndex,
      spanning: line.spanning,
      spans: line.spans,
      sourceLines: [line.text],
    } satisfies PdfSourceBlock;
  });

  const sortedBlocks = blocks.sort(
    (a, b) =>
      a.regionIndex - b.regionIndex ||
      a.columnIndex - b.columnIndex ||
      a.rect.top - b.rect.top ||
      a.rect.left - b.rect.left ||
      a.sourceIndex - b.sourceIndex,
  );
  return mergeAdjacentPdfLineBlocks(classifyPdfBlocks(sortedBlocks));
}

export function buildPdfSourceSnapshot(options: PdfSourceBuildOptions): ImmersiveSourceSnapshot {
  const blocks = buildPdfSourceBlocks(options);
  const fingerprint = shortHash(
    [options.pageKey, ...blocks.map((block) => block.fingerprint)].join("|"),
  );
  return {
    kind: "pdf",
    bookId: options.bookId,
    sectionIndex: options.sectionIndex,
    pageKey: options.pageKey,
    fingerprint,
    blocks,
    expectedBlockIds: blocks
      .filter((block) => block.contentKind === "prose")
      .map((block) => block.id),
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    rotation: normalizeRotation(options.rotation ?? 0),
  };
}

export interface EpubSourceBlockInput {
  id: string;
  text: string;
  tagName: string;
  sourceIndex: number;
  contentKind?: ImmersiveContentKind;
}

export function buildEpubSourceSnapshot(
  bookId: string,
  sectionIndex: number,
  pageKey: string,
  sourceBlocks: readonly EpubSourceBlockInput[],
): ImmersiveSourceSnapshot {
  const blocks: EpubSourceBlock[] = sourceBlocks
    .filter((block) => normalizeText(block.text).length > 0)
    .map((block) => ({
      kind: "epub",
      contentKind: block.contentKind ?? (/^(?:pre|code)$/iu.test(block.tagName) ? "code" : "prose"),
      id: block.id,
      text: block.text,
      tagName: block.tagName,
      sourceIndex: block.sourceIndex,
    }));
  return {
    kind: "epub",
    bookId,
    sectionIndex,
    pageKey,
    fingerprint: shortHash(
      [pageKey, ...blocks.map((block) => `${block.id}|${normalizeText(block.text)}`)].join("|"),
    ),
    blocks,
    expectedBlockIds: blocks
      .filter((block) => block.contentKind === "prose")
      .map((block) => block.id),
  };
}

export function fingerprintPdfBlock(
  pageKey: string,
  rect: ImmersiveNormalizedRect,
  text: string,
  regionIndex: number,
  columnIndex: number,
  contentKind: ImmersiveContentKind = "prose",
  sourceLines?: readonly string[],
): string {
  const geometry = [rect.left, rect.top, rect.width, rect.height]
    .map((value) => fixed(value))
    .join(",");
  return `${pageKey}|${geometry}|${normalizeText(text).toLowerCase()}|${regionIndex}|${columnIndex}|${contentKind}|${sourceLines?.join("\n") ?? ""}`;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Keep source line whitespace for display while using normalizeText for IDs/filtering. */
function preserveSourceText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\s+$/u, "");
}

function detectColumns(lines: readonly PdfTextLine[]): PdfTextLine[][] {
  if (lines.length === 0) return [];
  const lineHeight = median(lines.map((line) => line.rect.height)) || 0.01;
  const tolerance = Math.max(0.12, lineHeight * 8);
  const sorted = [...lines].sort(
    (a, b) => a.rect.left - b.rect.left || a.sourceIndex - b.sourceIndex,
  );
  const columns: PdfTextLine[][] = [];

  for (const line of sorted) {
    const current = columns[columns.length - 1];
    const currentLeft = current?.[0]?.rect.left;
    if (current && currentLeft !== undefined && line.rect.left - currentLeft <= tolerance) {
      current.push(line);
    } else {
      columns.push([line]);
    }
  }

  // A single narrow block with a modest indent is not enough evidence for a
  // column. A clear page gutter is sufficient even when a short region has
  // only one row in each column.
  if (columns.length > 1) {
    const supported = columns.filter((column) => column.length >= 2);
    const largestLeftGap = Math.max(
      ...columns.slice(1).map((column, index) => column[0].rect.left - columns[index][0].rect.left),
    );
    if (supported.length < 2 && largestLeftGap < 0.25) return [sorted];
  }
  return columns;
}

function toNormalizedRawSpan(
  span: PdfTextSpanInput | PdfRawTextSpan,
  options: PdfSourceBuildOptions,
  index: number,
): PdfRawTextSpan {
  if ("rotation" in span) return span;
  const normalized = isNormalizedRect(span.rect, options.pageWidth, options.pageHeight)
    ? normalizePdfRect(span.rect, { left: 0, top: 0, width: 1, height: 1 })
    : normalizePdfRect(span.rect, {
        left: 0,
        top: 0,
        width: options.pageWidth,
        height: options.pageHeight,
      });
  const baseline =
    span.baseline === undefined
      ? normalized.bottom
      : isNormalizedRect(span.rect, options.pageWidth, options.pageHeight)
        ? span.baseline
        : span.baseline / Math.max(options.pageHeight, Number.EPSILON);
  return {
    text: span.text,
    rect: normalized,
    baseline,
    rotation: normalizeRotation(options.rotation ?? 0),
    sourceIndex: span.sourceIndex ?? index,
  };
}

function isNormalizedRect(rect: PdfRectLike, pageWidth: number, pageHeight: number): boolean {
  if (pageWidth <= 1 && pageHeight <= 1) return true;
  const right = rect.right ?? rect.left + rect.width;
  const bottom = rect.bottom ?? rect.top + rect.height;
  return [rect.left, rect.top, rect.width, rect.height, right, bottom].every(
    (value) => value >= 0 && value <= 1,
  );
}

function isHorizontallyAdjacent(
  span: PdfRawTextSpan,
  existing: readonly PdfRawTextSpan[],
  tolerance: number,
): boolean {
  return existing.some((item) => {
    const gap = Math.max(item.rect.left - span.rect.right, span.rect.left - item.rect.right, 0);
    return gap <= tolerance;
  });
}

function isSpanningLine(rect: ImmersiveNormalizedRect): boolean {
  return rect.width >= SPANNING_WIDTH;
}

/**
 * A centered heading can cross both columns without being page-wide.  Only
 * promote such a line when paired left/right rows prove that this page really
 * has a gutter; otherwise ordinary centered single-column body lines would be
 * split into separate regions and could no longer be merged into paragraphs.
 */
function refineCrossGutterSpanning(lines: readonly PdfTextLine[]): PdfTextLine[] {
  const leftLines = lines.filter((line) => !line.spanning && line.rect.right <= 0.48);
  const rightLines = lines.filter((line) => !line.spanning && line.rect.left >= 0.52);
  const hasPairedColumns = leftLines.some((left) =>
    rightLines.some((right) => {
      const rowTolerance = Math.max(0.02, left.rect.height * 1.5, right.rect.height * 1.5);
      return Math.abs(left.rect.top - right.rect.top) <= rowTolerance;
    }),
  );
  if (!hasPairedColumns) return [...lines];

  return lines.map((line) => {
    if (line.spanning || line.rect.left >= 0.48 || line.rect.right <= 0.52) return line;
    return { ...line, spanning: true };
  });
}

/**
 * PDF text layers do not expose DOM semantics.  Only high-signal standalone
 * syntax starts a code run; ordinary lines inherit that run until a clear
 * prose line or a closing delimiter ends it.
 */
export function classifyPdfContentKind(text: string): ImmersiveContentKind {
  return isHighConfidencePdfCodeLine(text) ? "code" : "prose";
}

export function isHighConfidencePdfCodeLine(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return [
    // HTML/Vue/JSX tags and Svelte control blocks.
    /^<\/?[A-Za-z][\w:.-]*(?:\s+[^<>]*)?\/?>(?:\s*)$/u,
    /^\{[#/:@][^{}]+\}$/u,
    // Imports, declarations, and common expression statements.
    /^(?:import|export|const|let|var|function|class|interface|type|enum|namespace|return|throw|if|else|for|while|switch|case|try|catch|finally|async)\b/u,
    /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\s*\(/u,
    /^(?:[A-Za-z_$][\w$]*\s*=>|\(?[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\)?\s*=>)/u,
    /^\{(?:[^{}]|\{[^{}]*\})+\}$/u,
    // Comments, braces, and delimiters are unambiguous source syntax.
    /^(?:(?:\/\/|\/\*|\*|<!--|-->).*)$/u,
    /^[{}[\]();,:]+$/u,
    /^(?:<\/?|[{}()[\];])[^\s]*$/u,
    // Standalone developer commands are useful source, not prose.
    /^(?:npm|pnpm|yarn|bun|npx|cargo|go|docker|git|kubectl|curl|pip|python|node)\s+[^.?!]+$/iu,
  ].some((pattern) => pattern.test(value));
}

export interface PdfBlockSlot {
  top: number;
  bottom: number;
  height: number;
}

/**
 * Reserve the source rectangle first, then use only a later block in the same
 * reading track (or a genuinely overlapping track) as the available slot.
 * A same-row neighbor in another column is intentionally ignored.
 */
export function calculatePdfBlockSlot(
  block: PdfSourceBlock,
  blocks: readonly PdfSourceBlock[],
  pageBottom = 1,
  bottomMargin = 0.015,
): PdfBlockSlot {
  const minimumBottom = block.rect.top + Math.max(0, block.rect.height);
  const later = blocks
    .filter((candidate) => candidate.id !== block.id)
    .filter(
      (candidate) =>
        candidate.rect.top >= block.rect.bottom - Math.max(0.001, block.rect.height * 0.2),
    )
    .filter((candidate) => {
      const sameTrack =
        candidate.regionIndex === block.regionIndex && candidate.columnIndex === block.columnIndex;
      return sameTrack || meaningfulHorizontalOverlap(block, candidate);
    })
    .sort((a, b) => a.rect.top - b.rect.top || a.sourceIndex - b.sourceIndex);
  const bottom = Math.max(
    minimumBottom,
    later[0]?.rect.top ?? Math.max(minimumBottom, pageBottom - bottomMargin),
  );
  return { top: block.rect.top, bottom, height: bottom - block.rect.top };
}

export const getPdfBlockSlot = calculatePdfBlockSlot;

function meaningfulHorizontalOverlap(left: PdfSourceBlock, right: PdfSourceBlock): boolean {
  const overlap = Math.max(
    0,
    Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left),
  );
  const shorterWidth = Math.max(Number.EPSILON, Math.min(left.rect.width, right.rect.width));
  return overlap / shorterWidth >= 0.35;
}

function isPdfClosingCodeLine(text: string): boolean {
  const value = text.trim();
  return (
    /^<\/[A-Za-z][\w:.-]*\s*>$/u.test(value) ||
    /^(?:[}\])>;]+|-->)$/u.test(value) ||
    /^(?:else|catch|finally)\s*\}?$/u.test(value)
  );
}

type PdfCodeRun =
  | { kind: "html"; name: string }
  | { kind: "svelte"; name: string }
  | { kind: "delimiters"; depth: number };

function startPdfCodeRun(text: string): PdfCodeRun | null {
  const value = text.trim();
  const html = value.match(/^<([A-Za-z][\w:.-]*)\b[^>]*>/u);
  if (html && !/\/>\s*$/u.test(value)) {
    const name = html[1].toLowerCase();
    if (!value.toLowerCase().includes(`</${name}>`)) return { kind: "html", name };
  }

  const svelte = value.match(/^\{#([A-Za-z][\w-]*)\b/u);
  if (svelte) return { kind: "svelte", name: svelte[1].toLowerCase() };

  const depth = pdfDelimiterDepth(value);
  return depth > 0 ? { kind: "delimiters", depth } : null;
}

function continuePdfCodeRun(run: PdfCodeRun, text: string): PdfCodeRun | null {
  const value = text.trim();
  if (run.kind === "html") {
    return value.toLowerCase().includes(`</${run.name}>`) ? null : run;
  }
  if (run.kind === "svelte") {
    return value.toLowerCase().includes(`{/${run.name}}`) ? null : run;
  }
  const depth = run.depth + pdfDelimiterDepth(value);
  return depth > 0 ? { ...run, depth } : null;
}

function pdfDelimiterDepth(text: string): number {
  let depth = 0;
  for (const character of text) {
    if (character === "{" || character === "[" || character === "(") depth++;
    else if (character === "}" || character === "]" || character === ")") depth--;
  }
  return depth;
}

function classifyPdfBlocks(blocks: readonly PdfSourceBlock[]): PdfSourceBlock[] {
  const activeTracks = new Map<string, PdfCodeRun>();
  return blocks.map((block) => {
    const track = `${block.regionIndex}:${block.columnIndex}`;
    const activeRun = activeTracks.get(track);
    const startsCode = isHighConfidencePdfCodeLine(block.text);
    const contentKind: ImmersiveContentKind = startsCode || activeRun ? "code" : "prose";
    if (activeRun) {
      const continued = continuePdfCodeRun(activeRun, block.text);
      if (continued) activeTracks.set(track, continued);
      else activeTracks.delete(track);
    } else if (startsCode && !isPdfClosingCodeLine(block.text)) {
      const started = startPdfCodeRun(block.text);
      if (started) activeTracks.set(track, started);
    }
    const fingerprint = fingerprintPdfBlock(
      block.pageKey,
      block.rect,
      block.text,
      block.regionIndex,
      block.columnIndex,
      contentKind,
      block.sourceLines,
    );
    return { ...block, contentKind, fingerprint, id: `pdf_${shortHash(fingerprint)}` };
  });
}

function mergeAdjacentPdfLineBlocks(blocks: readonly PdfSourceBlock[]): PdfSourceBlock[] {
  if (blocks.length < 2) return [...blocks];
  const medianLineHeight = median(blocks.map((block) => block.rect.height)) || 0.01;
  const maxVerticalGap = Math.max(0.012, medianLineHeight * 0.9);
  const merged: PdfSourceBlock[] = [];

  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    const verticalGap = previous ? block.rect.top - previous.rect.bottom : Number.POSITIVE_INFINITY;
    const sameTrack =
      previous &&
      !previous.spanning &&
      !block.spanning &&
      previous.regionIndex === block.regionIndex &&
      previous.columnIndex === block.columnIndex &&
      previous.contentKind === block.contentKind &&
      Math.abs(previous.rect.left - block.rect.left) <= 0.06 &&
      verticalGap >= -medianLineHeight * 0.25 &&
      verticalGap <= maxVerticalGap;

    if (!sameTrack || !previous) {
      merged.push(block);
      continue;
    }

    const rect = unionRects([previous.rect, block.rect]);
    const sourceLines = [...previous.sourceLines, ...block.sourceLines];
    const text =
      block.contentKind === "code" ? sourceLines.join("\n") : normalizeText(sourceLines.join(" "));
    const fingerprint = fingerprintPdfBlock(
      previous.pageKey,
      rect,
      text,
      previous.regionIndex,
      previous.columnIndex,
      block.contentKind,
      sourceLines,
    );
    merged[merged.length - 1] = {
      ...previous,
      id: `pdf_${shortHash(fingerprint)}`,
      fingerprint,
      text,
      rect,
      sourceLines,
      sourceIndex: Math.min(previous.sourceIndex, block.sourceIndex),
      spans: [...previous.spans, ...block.spans],
    };
  }

  return merged;
}

function joinSpanText(spans: readonly PdfRawTextSpan[]): string {
  let output = "";
  for (const [index, span] of spans.entries()) {
    const sourceText = preserveSourceText(span.text);
    if (!output) {
      output = sourceText;
      continue;
    }
    const gap = span.rect.left - (spans[index - 1]?.rect.right ?? span.rect.left);
    const needsSpace =
      !/\s$/u.test(output) &&
      !/^\s/u.test(sourceText) &&
      !/^[,.;:!?%)\]}]/u.test(sourceText) &&
      gap > Math.max(0.002, span.rect.height * 0.2);
    output += needsSpace ? ` ${sourceText}` : sourceText;
  }
  return preserveSourceText(output);
}

function unionRects(rects: readonly ImmersiveNormalizedRect[]): ImmersiveNormalizedRect {
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top, right, bottom };
}

function fixed(value: number): string {
  return value.toFixed(FINGERPRINT_DIGITS);
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function rounded(value: number): number {
  return Number(value.toFixed(FINGERPRINT_DIGITS));
}

function average(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function normalizeRotation(rotation: number): number {
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized === 0 ? 0 : normalized;
}
