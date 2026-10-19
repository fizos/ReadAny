export type PdfZoomMode = "fit-page" | "fit-width" | "manual";

export const MIN_PDF_ZOOM_PERCENT = 25;
export const MAX_PDF_ZOOM_PERCENT = 400;
export const PDF_ZOOM_STEP_PERCENT = 25;
export const PDF_RASTER_MAX_PIXELS = 16_000_000;
export const PDF_RASTER_MAX_DIMENSION = 8_192;
export const PDF_RASTER_MAX_DPR = 2.5;

export function clampPdfZoomPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MAX_PDF_ZOOM_PERCENT, Math.max(MIN_PDF_ZOOM_PERCENT, Math.round(percent)));
}

export function stepPdfZoomPercent(percent: number, direction: -1 | 1): number {
  const current = Number.isFinite(percent) ? percent : 100;
  return clampPdfZoomPercent(current + direction * PDF_ZOOM_STEP_PERCENT);
}

export interface PdfDisplayScaleInput {
  mode: PdfZoomMode;
  manualPercent?: number;
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}

/**
 * Returns the CSS/display scale. This is intentionally independent of the
 * raster scale used by PDF.js, so a large page can be capped without changing
 * the percentage shown to the reader.
 */
export function getPdfDisplayScale(input: PdfDisplayScaleInput): number {
  const pageWidth = Math.max(0, input.pageWidth);
  const pageHeight = Math.max(0, input.pageHeight);
  if (!pageWidth || !pageHeight) return 1;

  if (input.mode === "manual") return clampPdfZoomPercent(input.manualPercent ?? 100) / 100;

  const padding = Math.max(0, input.padding ?? 24);
  const availableWidth = Math.max(0, input.viewportWidth - padding);
  const availableHeight = Math.max(0, input.viewportHeight - padding);
  if (!availableWidth || !availableHeight) return 1;

  const widthScale = availableWidth / pageWidth;
  if (input.mode === "fit-width") return Math.max(0.1, widthScale);
  return Math.max(0.1, Math.min(widthScale, availableHeight / pageHeight));
}

export interface PdfRasterScaleInput {
  displayScale: number;
  devicePixelRatio?: number;
  pageWidth: number;
  pageHeight: number;
  maxPixels?: number;
  maxDimension?: number;
}

/** Return the PDF.js raster multiplier, bounded for memory and browser limits. */
export function getPdfRasterScale(input: PdfRasterScaleInput): number {
  const displayScale =
    Number.isFinite(input.displayScale) && input.displayScale > 0 ? input.displayScale : 1;
  const requestedDpr = input.devicePixelRatio ?? 1;
  const dpr = Math.min(
    PDF_RASTER_MAX_DPR,
    Math.max(1, Number.isFinite(requestedDpr) ? requestedDpr : 1),
  );
  const pageWidth = Math.max(
    1,
    Number.isFinite(input.pageWidth) ? input.pageWidth * displayScale : 1,
  );
  const pageHeight = Math.max(
    1,
    Number.isFinite(input.pageHeight) ? input.pageHeight * displayScale : 1,
  );
  const requestedMaxPixels = input.maxPixels ?? PDF_RASTER_MAX_PIXELS;
  const requestedMaxDimension = input.maxDimension ?? PDF_RASTER_MAX_DIMENSION;
  const maxPixels = Math.max(
    1,
    Number.isFinite(requestedMaxPixels) ? requestedMaxPixels : PDF_RASTER_MAX_PIXELS,
  );
  const maxDimension = Math.max(
    1,
    Number.isFinite(requestedMaxDimension) ? requestedMaxDimension : PDF_RASTER_MAX_DIMENSION,
  );
  const areaLimit = Math.sqrt(maxPixels / (pageWidth * pageHeight));
  const dimensionLimit = Math.min(maxDimension / pageWidth, maxDimension / pageHeight);
  // Do not floor this value at 0.1: very large pages need a smaller raster
  // multiplier to stay within the browser's 16MP/8192px safety limits.
  return Math.max(Number.EPSILON, Math.min(dpr, areaLimit, dimensionLimit));
}
