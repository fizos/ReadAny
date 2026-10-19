import { Button } from "@/components/ui/button";
import {
  PDF_PAPER_SHADOW,
  PDF_THEME_FILTERS,
  analyzeCanvasIsLight,
  getAppTheme,
} from "@/lib/reader/theme";
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFPageProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  HighFidelityPdfState,
  PdfBookExportState,
  PdfPrefetchState,
} from "./high-fidelity-pdf";
import {
  type PdfZoomMode,
  getPdfDisplayScale,
  getPdfRasterScale,
  stepPdfZoomPercent,
} from "./pdf-zoom";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfZoomSelection {
  mode: PdfZoomMode;
  manualPercent: number;
}

interface HighFidelityPdfDocumentProps {
  base64: string;
  zoom: PdfZoomSelection;
  onEffectiveScaleChange: (scale: number) => void;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isCancellation(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "RenderingCancelledException";
}

/** Render one native PDF artifact. Zoom and resize only rerender the loaded page. */
function HighFidelityPdfDocument({
  base64,
  zoom,
  onEffectiveScaleChange,
}: HighFidelityPdfDocumentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const teardownRef = useRef<Promise<void>>(Promise.resolve());
  const pageRef = useRef<PDFPageProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const renderSequenceRef = useRef(0);
  const artifactSequenceRef = useRef(0);
  const resizeFrameRef = useRef<number | null>(null);
  const zoomRef = useRef(zoom);
  const onScaleRef = useRef(onEffectiveScaleChange);
  const reportedScaleRef = useRef<number | null>(null);
  const [paperSize, setPaperSize] = useState({ width: 0, height: 0 });
  const [error, setError] = useState<string | null>(null);
  const lightPageRef = useRef<boolean | null>(null);

  zoomRef.current = zoom;
  onScaleRef.current = onEffectiveScaleChange;

  const reportScale = useCallback((scale: number) => {
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (reportedScaleRef.current !== null && Math.abs(reportedScaleRef.current - scale) < 0.0001)
      return;
    reportedScaleRef.current = scale;
    onScaleRef.current(scale);
  }, []);

  const cancelRenderImmediately = useCallback(() => {
    renderTaskRef.current?.cancel();
  }, []);

  const scheduleRender = useCallback(() => {
    const sequence = ++renderSequenceRef.current;
    // Cancel synchronously so a slow render cannot continue while a new
    // zoom/resize request is waiting in the serialized queue.
    cancelRenderImmediately();
    renderQueueRef.current = renderQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const page = pageRef.current;
        if (
          !container ||
          !canvas ||
          !page ||
          container.clientWidth <= 0 ||
          container.clientHeight <= 0
        )
          return;
        if (sequence !== renderSequenceRef.current) return;

        const previousTask = renderTaskRef.current;
        if (previousTask) {
          renderTaskRef.current = null;
          previousTask.cancel();
          try {
            await previousTask.promise;
          } catch {
            // Cancellation is expected before responsive/zoom rerenders.
          }
        }
        if (sequence !== renderSequenceRef.current || page !== pageRef.current) return;

        try {
          const baseViewport = page.getViewport({ scale: 1 });
          const displayScale = getPdfDisplayScale({
            mode: zoomRef.current.mode,
            manualPercent: zoomRef.current.manualPercent,
            pageWidth: baseViewport.width,
            pageHeight: baseViewport.height,
            viewportWidth: container.clientWidth,
            viewportHeight: container.clientHeight,
            padding: 24,
          });
          const rasterScale = getPdfRasterScale({
            displayScale,
            devicePixelRatio: typeof window === "undefined" ? 1 : window.devicePixelRatio,
            pageWidth: baseViewport.width,
            pageHeight: baseViewport.height,
          });
          const cssWidth = Math.max(1, Math.ceil(baseViewport.width * displayScale));
          const cssHeight = Math.max(1, Math.ceil(baseViewport.height * displayScale));
          const renderViewport = page.getViewport({ scale: displayScale * rasterScale });
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas is unavailable");

          setPaperSize((previous) =>
            previous.width === cssWidth && previous.height === cssHeight
              ? previous
              : { width: cssWidth, height: cssHeight },
          );
          canvas.width = Math.max(1, Math.floor(renderViewport.width));
          canvas.height = Math.max(1, Math.floor(renderViewport.height));
          canvas.dataset.rendered = "false";
          canvas.style.width = `${cssWidth}px`;
          canvas.style.height = `${cssHeight}px`;
          canvas.style.maxWidth = "none";
          canvas.style.maxHeight = "none";
          setError(null);
          reportScale(displayScale);
          const renderTask = page.render({
            canvas,
            canvasContext: context,
            viewport: renderViewport,
          });
          renderTaskRef.current = renderTask;
          await renderTask.promise;
          if (sequence !== renderSequenceRef.current || page !== pageRef.current) return;
          canvas.dataset.rendered = "true";
          lightPageRef.current = analyzeCanvasIsLight(canvas);
          canvas.style.filter = lightPageRef.current
            ? PDF_THEME_FILTERS[getAppTheme()] || "none"
            : "none";
        } catch (renderError) {
          if (sequence !== renderSequenceRef.current || isCancellation(renderError)) return;
          setError(renderError instanceof Error ? renderError.message : "无法绘制译文 PDF");
        }
      });
    return renderQueueRef.current;
  }, [cancelRenderImmediately, reportScale]);

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const applyTheme = () => {
      const canvas = canvasRef.current;
      if (canvas && lightPageRef.current)
        canvas.style.filter = PDF_THEME_FILTERS[getAppTheme()] || "none";
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    applyTheme();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const requestAfterFrame = () => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        if (container.clientWidth > 0 && container.clientHeight > 0) void scheduleRender();
      });
    };
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(requestAfterFrame);
      observer.observe(container);
      return () => {
        observer.disconnect();
        if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      };
    }
    return undefined;
  }, [scheduleRender]);

  useEffect(() => {
    void scheduleRender();
  }, [scheduleRender, zoom.mode, zoom.manualPercent]);

  useEffect(() => {
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    const artifactSequence = ++artifactSequenceRef.current;
    ++renderSequenceRef.current;
    setError(null);
    setPaperSize({ width: 0, height: 0 });
    reportedScaleRef.current = null;
    pageRef.current = null;
    renderTaskRef.current?.cancel();
    lightPageRef.current = null;
    if (canvasRef.current) {
      canvasRef.current.style.filter = "none";
      canvasRef.current.dataset.rendered = "false";
    }
    if (containerRef.current) containerRef.current.scrollTo(0, 0);
    const previousTeardown = teardownRef.current;

    const load = async () => {
      try {
        await previousTeardown;
        if (disposed) return;
        loadingTask = pdfjsLib.getDocument({ data: decodeBase64(base64) });
        const document = await loadingTask.promise;
        if (disposed || artifactSequence !== artifactSequenceRef.current) {
          return;
        }
        const page = await document.getPage(1);
        if (disposed || artifactSequence !== artifactSequenceRef.current) {
          return;
        }
        pageRef.current = page;
        void scheduleRender();
      } catch (loadError) {
        if (!disposed && artifactSequence === artifactSequenceRef.current) {
          setError(loadError instanceof Error ? loadError.message : "无法加载译文 PDF");
        }
      }
    };
    void load();

    return () => {
      disposed = true;
      ++artifactSequenceRef.current;
      ++renderSequenceRef.current;
      renderTaskRef.current?.cancel();
      pageRef.current = null;
      // A loading task owns its document and worker. Destroy once, only after
      // cancelled canvas work settles; the next artifact waits for this cleanup.
      teardownRef.current = renderQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          await previousTeardown;
          if (loadingTask) await loadingTask.destroy();
        })
        .catch(() => undefined);
    };
  }, [base64, scheduleRender]);

  const paperStyle =
    paperSize.width > 0
      ? { width: `${paperSize.width}px`, height: `${paperSize.height}px` }
      : undefined;

  return (
    <div
      ref={containerRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-muted/20 p-3"
    >
      <div className="flex min-h-full w-max min-w-full">
        <div
          className="m-auto shrink-0 bg-white"
          style={{ ...paperStyle, boxShadow: PDF_PAPER_SHADOW }}
        >
          <canvas
            ref={canvasRef}
            className="block max-h-none max-w-none"
            style={{ backgroundColor: "#ffffff" }}
          />
        </div>
      </div>
      {error && (
        <p
          className="pointer-events-none absolute left-1/2 top-3 max-w-sm -translate-x-1/2 bg-background/90 p-2 text-center text-xs text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}

function elapsedLabel(startedAt: number | null): string {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `已用 ${seconds} 秒`;
  return `已用 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

interface HighFidelityPdfPaneProps {
  state: HighFidelityPdfState;
  currentPage: number;
  totalPages: number | null;
  canGoPrev: boolean;
  canGoNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  providerLabel: string;
  providerModel: string;
  usesActiveAiEndpoint?: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onExit: () => void;
  prefetch: PdfPrefetchState;
  bookExport: PdfBookExportState;
  onStartExport: () => void;
  onConfirmExport: () => void;
  onCancelExport: () => void;
}

export function HighFidelityPdfPane({
  state,
  currentPage,
  totalPages,
  canGoPrev,
  canGoNext,
  onPrev,
  onNext,
  providerLabel,
  providerModel,
  usesActiveAiEndpoint = false,
  onInstall,
  onCancel,
  onRetry,
  onExit,
  prefetch,
  bookExport,
  onStartExport,
  onConfirmExport,
  onCancelExport,
}: HighFidelityPdfPaneProps) {
  const { t } = useTranslation();
  const [, setClock] = useState(0);
  const [zoom, setZoom] = useState<PdfZoomSelection>({ mode: "fit-page", manualPercent: 100 });
  const [effectiveScale, setEffectiveScale] = useState<number | null>(null);
  const pageLabel =
    currentPage > 0 ? `第 ${currentPage} 页${totalPages ? ` / ${totalPages}` : ""}` : "当前页";
  const busy = state.status === "installing" || state.status === "translating";
  const provider = state.provider || {
    profileLabel: providerLabel,
    model: providerModel,
    usesActiveAiEndpoint,
  };
  const sourceLabel = provider.usesActiveAiEndpoint ? "AI 对话设置" : "AI 翻译设置";
  const details = state.progress;
  const progressCurrent = Number.isFinite(details?.current) ? (details?.current ?? 0) : null;
  const progressTotal = Number.isFinite(details?.total) ? (details?.total ?? 0) : null;
  const stageLabels: Record<string, string> = {
    layout: "识别页面布局",
    paragraphs: "整理段落",
    translate: "翻译段落",
    typeset: "还原排版",
    fonts: "处理字体",
    save: "写入译文 PDF",
    parse: "解析 PDF",
    extract: "提取页面内容",
    drawing: "绘制译文页面",
    fontmap: "匹配字体",
    scan: "检查文字层",
    table: "识别表格",
    formulas: "识别公式与样式",
    baseline: "调整文字基线",
    subset: "精简嵌入字体",
  };
  const hasStageProgress =
    progressCurrent !== null &&
    progressTotal !== null &&
    progressTotal > 0 &&
    progressCurrent >= 0 &&
    progressCurrent <= progressTotal;

  useEffect(() => {
    if (!busy || !state.startedAt) return;
    const timer = window.setInterval(() => setClock((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, state.startedAt]);

  useEffect(() => setEffectiveScale(null), [state.pdfBase64, currentPage]);
  const handleScaleChange = useCallback((scale: number) => {
    setEffectiveScale((previous) =>
      previous !== null && Math.abs(previous - scale) < 0.0001 ? previous : scale,
    );
  }, []);
  const actualZoomLabel = effectiveScale ? `${Math.round(effectiveScale * 100)}%` : "—";
  const controlPercent = zoom.mode === "manual" ? zoom.manualPercent : (effectiveScale ?? 1) * 100;
  const changeZoom = (direction: -1 | 1) => {
    if (direction < 0 ? controlPercent <= 25 : controlPercent >= 400) return;
    setZoom((previous) => ({
      mode: "manual",
      manualPercent: stepPdfZoomPercent(
        previous.mode === "manual"
          ? previous.manualPercent
          : effectiveScale
            ? Math.round(effectiveScale * 100)
            : previous.manualPercent,
        direction,
      ),
    }));
  };
  const phase = state.phase || "starting";
  const phaseLabel: Record<string, string> = {
    starting: "准备中",
    context: "准备本书翻译档案",
    preparing: "准备运行时",
    installing: "校验并初始化本地依赖",
    assets: "准备本地字体与模型",
    extracting: "提取页面内容",
    layout: "分析页面布局",
    translating: "翻译文本",
    typesetting: "还原排版",
    saving: "保存结果",
    cache: "读取缓存",
    complete: "已完成",
    cancelled: "已取消",
    error: "失败",
  };
  const prefetchLabel =
    prefetch.status === "processing"
      ? `第 ${prefetch.page} 页预翻译中`
      : prefetch.status === "ready"
        ? `第 ${prefetch.page} 页已预翻译`
        : prefetch.status === "error"
          ? `第 ${prefetch.page} 页预翻译失败`
          : null;
  const exportBusy = bookExport.status === "planning" || bookExport.status === "exporting";

  return (
    <section
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      aria-label="高保真 PDF 翻译"
    >
      <header className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium">高保真 PDF 翻译（实验）</div>
          <div className="text-[11px] text-muted-foreground">
            {pageLabel}
            {state.cached ? " · 已使用缓存" : ""}
          </div>
          <div className="break-all text-[11px] text-muted-foreground">
            {provider.profileLabel} · {provider.model || "未选择模型"} · {sourceLabel}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onExit}
          title="退出高保真 PDF 翻译"
          aria-label="退出高保真 PDF 翻译"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      {bookExport.status !== "idle" && (
        <div className="shrink-0 border-b border-border/60 bg-muted/20 px-3 py-2 text-xs">
          {bookExport.status === "planning" && (
            <output>正在扫描缓存与页面文字层，不会调用 AI…</output>
          )}
          {bookExport.status === "confirming" && bookExport.plan && (
            <div className="space-y-2">
              <p className="font-medium">确认翻译并保存整本 PDF</p>
              <p className="leading-5 text-muted-foreground">
                共 {bookExport.plan.totalPages} 页；可复用缓存 {bookExport.plan.cachedPages} 页，
                还需调用 AI 翻译 {bookExport.plan.missingPages} 页，无文字层原样保留{" "}
                {bookExport.plan.nonTextPages} 页。
              </p>
              <p className="break-all text-muted-foreground">
                保存到：{bookExport.destinationPath}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={onConfirmExport}>
                  开始整本翻译
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelExport}>
                  取消
                </Button>
              </div>
            </div>
          )}
          {bookExport.status === "exporting" && (
            <div className="space-y-2">
              <output className="block">
                正在生成整本译文：第 {bookExport.current || 0} /{" "}
                {bookExport.total || bookExport.plan?.totalPages || "—"} 页
              </output>
              {!!bookExport.total && (
                <div
                  className="h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label="整本译文进度"
                  aria-valuemin={0}
                  aria-valuemax={bookExport.total}
                  aria-valuenow={bookExport.current || 0}
                  tabIndex={0}
                >
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width: `${Math.min(100, (100 * (bookExport.current || 0)) / bookExport.total)}%`,
                    }}
                  />
                </div>
              )}
              <Button size="sm" variant="outline" onClick={onCancelExport}>
                <X className="mr-2 h-3.5 w-3.5" />
                取消整本翻译
              </Button>
            </div>
          )}
          {bookExport.status === "complete" && (
            <div className="flex items-start gap-2 text-muted-foreground">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <p className="break-all">整本译文已保存：{bookExport.destinationPath}</p>
            </div>
          )}
          {(bookExport.status === "error" || bookExport.status === "cancelled") && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p
                className={
                  bookExport.status === "error" ? "text-destructive" : "text-muted-foreground"
                }
              >
                {bookExport.status === "error"
                  ? bookExport.error || "整本导出失败"
                  : "已取消整本翻译"}
              </p>
              <Button size="sm" variant="ghost" onClick={onStartExport}>
                重新选择保存位置
              </Button>
            </div>
          )}
        </div>
      )}

      {state.status === "needs-setup" && (
        <div className="flex min-h-0 flex-1 flex-col justify-center gap-4 overflow-auto p-5">
          <div>
            <h2 className="text-sm font-medium">首次使用需要初始化本地 PDF 引擎</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              完整版已包含依赖、字体和模型，初始化无需联网，额外约需 1.2GB 磁盘空间。
              翻译时仍需连接下方配置的 AI 接口。
            </p>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              扫描件不提供 OCR，复杂列表和表格的还原可能与原文不同。
            </p>
          </div>
          <Button onClick={onInstall} className="w-fit">
            初始化引擎并翻译当前页
          </Button>
        </div>
      )}

      {busy && (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5" aria-busy="true">
          <div>
            <output className="block text-sm font-medium">
              {(details?.stage && stageLabels[details.stage]) || phaseLabel[phase] || "处理中"}
            </output>
            <p className="mt-2 text-xs text-muted-foreground">
              {state.status === "installing"
                ? "正在从安装包的本地资源准备引擎，无需下载。"
                : `${pageLabel}正在处理。`}
              {state.startedAt ? ` ${elapsedLabel(state.startedAt)}` : ""}
            </p>
            {hasStageProgress && (
              <p className="mt-2 text-xs text-muted-foreground">
                本阶段已完成 {progressCurrent} / {progressTotal} 项
              </p>
            )}
            {!!details?.requestsStarted && (
              <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                <p>
                  AI 请求：已完成 {details.requestsCompleted || 0} 次，处理中{" "}
                  {Math.max(0, details.requestsStarted - (details.requestsCompleted || 0))} 次
                </p>
                <p>
                  {details.receivedBytes
                    ? `已接收 ${(details.receivedBytes / 1024).toFixed(1)} KiB 响应（含推理与协议数据）`
                    : "等待 AI 接口返回数据"}
                </p>
              </div>
            )}
          </div>
          {hasStageProgress && (
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label="当前阶段进度（非整页总进度）"
              aria-valuemin={0}
              aria-valuemax={progressTotal || 0}
              aria-valuenow={progressCurrent || 0}
              tabIndex={0}
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${(100 * (progressCurrent || 0)) / (progressTotal || 1)}%` }}
              />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onCancel} className="w-fit">
            <X className="mr-2 h-3.5 w-3.5" />
            取消
          </Button>
        </div>
      )}

      {state.status === "complete" && state.pdfBase64 && (
        <>
          <div
            className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1"
            role="toolbar"
            aria-label="PDF 缩放"
          >
            <Button
              variant={zoom.mode === "fit-page" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setZoom((value) => ({ ...value, mode: "fit-page" }))}
              aria-label="适合页面"
              title="适合页面"
            >
              适合页面
            </Button>
            <Button
              variant={zoom.mode === "fit-width" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setZoom((value) => ({ ...value, mode: "fit-width" }))}
              aria-label="适合宽度"
              title="适合宽度"
            >
              适合宽度
            </Button>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeZoom(-1)}
              disabled={controlPercent <= 25}
              aria-label="缩小 25%"
              title="缩小 25%"
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums" aria-live="polite">
              {actualZoomLabel}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => changeZoom(1)}
              disabled={controlPercent >= 400}
              aria-label="放大 25%"
              title="放大 25%"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setZoom({ mode: "manual", manualPercent: 100 })}
              aria-label="缩放到 100%"
              title="缩放到 100%"
            >
              100%
            </Button>
          </div>
          <HighFidelityPdfDocument
            key={currentPage}
            base64={state.pdfBase64}
            zoom={zoom}
            onEffectiveScaleChange={handleScaleChange}
          />
        </>
      )}

      {(state.status === "error" || state.status === "cancelled") && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center">
          <AlertCircle
            className={
              state.status === "error"
                ? "h-5 w-5 text-destructive"
                : "h-5 w-5 text-muted-foreground"
            }
          />
          <p className="max-w-sm text-sm text-muted-foreground">
            {state.status === "cancelled" ? "已取消当前页翻译。" : state.error || "PDF 翻译失败。"}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              {t("common.retry", "重试")}
            </Button>
            <Button variant="ghost" size="sm" onClick={onExit}>
              退出
            </Button>
          </div>
        </div>
      )}

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/60 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPrev}
            disabled={!canGoPrev}
            aria-label="上一页"
            title="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <span className="min-w-20 text-center text-[11px] text-muted-foreground">
            {pageLabel}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNext}
            disabled={!canGoNext}
            aria-label="下一页"
            title="下一页"
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        {state.status === "complete" && (
          <div className="flex flex-wrap items-center justify-end gap-1">
            {prefetchLabel && (
              <output className="mr-1 text-[11px] text-muted-foreground">{prefetchLabel}</output>
            )}
            <Button variant="ghost" size="sm" onClick={onStartExport} disabled={exportBusy}>
              <Download className="mr-2 h-3.5 w-3.5" />
              保存整本译文
            </Button>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
              重试
            </Button>
            <Button variant="ghost" size="sm" onClick={onExit}>
              <X className="mr-2 h-3.5 w-3.5" />
              退出
            </Button>
          </div>
        )}
      </footer>
    </section>
  );
}
