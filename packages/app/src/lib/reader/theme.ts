export type AppTheme = "light" | "dark" | "sepia" | "green";

export const THEME_COLORS: Record<AppTheme, { bg: string; fg: string; link: string }> = {
  light: { bg: "#ffffff", fg: "#1a1a1a", link: "#2563eb" },
  dark: { bg: "#121212", fg: "#f5f5f5", link: "#60a5fa" },
  sepia: { bg: "#f0e6d2", fg: "#3d2b1f", link: "#6b4c2a" },
  green: { bg: "#e3eedf", fg: "#24362a", link: "#2f6b45" },
};

export function getAppTheme(): AppTheme {
  if (typeof document === "undefined") return "dark";
  const theme = document.documentElement.getAttribute("data-theme") as AppTheme | null;
  return theme && THEME_COLORS[theme] ? theme : "dark";
}

export function getThemeColors(theme: AppTheme) {
  return THEME_COLORS[theme];
}

/** Colored themes belong to the workspace, not the PDF pixels. */
export const PDF_THEME_FILTERS: Partial<Record<AppTheme, string>> = {
  dark: "invert(0.93)",
};

// A ring and shadow distinguish the sheet without moving PDF text/annotation coordinates.
export const PDF_PAPER_SHADOW =
  "0 0 0 1px rgba(128,128,128,0.3), 0 3px 12px rgba(0,0,0,0.18)";

/** Only called for PDF documents, never reflowable EPUB content. */
export function applyPdfPaperSurface(doc: Document, theme: AppTheme) {
  const iframe = doc.defaultView?.frameElement as HTMLIFrameElement | null;
  if (!iframe) return;
  const background = theme === "dark" ? "#121212" : "#ffffff";
  iframe.style.filter = "";
  iframe.style.backgroundColor = background;
  // Override the fixed-layout renderer's general theme background, not its geometry.
  doc.documentElement.style.setProperty("background-color", background, "important");
  doc.body?.style.setProperty("background-color", background, "important");
  // The frame clips its iframe; put the shadow outside that clipping boundary.
  if (iframe.parentElement) iframe.parentElement.style.boxShadow = PDF_PAPER_SHADOW;
}

/**
 * Decide whether a PDF page is a "light text page" that should be theme-filtered
 * (inverted) in dark mode. Photo-heavy or already-dark
 * pages are left untouched so images don't turn into negatives.
 */
export function analyzeCanvasIsLight(canvas: HTMLCanvasElement): boolean {
  const size = 48;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  try {
    ctx.drawImage(canvas, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let light = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > 200) light++;
    }
    // A text page is predominantly light; downsampling washes thin text into
    // gray, so only rely on how much of the page is clearly light.
    return light / (size * size) > 0.55;
  } catch {
    return true;
  }
}
