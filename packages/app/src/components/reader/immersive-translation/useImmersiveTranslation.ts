import { useSettingsStore } from "@/stores/settings-store";
import type { AIConfig, TranslationConfig } from "@readany/core";
import {
  type ChapterParagraph,
  type ChapterTranslationProgress,
  type ChapterTranslationResult,
  translateChapter,
} from "@readany/core/translation";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { ImmersiveSourceResult, ImmersiveSourceSnapshot } from "./types";
import type { PrepareBookContext } from "./useBookTranslationContext";

export type ImmersiveTranslationStatus =
  | "idle"
  | "extracting"
  | "translating"
  | "partial"
  | "complete"
  | "error";

export interface ImmersiveTranslationState {
  status: ImmersiveTranslationStatus;
  enabled: boolean;
  runId: number;
  requestKey: string | null;
  targetLang: string;
  snapshot: ImmersiveSourceSnapshot | null;
  results: Record<string, string>;
  progress: ChapterTranslationProgress;
  errorCode?: "no-extractable-text" | "text-layer-timeout" | "source-error" | "translation-error";
  errorMessage?: string;
}

type RunScopedAction = { runId: number };

export type ImmersiveTranslationAction =
  | ({
      type: "begin";
      requestKey: string;
      targetLang: string;
      preserveCurrent?: boolean;
    } & RunScopedAction)
  | ({ type: "source"; snapshot: ImmersiveSourceSnapshot } & RunScopedAction)
  | ({
      type: "progress";
      fingerprint: string;
      progress: ChapterTranslationProgress;
    } & RunScopedAction)
  | ({
      type: "chunk";
      fingerprint: string;
      results: ChapterTranslationResult[];
    } & RunScopedAction)
  | ({
      type: "finish";
      fingerprint: string;
      results: ChapterTranslationResult[];
    } & RunScopedAction)
  | ({ type: "cancel" } & RunScopedAction)
  | ({
      type: "fail";
      errorCode: NonNullable<ImmersiveTranslationState["errorCode"]>;
      errorMessage?: string;
    } & RunScopedAction)
  | { type: "exit"; runId: number };

const EMPTY_PROGRESS: ChapterTranslationProgress = { totalChars: 0, translatedChars: 0 };
const SOURCE_RETRY_ATTEMPTS = 24;
const SOURCE_RETRY_DELAY_MS = 125;
const PAGE_CACHE_LIMIT = 60;
const PAGE_SETTLE_DELAY_MS = 180;

export function buildImmersiveRequestKey(
  bookId: string,
  sectionIndex: number,
  locationKey: string,
  targetLang: string,
  providerSignature = "",
) {
  return `${bookId}:${sectionIndex}:${locationKey}:${targetLang}:${providerSignature}`;
}

export function buildImmersiveProviderSignature(
  config: TranslationConfig,
  aiConfig: AIConfig,
): string {
  const provider = config.provider;
  const endpointId = provider.endpointId || aiConfig.activeEndpointId;
  const endpoint =
    provider.id === "ai" ? aiConfig.endpoints.find((item) => item.id === endpointId) : null;
  return [
    provider.id,
    provider.id === "ai" ? endpointId : "",
    endpoint?.baseUrl || provider.baseUrl || "",
    provider.model || (provider.id === "ai" ? aiConfig.activeModel : ""),
    String(endpoint?.useExactRequestUrl ?? provider.useExactRequestUrl ?? false),
  ].join("|");
}

export function shouldScheduleImmersiveAutoRun(options: {
  enabled: boolean;
  sourceReady: boolean;
  requestKey: string;
  lastRequestedKey: string | null;
}): boolean {
  // `sourceReady` is only a renderer hint. A PDF layout change can emit the
  // final relocate before the section-load callback resets that hint, leaving
  // it false forever. The extractor has its own bounded retry/timeout, so it
  // must remain the authority for deciding whether the current page is ready.
  void options.sourceReady;
  return options.enabled && options.lastRequestedKey !== options.requestKey;
}

export const initialImmersiveTranslationState: ImmersiveTranslationState = {
  status: "idle",
  enabled: false,
  runId: 0,
  requestKey: null,
  targetLang: "",
  snapshot: null,
  results: {},
  progress: EMPTY_PROGRESS,
};

