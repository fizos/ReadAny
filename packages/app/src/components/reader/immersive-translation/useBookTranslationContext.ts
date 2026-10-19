import { useSettingsStore } from "@/stores/settings-store";
import {
  BookContextController,
  type BookContextInput,
  type BookProfileDraft,
  type BookTranslationProfile,
  type ContextSnapshot,
} from "@readany/core/translation/book-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolveHighFidelityPdfProvider } from "./high-fidelity-pdf";

export type PrepareBookContext = (
  targetLang: string,
  signal: AbortSignal,
  sourceText?: string,
  nearbyText?: string,
  chapterTitle?: string,
) => Promise<ContextSnapshot>;

type ProfileEvent = {
  targetLang: string;
  profile: BookTranslationProfile | null;
  status: "loading" | "generating" | "ready" | "error";
  error?: string;
  epoch: number;
};

export function useBookTranslationContext(options: {
  bookId: string;
  getMetadata: () => BookContextInput["metadata"];
  getChapter: () => string;
  getSample: () => string;
}) {
  const { bookId } = options;
  const targetLang = useSettingsStore((s) => s.translationConfig.targetLang);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownerRef = useRef<{ bookId: string; controller: BookContextController } | null>(null);
  const [events, setEvents] = useState<Record<string, ProfileEvent>>({});
  const [epoch, setEpoch] = useState(0);
  const epochRef = useRef(new Map<string, number>());

  // One controller owns both translators. A page cancellation only detaches its
  // waiter; disposal of this book is what cancels the shared profile analysis.
  useEffect(() => {
    const controller = new BookContextController(bookId, (event) => {
      if (ownerRef.current?.controller !== controller) return;
      setEvents((previous) => ({ ...previous, [`${bookId}:${event.targetLang}`]: event }));
      const key = `${bookId}:${event.targetLang}`;
      const previousEpoch = epochRef.current.get(key) ?? 0;
      epochRef.current.set(key, event.epoch);
      if (event.epoch !== previousEpoch) setEpoch((value) => value + 1);
    });
    ownerRef.current = { bookId, controller };
    return () => {
      if (ownerRef.current?.controller === controller) ownerRef.current = null;
      controller.dispose();
    };
  }, [bookId]);

  useEffect(() => {
    const owner = ownerRef.current;
    if (owner?.bookId === bookId) void owner.controller.load(targetLang).catch(() => {});
  }, [bookId, targetLang]);

  const getController = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner || owner.bookId !== bookId) throw new DOMException("Aborted", "AbortError");
    return owner.controller;
  }, [bookId]);

  const captureInput = useCallback((lang: string, sourceText?: string, nearbyText?: string, chapterTitle?: string): BookContextInput => {
    const current = optionsRef.current;
    if (current.bookId !== bookId) throw new DOMException("Aborted", "AbortError");
    const settings = useSettingsStore.getState();
    const provider = resolveHighFidelityPdfProvider(settings.translationConfig, settings.aiConfig);
    const metadata = current.getMetadata();
    // Capture before awaiting: later navigation must not attach another page's
    // chapter or neighboring text to the original request.
    const sample = (sourceText || current.getSample()).slice(0, 4000);
    return {
      targetLang: lang,
      metadata: { ...metadata, toc: metadata.toc?.slice(0, 60), sample },
      provider: { id: "ai", name: provider.profileLabel, endpointId: provider.profileId,
        apiKey: provider.apiKey, baseUrl: provider.baseUrl, model: provider.model,
        useExactRequestUrl: provider.useExactRequestUrl },
      chapter: chapterTitle ?? current.getChapter(),
      sourceText: sourceText || sample,
      nearbyText: nearbyText || "",
    };
  }, [bookId]);

  const prepare: PrepareBookContext = useCallback(async (lang, signal, sourceText, nearbyText, chapterTitle) => {
    const controller = getController();
    const result = await controller.ensureContext(captureInput(lang, sourceText, nearbyText, chapterTitle), signal);
    if (signal.aborted || result.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    if (result.status === "generationFailed") {
      throw new Error(`${result.error} 请在翻译菜单的“本书翻译档案”中重试分析，或关闭上下文增强后保存。`);
    }
    return result;
  }, [captureInput, getController]);

  const save = useCallback((lang: string, draft: BookProfileDraft) =>
    getController().save(lang, draft), [getController]);
  const regenerate = useCallback(async (lang: string, signal: AbortSignal) => {
    const controller = getController();
    const result = await controller.regenerate(captureInput(lang), signal);
    if (signal.aborted || result.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    if (result.status === "generationFailed") throw new Error(result.error);
    return controller.load(lang);
  }, [captureInput, getController]);
  const cancelGeneration = useCallback(() => ownerRef.current?.controller.cancelGeneration(), []);

  return {
    prepare, save, regenerate, cancelGeneration, epoch,
    event: events[`${bookId}:${targetLang}`],
    targetLang,
  };
}
