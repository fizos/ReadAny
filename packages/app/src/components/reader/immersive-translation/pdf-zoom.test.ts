import { describe, expect, it } from "vitest";
import {
  MAX_PDF_ZOOM_PERCENT,
  MIN_PDF_ZOOM_PERCENT,
  PDF_RASTER_MAX_DIMENSION,
  PDF_RASTER_MAX_DPR,
  PDF_RASTER_MAX_PIXELS,
  clampPdfZoomPercent,
  getPdfDisplayScale,
  getPdfRasterScale,
  stepPdfZoomPercent,
} from "./pdf-zoom";

describe("PDF zoom helpers", () => {
  it("clamps manual zoom and moves in 25% steps", () => {
    expect(clampPdfZoomPercent(Number.NaN)).toBe(100);
    expect(clampPdfZoomPercent(0)).toBe(MIN_PDF_ZOOM_PERCENT);
    expect(clampPdfZoomPercent(999)).toBe(MAX_PDF_ZOOM_PERCENT);
    expect(stepPdfZoomPercent(100, 1)).toBe(125);
    expect(stepPdfZoomPercent(25, -1)).toBe(MIN_PDF_ZOOM_PERCENT);
    expect(stepPdfZoomPercent(400, 1)).toBe(MAX_PDF_ZOOM_PERCENT);
    expect(stepPdfZoomPercent(10, 1)).toBe(35);
    expect(stepPdfZoomPercent(500, -1)).toBe(400);
  });

  it("computes fit-page, fit-width, and manual display scales", () => {
    const common = {
      pageWidth: 1000,
      pageHeight: 1200,
      viewportWidth: 824,
      viewportHeight: 624,
      padding: 24,
    };
    expect(getPdfDisplayScale({ ...common, mode: "fit-page" })).toBeCloseTo(0.5);
    expect(getPdfDisplayScale({ ...common, mode: "fit-width" })).toBeCloseTo(0.8);
    expect(getPdfDisplayScale({ ...common, mode: "manual", manualPercent: 250 })).toBe(2.5);
  });

  it("caps device pixel ratio while retaining the display scale", () => {
    const displayScale = getPdfDisplayScale({
      mode: "manual",
      manualPercent: 400,
      pageWidth: 1000,
      pageHeight: 1000,
      viewportWidth: 100,
      viewportHeight: 100,
    });
    expect(displayScale).toBe(4);
    expect(
      getPdfRasterScale({ displayScale, devicePixelRatio: 4, pageWidth: 100, pageHeight: 100 }),
    ).toBe(PDF_RASTER_MAX_DPR);
  });

  it("uses a sub-0.1 raster multiplier for extreme pages to honor both caps", () => {
    const displayScale = 4;
    const pageWidth = 100_000;
    const pageHeight = 100_000;
    const rasterScale = getPdfRasterScale({
      displayScale,
      devicePixelRatio: 2,
      pageWidth,
      pageHeight,
    });
    const rasterWidth = Math.ceil(pageWidth * displayScale * rasterScale);
    const rasterHeight = Math.ceil(pageHeight * displayScale * rasterScale);

    expect(rasterScale).toBeLessThan(0.1);
    expect(rasterWidth).toBeLessThanOrEqual(PDF_RASTER_MAX_DIMENSION);
    expect(rasterHeight).toBeLessThanOrEqual(PDF_RASTER_MAX_DIMENSION);
    expect(rasterWidth * rasterHeight).toBeLessThanOrEqual(PDF_RASTER_MAX_PIXELS);
  });
});