/** The execute boundary is the single source of truth for translatable input. */
export function buildImmersiveTranslationParagraphs(
  snapshot: ImmersiveSourceSnapshot,
): ChapterParagraph[] {
  return snapshot.blocks
    .filter((block) => block.contentKind === "prose")
    .map((block) => ({
      id: block.id,
      text: block.text,
      tagName: block.kind === "epub" ? block.tagName : "p",
    }));
}

function withProseExpectedBlockIds(snapshot: ImmersiveSourceSnapshot): ImmersiveSourceSnapshot {
  return {
    ...snapshot,
    expectedBlockIds: snapshot.blocks
      .filter((block) => block.contentKind === "prose")
      .map((block) => block.id),
  };
}

function translatableSourceChars(snapshot: ImmersiveSourceSnapshot): number {
  return buildImmersiveTranslationParagraphs(snapshot).reduce(
    (sum, paragraph) => sum + paragraph.text.length,
    0,
  );
}

function acceptsSnapshotAction(
  state: ImmersiveTranslationState,
  action: RunScopedAction & { fingerprint: string },
) {
  return action.runId === state.runId && action.fingerprint === state.snapshot?.fingerprint;
}

function mergeExpectedResults(
  snapshot: ImmersiveSourceSnapshot,
  current: Record<string, string>,
  incoming: ChapterTranslationResult[],
) {
  const expected = new Set(snapshot.expectedBlockIds);
  const next = { ...current };
  for (const result of incoming) {
    const translated = result.translatedText.trim();
    if (expected.has(result.paragraphId) && translated) next[result.paragraphId] = translated;
  }
  return next;
}

export function immersiveTranslationReducer(
  state: ImmersiveTranslationState,
  action: ImmersiveTranslationAction,
): ImmersiveTranslationState {
  if (action.type === "begin") {
    if (action.runId < state.runId) return state;
    const preserveCurrent =
      action.preserveCurrent &&
      action.requestKey === state.requestKey &&
      action.targetLang === state.targetLang;
    return {
      status: "extracting",
      enabled: true,
      runId: action.runId,
      requestKey: action.requestKey,
      targetLang: action.targetLang,
      snapshot: preserveCurrent ? state.snapshot : null,
      results: preserveCurrent ? state.results : {},
      progress: preserveCurrent ? state.progress : EMPTY_PROGRESS,
    };
  }

  if (action.type === "exit") {
    if (action.runId < state.runId) return state;
    return { ...initialImmersiveTranslationState, runId: action.runId };
  }

  if (action.runId !== state.runId) return state;

  if (action.type === "source") {
    const snapshot = withProseExpectedBlockIds(action.snapshot);
    const sameSnapshot = snapshot.fingerprint === state.snapshot?.fingerprint;
    const results = sameSnapshot ? state.results : {};
    return {
      ...state,
      status: "translating",
      snapshot,
      results,
      progress: {
        totalChars: translatableSourceChars(snapshot),
        translatedChars: buildImmersiveTranslationParagraphs(snapshot).reduce(
          (sum, block) => sum + (results[block.id] ? block.text.length : 0),
          0,
        ),
      },
      errorCode: undefined,
      errorMessage: undefined,
    };
  }

  if (action.type === "progress") {
    if (!acceptsSnapshotAction(state, action)) return state;
    return { ...state, status: "translating", progress: action.progress };
  }

  if (action.type === "chunk") {
    if (!state.snapshot || !acceptsSnapshotAction(state, action)) return state;
    return {
      ...state,
      results: mergeExpectedResults(state.snapshot, state.results, action.results),
    };
  }

  if (action.type === "finish") {
    if (!state.snapshot || !acceptsSnapshotAction(state, action)) return state;
    const results = mergeExpectedResults(state.snapshot, state.results, action.results);
    const complete = state.snapshot.expectedBlockIds.every((id) => Boolean(results[id]?.trim()));
    return {
      ...state,
      status: complete ? "complete" : "partial",
      results,
      progress: {
        totalChars: state.progress.totalChars,
        translatedChars: complete ? state.progress.totalChars : state.progress.translatedChars,
      },
    };
  }

  if (action.type === "cancel") {
    const hasResults = Object.keys(state.results).length > 0;
    return {
      ...state,
      status: hasResults ? "partial" : "idle",
      enabled: hasResults,
    };
  }

  if (action.type === "fail") {
    return {
      ...state,
      status: Object.keys(state.results).length > 0 ? "partial" : "error",
      errorCode: action.errorCode,
      errorMessage: action.errorMessage,
    };
  }

  return state;
}

