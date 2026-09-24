/**
 * ChatInput — sageread-style rounded card input with deep thinking option
 * Supports attached context quotes that display as chips above the textarea.
 */
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AttachedImage, AttachedQuote } from "@readany/core/types";
import { CHAT_IMAGE_LIMITS, getImageDataUrlBytes } from "@readany/core/utils";
import { Brain, EyeOff, ImagePlus, Quote, Send, Square, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
export type { AttachedQuote };
export type { AttachedImage };

async function loadImage(file: File): Promise<{ image: HTMLImageElement; revoke?: () => void }> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("image-load-failed"));
    image.src = url;
  });
  return { image, revoke: () => URL.revokeObjectURL(url) };
}

/** Compress a desktop image to a small, portable data URL for vision APIs. */
export async function compressChatImage(file: File): Promise<AttachedImage> {
  if (!file.type.startsWith("image/")) throw new Error("not-an-image");
  if (file.size > CHAT_IMAGE_LIMITS.maxRawBytes) throw new Error("raw-image-too-large");

  const { image, revoke } = await loadImage(file);
  try {
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight) || 1;
    let scale = Math.min(1, 1600 / longestEdge);
    let dataUrl = "";
    let width = 0;
    let height = 0;

    for (let attempt = 0; attempt < 8; attempt++) {
      width = Math.max(1, Math.round(image.naturalWidth * scale));
      height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas-unavailable");
      context.drawImage(image, 0, 0, width, height);

      dataUrl = canvas.toDataURL("image/webp", 0.82);
      if (!dataUrl.startsWith("data:image/webp")) {
        dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      }
      for (const quality of [0.72, 0.58, 0.44, 0.3, 0.2]) {
        if (getImageDataUrlBytes(dataUrl) <= CHAT_IMAGE_LIMITS.maxImageBytes) break;
        const type = dataUrl.startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
        dataUrl = canvas.toDataURL(type, quality);
      }
      if (getImageDataUrlBytes(dataUrl) <= CHAT_IMAGE_LIMITS.maxImageBytes) break;
      scale *= 0.78;
    }

    if (getImageDataUrlBytes(dataUrl) > CHAT_IMAGE_LIMITS.maxImageBytes) {
      throw new Error("compressed-image-too-large");
    }
    const mimeType = dataUrl.startsWith("data:image/webp") ? "image/webp" : "image/jpeg";
    return {
      id: `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      mimeType,
      dataUrl,
      size: getImageDataUrlBytes(dataUrl),
      width,
      height,
    };
  } finally {
    revoke?.();
  }
}

interface ChatInputProps {
  onSend: (
    content: string,
    deepThinking?: boolean,
    spoilerFree?: boolean,
    quotes?: AttachedQuote[],
    images?: AttachedImage[],
  ) => boolean | undefined | Promise<boolean | undefined>;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  showDeepThinking?: boolean;
  quotes?: AttachedQuote[];
  onRemoveQuote?: (id: string) => void;
  visionEnabled?: boolean;
}

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
  placeholder,
  showDeepThinking = true,
  quotes = [],
  onRemoveQuote,
  visionEnabled = false,
}: ChatInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [deepThinking, setDeepThinking] = useState(false);
  const [spoilerFree, setSpoilerFree] = useState(false);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [imageErrors, setImageErrors] = useState<Array<{ name: string; message: string }>>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const resolvedPlaceholder = placeholder || t("chat.askPlaceholder");

  const handleSend = useCallback(
    async (useDeepThinking: boolean = deepThinking) => {
      const trimmed = value.trim();
      if (trimmed || quotes.length > 0 || images.length > 0) {
        const accepted = await onSend(
          trimmed,
          useDeepThinking,
          spoilerFree,
          quotes.length > 0 ? quotes : undefined,
          images.length > 0 ? images : undefined,
        );
        if (accepted === false) return;
        setValue("");
        setImages([]);
        setImageErrors([]);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }
    },
    [value, deepThinking, spoilerFree, onSend, quotes, images],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  }, []);

  const toggleDeepThinking = useCallback(() => {
    setDeepThinking((prev) => !prev);
  }, []);

  const toggleSpoilerFree = useCallback(() => {
    setSpoilerFree((prev) => !prev);
  }, []);

  const handleImageFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      if (!visionEnabled) {
        setImageErrors([{ name: "", message: t("chat.visionDisabled") }]);
        return;
      }
      const remaining = CHAT_IMAGE_LIMITS.maxImagesPerMessage - images.length;
      if (files.length > remaining) {
        setImageErrors([{ name: "", message: t("chat.imageLimit") }]);
      }
      const nextFiles = Array.from(files).slice(0, Math.max(remaining, 0));
      const nextImages: AttachedImage[] = [];
      const nextErrors: Array<{ name: string; message: string }> = [];
      for (const file of nextFiles) {
        try {
          const image = await compressChatImage(file);
          if (
            images.reduce((sum, item) => sum + item.size, 0) +
              nextImages.reduce((sum, item) => sum + item.size, 0) +
              image.size >
            1.5 * 1024 * 1024
          ) {
            nextErrors.push({ name: file.name, message: t("chat.imageTotalTooLarge") });
          } else {
            nextImages.push(image);
          }
        } catch (error) {
          const rawTooLarge = error instanceof Error && error.message === "raw-image-too-large";
          const tooLarge = error instanceof Error && error.message === "compressed-image-too-large";
          nextErrors.push({
            name: file.name,
            message: rawTooLarge
              ? t("chat.imageRawTooLarge", { name: file.name })
              : tooLarge
                ? t("chat.imageTooLarge", { name: file.name })
                : t("chat.imageCompressionFailed", { name: file.name }),
          });
        }
      }
      if (nextImages.length > 0) setImages((current) => [...current, ...nextImages]);
      setImageErrors((current) => [...current.filter((item) => item.name), ...nextErrors]);
      if (imageInputRef.current) imageInputRef.current.value = "";
    },
    [images, t, visionEnabled],
  );

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="relative rounded-2xl border bg-background shadow-around">
        {/* Attached quotes chips */}
        {quotes.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            <TooltipProvider delayDuration={300}>
              {quotes.map((q) => (
                <Tooltip key={q.id}>
                  <TooltipTrigger asChild>
                    <span className="group inline-flex max-w-[200px] items-center gap-1 rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary">
                      <Quote className="size-3 shrink-0 opacity-60" />
                      <span className="truncate">{q.text}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveQuote?.(q.id);
                        }}
                        className="ml-0.5 shrink-0 rounded-full p-0.5 opacity-0 transition-opacity hover:bg-primary/10 group-hover:opacity-100"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-xs whitespace-pre-wrap bg-popover text-popover-foreground border shadow-md"
                  >
                    <p className="text-xs leading-relaxed">
                      {q.text.length > 300 ? `${q.text.slice(0, 300)}...` : q.text}
                    </p>
                    {q.source && (
                      <p className="mt-1 text-[10px] text-muted-foreground">— {q.source}</p>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </TooltipProvider>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            handleInput();
          }}
          onKeyDown={handleKeyDown}
          placeholder={quotes.length > 0 ? t("chat.askAboutQuote") : resolvedPlaceholder}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ minHeight: 36, maxHeight: 160 }}
        />
        {(images.length > 0 || imageErrors.length > 0) && (
          <div className="flex flex-wrap gap-2 px-3 pb-2">
            {images.map((image) => (
              <div
                key={image.id}
                className="group relative flex items-center gap-2 rounded-lg border bg-muted/40 p-1.5"
              >
                <img
                  src={image.dataUrl}
                  alt={image.name}
                  className="size-12 rounded object-cover"
                />
                <span
                  className="max-w-[140px] truncate text-xs text-muted-foreground"
                  title={image.name}
                >
                  {image.name}
                </span>
                <button
                  type="button"
                  aria-label={t("chat.removeImage")}
                  title={t("chat.removeImage")}
                  onClick={() =>
                    setImages((current) => current.filter((item) => item.id !== image.id))
                  }
                  className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
            {imageErrors.map((error, index) => (
              <p key={`${error.name}-${index}`} className="self-center text-xs text-destructive">
                {error.name ? `${error.name}: ` : ""}
                {error.message}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between px-3 pb-2">
          <div className="flex items-center gap-1">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => void handleImageFiles(event.target.files)}
            />
            <button
              type="button"
              disabled={
                disabled || !visionEnabled || images.length >= CHAT_IMAGE_LIMITS.maxImagesPerMessage
              }
              onClick={() => imageInputRef.current?.click()}
              title={visionEnabled ? t("chat.attachImage") : t("chat.visionDisabled")}
              className="flex items-center gap-1 rounded-full border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ImagePlus className="size-3" />
              <span>{t("chat.attachImage")}</span>
            </button>
            {showDeepThinking && (
              <button
                type="button"
                onClick={toggleDeepThinking}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors ${
                  deepThinking
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Brain className="size-3" />
                <span>{t("chat.deepThinking")}</span>
              </button>
            )}
            {showDeepThinking && (
              <button
                type="button"
                onClick={toggleSpoilerFree}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-xs transition-colors ${
                  spoilerFree
                    ? "border-primary/50 bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <EyeOff className="size-3" />
                <span>{t("chat.spoilerFree")}</span>
              </button>
            )}
          </div>
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              className="flex size-7 items-center justify-center rounded-full border border-destructive/20 bg-destructive text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90"
            >
              <Square className="size-3" />
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled || (!value.trim() && quotes.length === 0 && images.length === 0)}
              onClick={() => handleSend()}
              className={`flex size-7 items-center justify-center rounded-full transition-colors ${
                value.trim() || quotes.length > 0 || images.length > 0
                  ? "border border-primary/20 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90"
                  : "border border-border bg-background text-muted-foreground hover:bg-muted"
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Send className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {deepThinking && (
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          {t("chat.deepThinkingHint")}
        </p>
      )}
      {spoilerFree && (
        <p className="mt-1.5 text-center text-xs text-muted-foreground">
          {t("chat.spoilerFreeHint")}
        </p>
      )}
    </div>
  );
}
