import { useTranslator } from "@/hooks/useTranslator";
/**
 * TranslationPopover — compact floating popover for translation
 * Robust positioning: always stays within viewport
 */
import { useSettingsStore } from "@/stores/settings-store";
import {
  TRANSLATOR_LANGS,
  TRANSLATOR_PROVIDERS,
  type TranslationTargetLang,
  type TranslatorName,
} from "@readany/core/types/translation";
import {
  Check,
  ChevronDown,
  Copy,
  GripHorizontal,
  Languages,
  Loader2,
  Scaling,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

interface TranslationPopoverProps {
  text: string;
  position: { x: number; y: number };
  onClose: () => void;
}

const POPOVER_WIDTH = 288; // w-72 = 18rem = 288px
const POPOVER_MIN_HEIGHT = 100; // header + content min height
const POPOVER_MAX_HEIGHT = 200; // max total height
const POPOVER_MIN_WIDTH = 240;
const POPOVER_RESIZE_MIN_HEIGHT = 120;
const PADDING = 16;
const GAP = 8;

interface ResizeRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ResizeSession extends ResizeRect {
  pointerId: number;
  startX: number;
  startY: number;
  previousUserSelect: string;
  previousCursor: string;
}

type MoveSession = ResizeSession;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const clampResizeRect = (rect: ResizeRect): ResizeRect => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableWidth = Math.max(0, viewportWidth - PADDING * 2);
  const availableHeight = Math.max(0, viewportHeight - PADDING * 2);
  const minWidth = Math.min(POPOVER_MIN_WIDTH, availableWidth);
  const minHeight = Math.min(POPOVER_RESIZE_MIN_HEIGHT, availableHeight);
  const left = clamp(rect.left, PADDING, Math.max(PADDING, viewportWidth - PADDING - minWidth));
  const top = clamp(rect.top, PADDING, Math.max(PADDING, viewportHeight - PADDING - minHeight));
  const maxWidth = Math.max(minWidth, viewportWidth - PADDING - left);
  const maxHeight = Math.max(minHeight, viewportHeight - PADDING - top);

  return {
    left,
    top,
    width: clamp(rect.width, minWidth, maxWidth),
    height: clamp(rect.height, minHeight, maxHeight),
  };
};

const clampMoveRect = (rect: ResizeRect): ResizeRect => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableWidth = Math.max(0, viewportWidth - PADDING * 2);
  const availableHeight = Math.max(0, viewportHeight - PADDING * 2);
  const width = clamp(rect.width, Math.min(1, availableWidth), availableWidth);
  const height = clamp(rect.height, Math.min(1, availableHeight), availableHeight);

  return {
    left: clamp(rect.left, PADDING, Math.max(PADDING, viewportWidth - PADDING - width)),
    top: clamp(rect.top, PADDING, Math.max(PADDING, viewportHeight - PADDING - height)),
    width,
    height,
  };
};