export interface UseImmersiveTranslationOptions {
  bookId: string;
  sectionIndex: number;
  locationKey: string;
  ready: boolean;
  getSource: () => ImmersiveSourceResult | Promise<ImmersiveSourceResult>;
  prepareContext?: PrepareBookContext;
  contextEpoch?: number;
}

const waitForRetry = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, SOURCE_RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });

export function useImmersiveTranslation({
  bookId,
  sectionIndex,
  locationKey,
  ready,
  getSource,
  prepareContext,
  contextEpoch = 0,
}: UseImmersiveTranslationOptions) {
  const [state, dispatch] = useReducer(
    immersiveTranslationReducer,
    initialImmersiveTranslationState,
  );
  const settings = useSettingsStore();
  const getSourceRef = useRef(getSource);
  const prepareContextRef = useRef(prepareContext);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const stateRef = useRef(state);
  const enabledRef = useRef(false);
  const targetLangRef = useRef<string>(settings.translationConfig.targetLang);
  const lastRequestedRef = useRef<string | null>(null);
  const pageCacheRef = useRef(new Map<string, ChapterTranslationResult[]>());

  getSourceRef.current = getSource;
  prepareContextRef.current = prepareContext;
  stateRef.current = state;

  const execute = useCallback(
    async (targetLang: string, preserveCurrent = false) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const runId = ++runIdRef.current;
      const providerSignature = `${contextEpoch}:${buildImmersiveProviderSignature(
        settings.translationConfig,
        settings.aiConfig,
      )}`;
      const requestKey = buildImmersiveRequestKey(
        bookId,
        sectionIndex,
        locationKey,
        targetLang,
        providerSignature,
      );
      lastRequestedRef.current = requestKey;
      targetLangRef.current = targetLang;
      dispatch({ type: "begin", runId, requestKey, targetLang, preserveCurrent });

      try {
        let sourceResult: ImmersiveSourceResult | null = null;
        for (let attempt = 0; attempt < SOURCE_RETRY_ATTEMPTS; attempt++) {
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          sourceResult = await getSourceRef.current();
          if (sourceResult.status !== "retryable") break;
          await waitForRetry(controller.signal);
        }

        if (!sourceResult || sourceResult.status === "retryable") {
          dispatch({ type: "fail", runId, errorCode: "text-layer-timeout" });
          return;
        }
        if (sourceResult.status === "unsupported") {
          dispatch({ type: "fail", runId, errorCode: "no-extractable-text" });
          return;
        }
        if (sourceResult.status === "error") {
          dispatch({
            type: "fail",
            runId,
            errorCode: "source-error",
            errorMessage: sourceResult.message,
          });
          return;
        }

        const snapshot = withProseExpectedBlockIds(sourceResult.snapshot);
        dispatch({ type: "source", runId, snapshot });

        const config = { ...settings.translationConfig };
        config.targetLang = targetLang as typeof config.targetLang;
        if (config.provider.id === "ai") {
          const endpointId = config.provider.endpointId || settings.aiConfig.activeEndpointId;
          const endpoint = settings.aiConfig.endpoints.find((item) => item.id === endpointId);
          if (endpoint) {
            config.provider = {
              ...config.provider,
              apiKey: endpoint.apiKey,
              baseUrl: endpoint.baseUrl,
              useExactRequestUrl: endpoint.useExactRequestUrl,
              model: config.provider.model || settings.aiConfig.activeModel,
            };
          }
        }

        const paragraphs = buildImmersiveTranslationParagraphs(snapshot);
        const context = config.provider.id === "ai" && paragraphs.length > 0
          ? await prepareContextRef.current?.(targetLang, controller.signal,
              paragraphs.map((paragraph) => paragraph.text).join("\n"), snapshot.nearbyText)
          : undefined;
        if (controller.signal.aborted || runId !== runIdRef.current) throw new DOMException("Aborted", "AbortError");
        const pageCacheKey = `${bookId}:${targetLang}:${providerSignature}:${context?.digest ?? "none"}:${snapshot.fingerprint}`;
        const cachedPage = pageCacheRef.current.get(pageCacheKey);
        if (cachedPage) {
          pageCacheRef.current.delete(pageCacheKey);
          pageCacheRef.current.set(pageCacheKey, cachedPage);
          dispatch({
            type: "finish",
            runId,
            fingerprint: snapshot.fingerprint,
            results: cachedPage,
          });
          return;
        }

        if (paragraphs.length === 0) {
          dispatch({
            type: "finish",
            runId,
            fingerprint: snapshot.fingerprint,
            results: [],
          });
          return;
        }

        const finalResults = await translateChapter({
          paragraphs,
          sourceLang: "AUTO",
          targetLang,
          config,
          context,
          signal: controller.signal,
          onProgress: (progress) =>
            dispatch({ type: "progress", runId, fingerprint: snapshot.fingerprint, progress }),
          onChunkComplete: (results) =>
            dispatch({ type: "chunk", runId, fingerprint: snapshot.fingerprint, results }),
        });

        if (controller.signal.aborted) {
          dispatch({ type: "cancel", runId });
          return;
        }
        const resultById = new Map(
          finalResults.map((result) => [result.paragraphId, result.translatedText.trim()]),
        );
        if (snapshot.expectedBlockIds.every((id) => Boolean(resultById.get(id)))) {
          pageCacheRef.current.set(pageCacheKey, finalResults);
          while (pageCacheRef.current.size > PAGE_CACHE_LIMIT) {
            const oldestKey = pageCacheRef.current.keys().next().value;
            if (!oldestKey) break;
            pageCacheRef.current.delete(oldestKey);
          }
        }
        dispatch({
          type: "finish",
          runId,
          fingerprint: snapshot.fingerprint,
          results: finalResults,
        });
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          dispatch({ type: "cancel", runId });
          return;
        }
        dispatch({
          type: "fail",
          runId,
          errorCode: "translation-error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [bookId, locationKey, sectionIndex, settings.aiConfig, settings.translationConfig, contextEpoch],
  );

  const start = useCallback(
    (targetLang?: string) => {
      const nextLang = targetLang || settings.translationConfig.targetLang;
      enabledRef.current = true;
      void execute(nextLang);
    },
    [execute, settings.translationConfig.targetLang],
  );

  const retry = useCallback(() => {
    enabledRef.current = true;
    void execute(targetLangRef.current || settings.translationConfig.targetLang, true);
  }, [execute, settings.translationConfig.targetLang]);

  const cancel = useCallback(() => {
    if (Object.keys(stateRef.current.results).length === 0) enabledRef.current = false;
    abortRef.current?.abort();
  }, []);

  const exit = useCallback(() => {
    enabledRef.current = false;
    lastRequestedRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    dispatch({ type: "exit", runId: ++runIdRef.current });
  }, []);

  useEffect(() => {
    if (!enabledRef.current) return;
    abortRef.current?.abort();
    lastRequestedRef.current = null;
    dispatch({
      type: "begin",
      runId: ++runIdRef.current,
      requestKey: buildImmersiveRequestKey(
        bookId,
        sectionIndex,
        locationKey,
        targetLangRef.current,
        `${contextEpoch}:${buildImmersiveProviderSignature(settings.translationConfig, settings.aiConfig)}`,
      ),
      targetLang: targetLangRef.current,
    });
  }, [bookId, locationKey, sectionIndex, settings.aiConfig, settings.translationConfig, contextEpoch]);

  useEffect(() => {
    const requestKey = buildImmersiveRequestKey(
      bookId,
      sectionIndex,
      locationKey,
      targetLangRef.current,
      `${contextEpoch}:${buildImmersiveProviderSignature(settings.translationConfig, settings.aiConfig)}`,
    );
    if (
      !shouldScheduleImmersiveAutoRun({
        enabled: enabledRef.current,
        sourceReady: ready,
        requestKey,
        lastRequestedKey: lastRequestedRef.current,
      })
    ) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void execute(targetLangRef.current);
    }, PAGE_SETTLE_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [
    bookId,
    execute,
    locationKey,
    ready,
    sectionIndex,
    settings.aiConfig,
    settings.translationConfig,
    contextEpoch,
  ]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return { state, start, retry, cancel, exit };
}
