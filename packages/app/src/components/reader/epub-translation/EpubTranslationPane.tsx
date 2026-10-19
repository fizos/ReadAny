import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Minus, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type EpubFidelityBlock,
  applyEpubTranslation,
  cloneEpubForPreview,
  collectEpubBlocks,
  serializeEpubPreview,
} from "./epub-dom";
import type { EpubExportState, EpubTranslationState } from "./useEpubTranslation";

export interface EpubTranslationPaneProps {
  state: EpubTranslationState;
  chapterTitle: string;
  providerLabel: string;
  providerModel: string;
  bookExport: EpubExportState;
  onVisible: (ids: string[]) => void;
  onPrev: () => void;
  onNext: () => void;
  onNavigate: (href: string) => void;
  onRetry: () => void;
  onCancel: () => void;
  onExit: () => void;
  onStartExport: () => void;
  onConfirmExport: () => void;
  onCancelExport: () => void;
}

export function EpubTranslationPane(props: EpubTranslationPaneProps) {
  const { state, bookExport } = props;
  const frame = useRef<HTMLIFrameElement>(null);
  const blocks = useRef<EpubFidelityBlock[]>([]);
  const applied = useRef(new Map<string, string>());
  const [loaded, setLoaded] = useState(0);
  const [zoom, setZoom] = useState(100);
  const propsRef = useRef(props);
  propsRef.current = props;
  const source = useMemo(
    () =>
      state.document
        ? serializeEpubPreview(cloneEpubForPreview(state.document), state.targetLang)
        : "",
    [state.document, state.targetLang],
  );

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    const win = frame.current?.contentWindow;
    if (!doc || !win || !loaded || !source) return;
    blocks.current = collectEpubBlocks(doc);
    applied.current.clear();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reportVisible = () => {
      const ids = blocks.current
        .filter((block) =>
          Array.from(block.element.getClientRects()).some(
            (rect) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.top < win.innerHeight &&
              rect.right > 0 &&
              rect.left < win.innerWidth,
          ),
        )
        .map((block) => block.id);
      propsRef.current.onVisible(ids);
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(reportVisible, 180);
    };
    const click = (event: MouseEvent) => {
      const element = (event.target as Element)?.closest?.("a[href]");
      const href = element?.getAttribute("href");
      if (!href) return;
      if (href.startsWith("#")) return;
      event.preventDefault();
      propsRef.current.onNavigate(href);
    };
    win.addEventListener("scroll", schedule, { passive: true });
    win.addEventListener("resize", schedule);
    doc.addEventListener("click", click);
    const observer = new ResizeObserver(schedule);
    if (doc.body) observer.observe(doc.body);
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      win.removeEventListener("scroll", schedule);
      win.removeEventListener("resize", schedule);
      doc.removeEventListener("click", click);
    };
  }, [loaded, source]);

  useEffect(() => {
    const win = frame.current?.contentWindow;
    if (!win || !loaded) return;
    const anchor = blocks.current.find((block) => {
      const rect = block.element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < win.innerHeight;
    });
    const before = anchor?.element.getBoundingClientRect().top;
    for (const block of blocks.current) {
      const translation = state.translations[block.id];
      if (!translation || applied.current.get(block.id) === translation) continue;
      if (applyEpubTranslation(block, translation)) {
        block.element.setAttribute("data-readany-translated", "true");
        applied.current.set(block.id, translation);
      }
    }
    if (anchor && before != null)
      win.scrollBy(0, anchor.element.getBoundingClientRect().top - before);
  }, [loaded, state.translations]);

  useEffect(() => {
    if (!loaded || !state.anchorId || state.anchorRevision < 1) return;
    const element = blocks.current.find((block) => block.id === state.anchorId)?.element;
    element?.scrollIntoView({ block: "start" });
  }, [loaded, state.anchorId, state.anchorRevision]);

  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!loaded || !doc?.body) return;
    // CSS zoom changes layout in the iframe, keeping selectable text sharp at every level.
    doc.body.style.setProperty("zoom", String(zoom / 100));
  }, [loaded, zoom]);

  const status =
    state.status === "extracting"
      ? "读取当前页面"
      : state.status === "processing"
        ? `翻译可见内容：${state.completed} / ${state.requested} 段`
        : state.status === "cancelled"
          ? "已暂停，已完成译文仍可阅读"
          : state.status === "error"
            ? state.error
            : state.requested
              ? `已翻译 ${state.completed} 段${state.cached ? ` · ${state.cached} 段来自缓存` : ""}`
              : "此处没有需要翻译的正文";
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="高保真 EPUB 译文"
    >
      <header className="flex shrink-0 items-start justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">高保真 EPUB 翻译</div>
          <div className="truncate text-xs text-muted-foreground">{props.chapterTitle}</div>
          <div className="truncate text-xs text-muted-foreground">
            {props.providerLabel} · {props.providerModel}
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={props.onExit} aria-label="退出 EPUB 翻译">
          <X className="h-4 w-4" />
        </Button>
      </header>
      <div
        className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1"
        role="toolbar"
        aria-label="EPUB 译文阅读控制"
      >
        <Button variant="ghost" size="icon" onClick={props.onPrev} aria-label="上一页">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={props.onNext} aria-label="下一页">
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={zoom <= 50}
          onClick={() => setZoom((value) => Math.max(50, value - 10))}
          aria-label="缩小译文"
        >
          <Minus className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setZoom(100)} aria-label="重置译文缩放">
          {zoom}%
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={zoom >= 250}
          onClick={() => setZoom((value) => Math.min(250, value + 10))}
          aria-label="放大译文"
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={props.onStartExport}
          disabled={bookExport.status === "processing"}
        >
          保存整本译文
        </Button>
      </div>
      <div className="shrink-0 border-b border-border/40 px-3 py-1.5 text-xs" aria-live="polite">
        <span className={state.status === "error" ? "text-destructive" : "text-muted-foreground"}>
          {status}
        </span>
        {state.status === "processing" && (
          <Button variant="ghost" size="sm" onClick={props.onCancel}>
            暂停
          </Button>
        )}
        {(state.status === "error" || state.status === "cancelled") && (
          <Button variant="ghost" size="sm" onClick={props.onRetry}>
            重试
          </Button>
        )}
      </div>
      {source && (
        <iframe
          ref={frame}
          key={state.chapterKey}
          title="保留原书样式的 EPUB 译文"
          sandbox="allow-same-origin"
          srcDoc={source}
          className="min-h-0 w-full flex-1 border-0"
          onLoad={() => setLoaded((value) => value + 1)}
        />
      )}
      <footer className="shrink-0 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
        按可见内容翻译；未处理的段落暂时显示原文。代码、图片和公式保持原样。
        {bookExport.status === "processing" && (
          <div className="mt-1">
            整本导出：{bookExport.current} / {bookExport.total} · {bookExport.label}
            <Button variant="ghost" size="sm" onClick={props.onCancelExport}>
              取消导出
            </Button>
          </div>
        )}
        {bookExport.status === "complete" && (
          <div className="mt-1">已保存：{bookExport.destination}</div>
        )}
        {bookExport.status === "error" && (
          <div className="mt-1 text-destructive">
            {bookExport.error}
            <Button variant="ghost" size="sm" onClick={props.onStartExport}>
              重试导出
            </Button>
          </div>
        )}
        {bookExport.status === "cancelled" && (
          <div className="mt-1">导出已取消，已完成的段落已缓存。</div>
        )}
      </footer>
      <Dialog
        open={bookExport.status === "confirming"}
        onOpenChange={(open) => {
          if (!open) props.onCancelExport();
        }}
      >
        <DialogContent layout="form">
          <DialogHeader>
            <DialogTitle>保存整本译文 EPUB</DialogTitle>
            <DialogDescription>
              复用已有缓存，并翻译其余章节、目录和脚注。保留原书样式、图片、字体、代码和链接。原文件不会被覆盖。
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-muted-foreground">
              将使用 {props.providerLabel} · {props.providerModel} 翻译为 {state.targetLang}
              。整本翻译会消耗模型额度，过程中可取消，之后重试会复用已完成段落。
            </p>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={props.onCancelExport}>
              取消
            </Button>
            <Button onClick={props.onConfirmExport}>选择位置并翻译保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
