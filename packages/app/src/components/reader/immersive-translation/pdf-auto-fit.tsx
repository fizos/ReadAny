import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";

export interface PdfFitMeasurement {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}

export interface PdfFitResult {
  fontSize: number;
  overflow: boolean;
  iterations: number;
}

export interface PdfFitOptions {
  minFontSize?: number;
  maxFontSize?: number;
  maxIterations?: number;
  measure: (fontSize: number) => PdfFitMeasurement;
}

/**
 * Find the largest readable size that fits a translated source slot. The
 * monotonic search is deliberately bounded so a pathological translation can
 * never stall rendering.
 */
export function fitPdfTranslationText({
  minFontSize = 8,
  maxFontSize = 18,
  maxIterations = 8,
  measure,
}: PdfFitOptions): PdfFitResult {
  const min = Math.min(minFontSize, maxFontSize);
  const max = Math.max(minFontSize, maxFontSize);
  let low = min;
  let high = max;
  let best = min;
  let foundFit = false;
  let iterations = 0;

  for (; iterations < maxIterations; iterations++) {
    const candidate = (low + high) / 2;
    const measurement = measure(candidate);
    if (fitsPdfMeasurement(measurement)) {
      foundFit = true;
      best = candidate;
      low = candidate;
    } else {
      high = candidate;
    }
  }

  // The binary search can finish just above the lower bound. Measure the
  // bound explicitly so overflow=true is deterministic when even 8px fails.
  if (!foundFit) {
    const minimum = measure(min);
    foundFit = fitsPdfMeasurement(minimum);
  }

  return {
    fontSize: roundPdfFontSize(foundFit ? best : min),
    overflow: !foundFit,
    iterations,
  };
}

export function fitsPdfMeasurement(measurement: PdfFitMeasurement): boolean {
  return (
    measurement.scrollWidth <= measurement.clientWidth + 0.5 &&
    measurement.scrollHeight <= measurement.clientHeight + 0.5
  );
}

/** Approximate the source font from the page-relative PDF line geometry. */
export function derivePdfSourceFontSize(
  pageHeightPx: number,
  sourceRectHeight: number,
  sourceLineCount: number,
): number {
  const lineHeight =
    (Math.max(0, pageHeightPx) * Math.max(0, sourceRectHeight)) /
    Math.max(1, Math.floor(sourceLineCount));
  return clampPdfFontSize(lineHeight * 0.82);
}

export function clampPdfFontSize(value: number): number {
  return Math.min(18, Math.max(8, Number.isFinite(value) ? value : 8));
}

function roundPdfFontSize(value: number): number {
  return Number(value.toFixed(2));
}

interface PdfTranslationAutoFitProps {
  pageRef: RefObject<HTMLElement | null>;
  sourceRectHeight: number;
  sourceLineCount: number;
  sourceText: string;
  translatedText?: string;
  code?: boolean;
  className?: string;
  style?: CSSProperties;
}

const INITIAL_FIT: PdfFitResult = { fontSize: 8, overflow: false, iterations: 0 };

/** Render one absolute PDF slot while retaining a safe overflow fallback. */
export function PdfTranslationAutoFit({
  pageRef,
  sourceRectHeight,
  sourceLineCount,
  sourceText,
  translatedText,
  code = false,
  className,
  style,
}: PdfTranslationAutoFitProps) {
  const [fit, setFit] = useState<PdfFitResult>(INITIAL_FIT);
  const elementRef = useRef<HTMLElement | null>(null);
  const displayText = code ? sourceText : translatedText || "";

  useLayoutEffect(() => {
    const element = elementRef.current;
    const page = pageRef.current;
    if (!element || !page) return;
    if (!displayText) {
      setFit(INITIAL_FIT);
      return;
    }

    const refit = () => {
      const sourceFontSize = derivePdfSourceFontSize(
        page.clientHeight,
        sourceRectHeight,
        sourceLineCount,
      );
      const result = fitPdfTranslationText({
        minFontSize: 8,
        maxFontSize: sourceFontSize,
        maxIterations: 8,
        measure: (fontSize) => {
          element.style.fontSize = `${fontSize}px`;
          element.style.lineHeight = `${fontSize * 1.25}px`;
          return {
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
          };
        },
      });
      setFit(result);
      element.style.fontSize = `${result.fontSize}px`;
      element.style.lineHeight = `${result.fontSize * 1.25}px`;
    };

    refit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(refit);
    observer.observe(page);
    return () => observer.disconnect();
  }, [displayText, pageRef, sourceLineCount, sourceRectHeight]);

  return (
    <article
      ref={elementRef}
      className={className}
      data-pdf-fit="true"
      data-pdf-fit-overflow={fit.overflow ? "true" : "false"}
      data-pdf-fit-iterations={fit.iterations}
      style={{
        ...style,
        fontSize: `${fit.fontSize}px`,
        lineHeight: `${Math.max(fit.fontSize * 1.25, 10)}px`,
        overflow: fit.overflow ? "auto" : "visible",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {displayText}
    </article>
  );
}
