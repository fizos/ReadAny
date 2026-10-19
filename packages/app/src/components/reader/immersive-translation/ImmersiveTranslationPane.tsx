import { Button } from "@/components/ui/button";
import { cn } from "@readany/core/utils";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { PdfTranslationAutoFit } from "./pdf-auto-fit";
import { calculatePdfBlockSlot } from "./pdf-geometry";
import type { PdfSourceBlock } from "./types";
import type { ImmersiveTranslationState } from "./useImmersiveTranslation";

interface ImmersiveTranslationPaneProps {
  state: ImmersiveTranslationState;
  onRetry: () => void;
  onExit: () => void;
}

function epubTextClass(tagName: string) {
  if (/^h[1-2]$/i.test(tagName)) return "text-xl font-semibold leading-tight";
  if (/^h[3-6]$/i.test(tagName)) return "text-base font-semibold leading-snug";
  if (tagName === "blockquote") return "border-l-2 border-border pl-3 text-muted-foreground";
  if (tagName === "pre") return "whitespace-pre-wrap font-mono text-xs";
  return "text-sm leading-7";
}

function stateMessage(state: ImmersiveTranslationState, t: ReturnType<typeof useTranslation>["t"]) {
  if (state.errorCode === "no-extractable-text") {
    return t(
      "translation.immersiveNoText",
      "This page or section has no extractable text. Scanned PDFs require OCR.",
    );
  }
  if (state.errorCode === "text-layer-timeout") {
    return t("translation.immersiveTextLayerTimeout", "The PDF text layer is not ready yet.");
  }
  return state.errorMessage || t("translation.immersiveFailed", "Translation failed.");
}

export function ImmersiveTranslationPane({
  state,
  onRetry,
  onExit,
}: ImmersiveTranslationPaneProps) {
  const { t } = useTranslation();
  const blocks = state.snapshot?.blocks ?? [];
  const pdfBlocks = useMemo(() => {
    if (state.snapshot?.kind !== "pdf") return null;
    return state.snapshot.blocks.filter((block): block is PdfSourceBlock => block.kind === "pdf");
  }, [state.snapshot]);
  const pdfPage = pdfBlocks?.[0] ?? null;
  const pdfPageRef = useRef<HTMLDivElement>(null);
  const progressPercent =
    state.progress.totalChars > 0
      ? Math.min(
          100,
          Math.round((state.progress.translatedChars / state.progress.totalChars) * 100),
        )
      : 0;

  return (
    <section
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      aria-label={t("translation.immersiveTranslation", "Immersive translation")}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="min-w-0">
          <span className="text-xs font-medium">
            {t("translation.translationLabel", "Translation")}
          </span>
          {state.status === "translating" && (
            <span className="ml-2 text-[11px] text-muted-foreground">{progressPercent}%</span>
          )}
          {state.status === "partial" && (
            <span className="ml-2 text-[11px] text-amber-600 dark:text-amber-400">
              {t("translation.immersivePartial", "Partially translated")}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onExit}
          title={t("translation.exitImmersive", "Exit immersive translation")}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </header>

      {state.status === "translating" && (
        <div className="h-0.5 shrink-0 bg-muted">
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-auto">
        {state.status === "extracting" && (
          <div className="space-y-3 p-5" aria-live="polite">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-4 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
          </div>
        )}

        {state.status === "error" && (
          <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-5 w-5 text-destructive" />
            <p className="max-w-sm text-sm text-muted-foreground">{stateMessage(state, t)}</p>
            {state.errorCode !== "no-extractable-text" && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t("common.retry", "Retry")}
              </Button>
            )}
          </div>
        )}

        {state.snapshot?.kind === "epub" && state.status !== "error" && (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-8">
            {blocks.map((block) => {
              const translated = state.results[block.id];
              return (
                <article
                  key={block.id}
                  className={cn(
                    epubTextClass(block.tagName),
                    block.contentKind === "code" && "whitespace-pre-wrap font-mono",
                  )}
                >
                  {block.contentKind === "code"
                    ? block.text
                    : translated || (
                        <span
                          className="block h-4 w-4/5 animate-pulse rounded bg-muted"
                          aria-hidden
                        />
                      )}
                </article>
              );
            })}
          </div>
        )}

        {state.snapshot?.kind === "pdf" && pdfPage && pdfBlocks && state.status !== "error" && (
          <div className="flex min-h-full items-start justify-center p-4">
            <div
              ref={pdfPageRef}
              data-pdf-translation-geometry="true"
              data-pdf-translation-page="true"
              className="relative w-full max-w-4xl border border-border/60 bg-white shadow-sm dark:bg-zinc-950"
              style={{
                aspectRatio: `${state.snapshot.pageWidth ?? pdfPage.pageWidth} / ${state.snapshot.pageHeight ?? pdfPage.pageHeight}`,
              }}
            >
              {pdfBlocks.map((block) => {
                const translated = state.results[block.id];
                const rect = block.rect;
                const slot = calculatePdfBlockSlot(block, pdfBlocks);
                const sourceText = block.sourceLines.join("\n");
                const headingLike =
                  block.spanning && block.contentKind === "prose" && block.text.length <= 80;
                return (
                  <PdfTranslationAutoFit
                    key={block.id}
                    pageRef={pdfPageRef}
                    sourceRectHeight={rect.height}
                    sourceLineCount={Math.max(1, block.sourceLines.length)}
                    sourceText={sourceText}
                    translatedText={translated}
                    code={block.contentKind === "code"}
                    className={cn(
                      "absolute box-border text-zinc-900 dark:text-zinc-100",
                      headingLike && "text-center font-semibold",
                      block.contentKind === "code" && "font-mono",
                      block.contentKind === "prose" &&
                        !translated &&
                        "animate-pulse rounded-sm bg-zinc-100 dark:bg-zinc-800",
                    )}
                    style={{
                      left: `${rect.left * 100}%`,
                      top: `${rect.top * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${slot.height * 100}%`,
                    }}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      {state.status === "partial" && (
        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {t("translation.immersivePartialHint", "Some text could not be translated.")}
          </span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            {t("common.retry", "Retry")}
          </Button>
        </footer>
      )}
    </section>
  );
}