export function TranslationPopover({ text, position, onClose }: TranslationPopoverProps) {
  const { t } = useTranslation();
  const translationConfig = useSettingsStore((s) => s.translationConfig);
  const updateTranslationConfig = useSettingsStore((s) => s.updateTranslationConfig);

  // Local state
  const [targetLang, setTargetLang] = useState<TranslationTargetLang>(translationConfig.targetLang);
  const [translation, setTranslation] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerRevision, setProviderRevision] = useState(0);
  const translationRequestKey = `${targetLang}:${providerRevision}`;

  const { translate, loading, error, provider } = useTranslator({ targetLang });

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const providerRef = useRef<HTMLDivElement>(null);
  const moveHandleRef = useRef<HTMLButtonElement>(null);
  const resizeGripRef = useRef<HTMLButtonElement>(null);
  const moveSessionRef = useRef<MoveSession | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const explicitRectRef = useRef<ResizeRect | null>(null);

  // Calculate safe position that stays within viewport
  const calculatePosition = useCallback(() => {
    const popoverHeight = Math.min(
      containerRef.current?.offsetHeight || POPOVER_MIN_HEIGHT,
      POPOVER_MAX_HEIGHT,
    );
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Calculate X: center on selection point, but clamp to viewport
    let x = position.x;
    const halfWidth = POPOVER_WIDTH / 2;

    // Clamp left edge
    if (x - halfWidth < PADDING) {
      x = halfWidth + PADDING;
    }
    // Clamp right edge
    if (x + halfWidth > viewportWidth - PADDING) {
      x = viewportWidth - halfWidth - PADDING;
    }

    // Calculate Y: prefer above selection, fallback to below
    const spaceAbove = position.y - GAP;
    const spaceBelow = viewportHeight - position.y - GAP;

    let y: number;
    let showAbove: boolean;

    if (spaceAbove >= popoverHeight) {
      // Enough space above - show above
      y = position.y - GAP;
      showAbove = true;
    } else if (spaceBelow >= popoverHeight) {
      // Not enough above, but enough below - show below
      y = position.y + GAP;
      showAbove = false;
    } else {
      // Not enough space either way - use the side with more space
      if (spaceAbove > spaceBelow) {
        y = PADDING + popoverHeight;
        showAbove = true;
      } else {
        y = position.y + GAP;
        // Clamp to bottom
        y = Math.min(y, viewportHeight - popoverHeight - PADDING);
        showAbove = false;
      }
    }

    return { x, y, showAbove };
  }, [position]);

  const [pos, setPos] = useState(() => calculatePosition());
  const [explicitRect, setExplicitRect] = useState<ResizeRect | null>(null);

  const restoreResizeEnvironment = useCallback(() => {
    const session = resizeSessionRef.current;
    if (!session) return;

    if (resizeGripRef.current?.hasPointerCapture(session.pointerId)) {
      try {
        resizeGripRef.current.releasePointerCapture(session.pointerId);
      } catch {
        // The pointer capture may already have been released by the browser.
      }
    }
    document.body.style.userSelect = session.previousUserSelect;
    document.body.style.cursor = session.previousCursor;
    resizeSessionRef.current = null;
  }, []);

  const restoreMoveEnvironment = useCallback(() => {
    const session = moveSessionRef.current;
    if (!session) return;

    if (moveHandleRef.current?.hasPointerCapture(session.pointerId)) {
      try {
        moveHandleRef.current.releasePointerCapture(session.pointerId);
      } catch {
        // The pointer capture may already have been released by the browser.
      }
    }
    document.body.style.userSelect = session.previousUserSelect;
    document.body.style.cursor = session.previousCursor;
    moveSessionRef.current = null;
  }, []);

  useEffect(
    () => () => {
      restoreMoveEnvironment();
      restoreResizeEnvironment();
    },
    [restoreMoveEnvironment, restoreResizeEnvironment],
  );

  // Update position when content changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: content height changes after loading/translation updates.
  useEffect(() => {
    if (!explicitRect) setPos(calculatePosition());
  }, [calculatePosition, explicitRect, translation, loading]);

  // Update position on resize
  useEffect(() => {
    const handleResize = () => {
      if (explicitRectRef.current) {
        const nextRect = clampMoveRect(explicitRectRef.current);
        explicitRectRef.current = nextRect;
        setExplicitRect(nextRect);
        return;
      }
      setPos(calculatePosition());
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [calculatePosition]);

  // Click outside to close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Fetch translation
  useEffect(() => {
    void translationRequestKey;
    let cancelled = false;
    setTranslation(null);

    const fetch = async () => {
      try {
        const input = text.split("\n").join(" ").trim();
        const results = await translate([input]);
        if (!cancelled && results[0]) {
          setTranslation(results[0]);
        }
      } catch (err) {
        console.error("Translation error:", err);
      }
    };

    fetch();
    return () => {
      cancelled = true;
    };
  }, [text, translationRequestKey, translate]);

  const handleLangChange = (lang: TranslationTargetLang) => {
    setTargetLang(lang);
    updateTranslationConfig({ targetLang: lang });
    setLangOpen(false);
  };

  const handleProviderChange = (providerId: TranslatorName, providerName: string) => {
    updateTranslationConfig({
      provider: {
        ...translationConfig.provider,
        id: providerId,
        name: providerName,
      },
    });
    setProviderRevision((revision) => revision + 1);
    setProviderOpen(false);
  };

  const handleCopy = async () => {
    if (translation) {
      await navigator.clipboard.writeText(translation);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const materializeRect = useCallback((interaction: "move" | "resize"): ResizeRect | null => {
    if (explicitRectRef.current) return explicitRectRef.current;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return null;

    const boundsRect = {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    };
    const rect = interaction === "move" ? clampMoveRect(boundsRect) : clampResizeRect(boundsRect);
    explicitRectRef.current = rect;
    setExplicitRect(rect);
    return rect;
  }, []);

  const commitResizeRect = useCallback((rect: ResizeRect) => {
    explicitRectRef.current = rect;
    setExplicitRect(rect);
  }, []);

  const handleMovePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    restoreResizeEnvironment();
    const rect = materializeRect("move");
    if (!rect) return;

    setLangOpen(false);
    setProviderOpen(false);
    moveSessionRef.current = {
      ...rect,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      previousUserSelect: document.body.style.userSelect,
      previousCursor: document.body.style.cursor,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "move";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      restoreMoveEnvironment();
    }
  };

  const handleMovePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = moveSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();

    commitResizeRect(
      clampMoveRect({
        left: session.left + event.clientX - session.startX,
        top: session.top + event.clientY - session.startY,
        width: session.width,
        height: session.height,
      }),
    );
  };

  const handleMovePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (moveSessionRef.current?.pointerId !== event.pointerId) return;
    restoreMoveEnvironment();
  };

  const handleMoveKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 32 : 10;
    const delta = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    }[event.key];
    if (!delta) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = materializeRect("move");
    if (!rect) return;
    commitResizeRect(
      clampMoveRect({
        ...rect,
        left: rect.left + delta.x,
        top: rect.top + delta.y,
      }),
    );
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    restoreMoveEnvironment();
    const rect = materializeRect("resize");
    if (!rect) return;

    resizeSessionRef.current = {
      ...rect,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      previousUserSelect: document.body.style.userSelect,
      previousCursor: document.body.style.cursor,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "se-resize";
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      restoreResizeEnvironment();
    }
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const session = resizeSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();

    commitResizeRect(
      clampResizeRect({
        left: session.left,
        top: session.top,
        width: session.width + event.clientX - session.startX,
        height: session.height + event.clientY - session.startY,
      }),
    );
  };

  const handleResizePointerEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeSessionRef.current?.pointerId !== event.pointerId) return;
    restoreResizeEnvironment();
  };

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 32 : 10;
    const delta = {
      ArrowLeft: { width: -step, height: 0 },
      ArrowRight: { width: step, height: 0 },
      ArrowUp: { width: 0, height: -step },
      ArrowDown: { width: 0, height: step },
    }[event.key];
    if (!delta) return;

    event.preventDefault();
    event.stopPropagation();
    const rect = materializeRect("resize");
    if (!rect) return;
    commitResizeRect(
      clampResizeRect({
        ...rect,
        width: rect.width + delta.width,
        height: rect.height + delta.height,
      }),
    );
  };

  // Get provider display name
  const aiConfig = useSettingsStore((s) => s.aiConfig);
  const endpointId = translationConfig.provider.endpointId || aiConfig.activeEndpointId;
  const endpoint = aiConfig.endpoints.find((e) => e.id === endpointId);
  const providerLabel = TRANSLATOR_PROVIDERS.find((p) => p.id === provider);
  const providerName =
    provider === "ai"
      ? endpoint?.name || "AI"
      : providerLabel
        ? t(providerLabel.labelKey)
        : translationConfig.provider.name;

  return (
    <div
      ref={containerRef}
      className="fixed z-50 flex min-h-0 flex-col"
      style={{
        width: explicitRect?.width ?? POPOVER_WIDTH,
        height: explicitRect?.height,
        maxHeight: explicitRect ? undefined : POPOVER_MAX_HEIGHT,
        left: explicitRect?.left ?? pos.x,
        top: explicitRect?.top ?? pos.y,
        transform: explicitRect
          ? "none"
          : pos.showAbove
            ? "translate(-50%, -100%)"
            : "translate(-50%, 0)",
      }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg">
        {/* Header: Language selector + Close */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative" ref={langRef}>
              <button
                type="button"
                onClick={() => {
                  setProviderOpen(false);
                  setLangOpen(!langOpen);
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Languages className="h-3.5 w-3.5" />
                <span>{TRANSLATOR_LANGS[targetLang]}</span>
                <ChevronDown className="h-3 w-3" />
              </button>

              {langOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-36 rounded-md border bg-background p-1 shadow-lg">
                  <div className="max-h-48 overflow-y-auto">
                    {Object.entries(TRANSLATOR_LANGS).map(([code, name]) => (
                      <button
                        key={code}
                        type="button"
                        onClick={() => handleLangChange(code as TranslationTargetLang)}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs ${
                          code === targetLang ? "bg-primary/10 text-primary" : "hover:bg-muted"
                        }`}
                      >
                        <span>{name}</span>
                        {code === targetLang && <Check className="h-3 w-3" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative min-w-0" ref={providerRef}>
              <button
                type="button"
                onClick={() => {
                  setLangOpen(false);
                  setProviderOpen(!providerOpen);
                }}
                className="flex max-w-28 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title={providerName}
              >
                <span className="truncate">{providerName}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </button>

              {providerOpen && (
                <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-md border bg-background p-1 shadow-lg">
                  {TRANSLATOR_PROVIDERS.map((p) => {
                    const label = t(p.labelKey);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleProviderChange(p.id, label)}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1 text-left text-xs ${
                          p.id === translationConfig.provider.id
                            ? "bg-primary/10 text-primary"
                            : "hover:bg-muted"
                        }`}
                      >
                        <span className="truncate">{label}</span>
                        {p.id === translationConfig.provider.id && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <button
            ref={moveHandleRef}
            type="button"
            aria-label={t("translation.movePopover", "Move translation window")}
            title={t("translation.movePopover", "Move translation window")}
            className="flex min-w-6 flex-1 cursor-move touch-none items-center justify-center self-stretch rounded-sm text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onPointerDown={handleMovePointerDown}
            onPointerMove={handleMovePointerMove}
            onPointerUp={handleMovePointerEnd}
            onPointerCancel={handleMovePointerEnd}
            onLostPointerCapture={handleMovePointerEnd}
            onKeyDown={handleMoveKeyDown}
          >
            <GripHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Translation content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>{t("translation.translating")}</span>
            </div>
          )}

          {error && !loading && <div className="py-1 text-sm text-destructive">{error}</div>}

          {!loading && !error && translation && (
            <p className="text-sm leading-relaxed">{translation}</p>
          )}
        </div>

        {!loading && !error && translation && (
          <div className="flex shrink-0 items-center justify-end gap-2 px-3 pb-2 pr-7 pt-1">
            <span className="max-w-28 truncate text-[10px] text-muted-foreground">
              {providerName}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3" />
                  <span>{t("common.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  <span>{t("common.copy")}</span>
                </>
              )}
            </button>
          </div>
        )}

        <button
          ref={resizeGripRef}
          type="button"
          aria-label={t("translation.resizePopover", "Resize translation window")}
          title={t("translation.resizePopover", "Resize translation window")}
          className="absolute bottom-0 right-0 flex h-6 w-6 items-end justify-end rounded-tl-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          style={{ touchAction: "none", cursor: "se-resize" }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerEnd}
          onPointerCancel={handleResizePointerEnd}
          onLostPointerCapture={handleResizePointerEnd}
          onKeyDown={handleResizeKeyDown}
        >
          <Scaling className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
