import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { useSettingsStore } from "@/stores/settings-store";
import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  type HighFidelityPdfProvider,
  type HighFidelityPdfState,
  type PdfBookExportState,
  type PdfEngineRequest,
  type PdfEngineStatusResponse,
  type PdfExportPlan,
  type PdfExportSaveResult,
  type PdfPrefetchState,
  buildHighFidelityPdfRequestKey,
  getPdfProviderDisplay,
  highFidelityPdfReducer,
  initialHighFidelityPdfState,
  resolveHighFidelityPdfProvider,
} from "./high-fidelity-pdf";
import type { PrepareBookContext } from "./useBookTranslationContext";

interface PdfEngineInfoResponse {
  ready: boolean;
}

interface PdfEngineStartResponse {
  jobId: string;
}

interface UseHighFidelityPdfTranslationOptions {
  supported: boolean;
  bookId: string;
  filePath?: string;
  /** Zero-based PDF page index, matching ReaderView.currentSectionIndex. */
  page: number;
  prepareContext?: PrepareBookContext;
  contextEpoch?: number;
  totalPages?: number | null;
}

const PAGE_DEBOUNCE_MS = 350;
const STATUS_POLL_MS = 500;
const CANCEL_SETTLE_POLL_MS = 100;
const CANCEL_SETTLE_ATTEMPTS = 60;
const MAX_STATUS_POLLS = 2400;
const PREFETCH_IDLE_MS = 900;

function createJobId(): string {
  return globalThis.crypto.randomUUID();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

function terminal(status: PdfEngineStatusResponse["status"]): boolean {
  return status === "complete" || status === "error" || status === "cancelled";
}

function sanitizeClientError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return String(error || "PDF engine request failed");
}

export interface UseHighFidelityPdfTranslationResult {
  state: HighFidelityPdfState;
  provider: HighFidelityPdfProvider;
  start: (targetLang?: string) => void;
  install: () => void;
  cancel: () => void;
  retry: () => void;
  exit: () => void;
  prefetch: PdfPrefetchState;
  bookExport: PdfBookExportState;
  startExport: () => void;
  confirmExport: () => void;
  cancelExport: () => void;
}

export function useHighFidelityPdfTranslation({
  supported,
  bookId,
  filePath,
  page,
  prepareContext,
  contextEpoch = 0,
  totalPages = null,
}: UseHighFidelityPdfTranslationOptions): UseHighFidelityPdfTranslationResult {
  const translationConfig = useSettingsStore((state) => state.translationConfig);
  const aiConfig = useSettingsStore((state) => state.aiConfig);
  const [state, dispatch] = useReducer(highFidelityPdfReducer, initialHighFidelityPdfState);
  const [targetLang, setTargetLang] = useState(translationConfig.targetLang);
  const [prefetch, setPrefetch] = useState<PdfPrefetchState>({ status: "idle", page: null });
  const [bookExport, setBookExport] = useState<PdfBookExportState>({ status: "idle" });
  const provider = useMemo(
    () => resolveHighFidelityPdfProvider(translationConfig, aiConfig),
    [aiConfig, translationConfig],
  );
  const pageNumber = Math.max(1, page + 1);
  const requestKey = useMemo(
    () =>
      buildHighFidelityPdfRequestKey(
        bookId,
        pageNumber,
        targetLang,
        provider,
        String(contextEpoch),
      ),
    [bookId, pageNumber, provider, targetLang, contextEpoch],
  );

  const providerRef = useRef(provider);
  const prepareContextRef = useRef(prepareContext);
  prepareContextRef.current = prepareContext;
  const activeRef = useRef(false);
  const suppressedRef = useRef(false);
  const runIdRef = useRef(0);
  const jobIdRef = useRef<string | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const settlingRef = useRef<Promise<void> | null>(null);
  const pageTimerRef = useRef<number | null>(null);
  const prefetchTimerRef = useRef<number | null>(null);
  const exportLockRef = useRef(false);
  const exportRequestRef = useRef<{
    resolvedPath: string;
    destinationPath: string;
    translationContext?: string;
  } | null>(null);
  const latestKeyRef = useRef(requestKey);
  const lastObservedKeyRef = useRef<string | null>(null);
  const filePathRef = useRef(filePath);
  const pageNumberRef = useRef(pageNumber);
  const lastTranslationContextRef = useRef<string | undefined>(undefined);

  providerRef.current = provider;
  filePathRef.current = filePath;
  pageNumberRef.current = pageNumber;

  const clearPageTimer = useCallback(() => {
    if (pageTimerRef.current !== null) {
      window.clearTimeout(pageTimerRef.current);
      pageTimerRef.current = null;
    }
  }, []);

  const clearPrefetchTimer = useCallback(() => {
    if (prefetchTimerRef.current !== null) {
      window.clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  const settleJob = useCallback(async (jobId: string | null) => {
    if (!jobId) return;
    // Serialize cleanup, but do not discard cancellation of a different job.
    const previous = settlingRef.current;
    const settle = (async () => {
      if (previous) await previous;
      try {
        await invokeNative("pdf_engine_cancel", { jobId });
      } catch {
        // A completed job can disappear between status and cancel. Continue
        // with bounded status cleanup; the next request remains guarded.
      }
      for (let attempt = 0; attempt < CANCEL_SETTLE_ATTEMPTS; attempt += 1) {
        try {
          const status = await invokeNative<PdfEngineStatusResponse>("pdf_engine_status", {
            jobId,
          });
          if (terminal(status.status)) return;
        } catch {
          return;
        }
        await wait(CANCEL_SETTLE_POLL_MS);
      }
    })();

    settlingRef.current = settle;
    try {
      await settle;
    } finally {
      if (settlingRef.current === settle) settlingRef.current = null;
    }
  }, []);

  const cancelCurrentJob = useCallback(async () => {
    const jobId = jobIdRef.current;
    jobIdRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (jobId) await settleJob(jobId);
    if (settlingRef.current) await settlingRef.current;
    return jobId;
  }, [settleJob]);

  const readEngineInfo = useCallback(
    async (runId: number): Promise<boolean> => {
      const info = await invokeNative<PdfEngineInfoResponse>("pdf_engine_info");
      if (runId !== runIdRef.current || !activeRef.current) return false;
      if (!info.ready) {
        dispatch({
          type: "needs-setup",
          requestKey: latestKeyRef.current,
          page: pageNumber,
          targetLang: targetLang,
        });
      }
      return info.ready;
    },
    [pageNumber, targetLang],
  );

  const pollJob = useCallback(
    async (
      jobId: string,
      runId: number,
      signal: AbortSignal,
    ): Promise<PdfEngineStatusResponse | null> => {
      for (let attempt = 0; attempt < MAX_STATUS_POLLS; attempt += 1) {
        if (signal.aborted || runId !== runIdRef.current || !activeRef.current) return null;
        let status: PdfEngineStatusResponse;
        try {
          status = await invokeNative<PdfEngineStatusResponse>("pdf_engine_status", { jobId });
        } catch (error) {
          if (signal.aborted || runId !== runIdRef.current) return null;
          dispatch({ jobId, type: "error", error: sanitizeClientError(error) });
          return null;
        }
        if (signal.aborted || runId !== runIdRef.current || !activeRef.current) return null;
        if (status.phase)
          dispatch({ type: "progress", jobId, phase: status.phase, progress: status.progress });
        if (terminal(status.status)) return status;
        try {
          await wait(STATUS_POLL_MS, signal);
        } catch (error) {
          if (!isAbortError(error)) throw error;
          return null;
        }
      }
      if (runId === runIdRef.current && activeRef.current) {
        dispatch({ jobId, type: "error", error: "PDF engine polling timed out" });
      }
      return null;
    },
    [],
  );

  const pollQuietJob = useCallback(async (jobId: string, runId: number, signal: AbortSignal) => {
    for (let attempt = 0; attempt < MAX_STATUS_POLLS; attempt += 1) {
      if (signal.aborted || runId !== runIdRef.current || !activeRef.current) return null;
      const status = await invokeNative<PdfEngineStatusResponse>("pdf_engine_status", { jobId });
      if (terminal(status.status)) return status;
      try {
        await wait(STATUS_POLL_MS, signal);
      } catch (error) {
        if (isAbortError(error)) return null;
        throw error;
      }
    }
    return null;
  }, []);

  const schedulePrefetch = useCallback(
    (
      resolvedPath: string,
      lang: string,
      translationContext: string | undefined,
      completedPage: number,
    ) => {
      clearPrefetchTimer();
      if (!totalPages || completedPage >= totalPages || exportLockRef.current) {
        setPrefetch({ status: "idle", page: null });
        return;
      }
      const nextPage = completedPage + 1;
      setPrefetch({ status: "idle", page: nextPage });
      prefetchTimerRef.current = window.setTimeout(() => {
        prefetchTimerRef.current = null;
        if (!activeRef.current || suppressedRef.current || exportLockRef.current) return;
        const runId = runIdRef.current;
        const providerNow = providerRef.current;
        const jobId = createJobId();
        setPrefetch({ status: "processing", page: nextPage });
        void (async () => {
          try {
            const response = await invokeNative<PdfEngineStartResponse>("pdf_engine_start", {
              request: {
                jobId,
                action: "translate",
                filePath: resolvedPath,
                page: nextPage,
                targetLang: lang,
                baseUrl: providerNow.baseUrl,
                apiKey: providerNow.apiKey,
                model: providerNow.model,
                profileId: providerNow.profileId,
                useExactRequestUrl: providerNow.useExactRequestUrl,
                force: false,
                translationContext,
              } satisfies PdfEngineRequest,
            });
            if (runId !== runIdRef.current || exportLockRef.current || !activeRef.current) {
              void settleJob(response.jobId);
              return;
            }
            jobIdRef.current = response.jobId;
            const controller = new AbortController();
            pollAbortRef.current = controller;
            const status = await pollQuietJob(response.jobId, runId, controller.signal);
            if (jobIdRef.current === response.jobId) jobIdRef.current = null;
            if (pollAbortRef.current === controller) pollAbortRef.current = null;
            if (!status || runId !== runIdRef.current || exportLockRef.current) return;
            if (status.status === "complete") setPrefetch({ status: "ready", page: nextPage });
            else if (status.status === "error")
              setPrefetch({ status: "error", page: nextPage, error: status.error || "预翻译失败" });
          } catch (error) {
            if (runId === runIdRef.current && !isAbortError(error) && !exportLockRef.current) {
              setPrefetch({ status: "error", page: nextPage, error: sanitizeClientError(error) });
            }
          }
        })();
      }, PREFETCH_IDLE_MS);
    },
    [clearPrefetchTimer, pollQuietJob, settleJob, totalPages],
  );

  const beginTranslate = useCallback(
    async (key: string, lang: string, force: boolean) => {
      const requestedPage = pageNumberRef.current;
      const runId = ++runIdRef.current;
      latestKeyRef.current = key;
      const oldJob = jobIdRef.current;
      jobIdRef.current = null;
      pollAbortRef.current?.abort();
      pollAbortRef.current = null;
      if (oldJob) await settleJob(oldJob);
      if (settlingRef.current) await settlingRef.current;
      if (
        runId !== runIdRef.current ||
        !activeRef.current ||
        suppressedRef.current ||
        latestKeyRef.current !== key
      ) {
        return;
      }

      try {
        const info = await invokeNative<PdfEngineInfoResponse>("pdf_engine_info");
        if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key)
          return;
        if (!info.ready) {
          dispatch({ type: "needs-setup", requestKey: key, page: requestedPage, targetLang: lang });
          return;
        }
      } catch (error) {
        if (runId === runIdRef.current && activeRef.current) {
          dispatch({ type: "error", error: sanitizeClientError(error) });
        }
        return;
      }

      const providerNow = providerRef.current;
      const path = filePathRef.current;
      if (!path) {
        dispatch({ type: "error", error: "当前 PDF 文件路径不可用" });
        return;
      }
      if (!providerNow.baseUrl || !providerNow.model) {
        dispatch({
          type: "error",
          error: `请先在 AI 设置中配置 ${providerNow.profileLabel} 的请求地址和模型`,
        });
        return;
      }

      let resolvedPath: string;
      try {
        resolvedPath = await resolveDesktopDataPath(path);
      } catch (error) {
        if (runId === runIdRef.current)
          dispatch({ type: "error", error: sanitizeClientError(error) });
        return;
      }
      if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key) return;

      // Context generation belongs to the book controller, not this page. This
      // controller only cancels waiting when the user navigates or exits.
      const contextWait = new AbortController();
      pollAbortRef.current = contextWait;
      dispatch({
        type: "context",
        requestKey: key,
        page: requestedPage,
        targetLang: lang,
        provider: getPdfProviderDisplay(providerNow),
      });
      let translationContext: string | undefined;
      try {
        const snapshot = await prepareContextRef.current?.(lang, contextWait.signal);
        translationContext = snapshot?.status === "ready" ? snapshot.serialized : undefined;
        lastTranslationContextRef.current = translationContext;
      } catch (error) {
        if (runId === runIdRef.current && activeRef.current && !isAbortError(error)) {
          dispatch({ type: "error", error: sanitizeClientError(error) });
        }
        return;
      }
      if (
        contextWait.signal.aborted ||
        runId !== runIdRef.current ||
        !activeRef.current ||
        latestKeyRef.current !== key
      )
        return;

      const jobId = createJobId();
      const request: PdfEngineRequest = {
        jobId,
        action: "translate",
        filePath: resolvedPath,
        page: requestedPage,
        targetLang: lang,
        baseUrl: providerNow.baseUrl,
        apiKey: providerNow.apiKey,
        model: providerNow.model,
        profileId: providerNow.profileId,
        useExactRequestUrl: providerNow.useExactRequestUrl,
        force,
        translationContext,
      };
      try {
        const response = await invokeNative<PdfEngineStartResponse>("pdf_engine_start", {
          request,
        });
        if (
          runId !== runIdRef.current ||
          !activeRef.current ||
          suppressedRef.current ||
          latestKeyRef.current !== key
        ) {
          void settleJob(response.jobId);
          return;
        }
        jobIdRef.current = response.jobId;
        const controller = new AbortController();
        pollAbortRef.current = controller;
        dispatch({
          type: "translating",
          jobId: response.jobId,
          requestKey: key,
          page: requestedPage,
          targetLang: lang,
          phase: "starting",
          startedAt: Date.now(),
          provider: getPdfProviderDisplay(providerNow),
        });
        const status = await pollJob(response.jobId, runId, controller.signal);
        if (!status) {
          if (runId === runIdRef.current) {
            jobIdRef.current = null;
            pollAbortRef.current = null;
            void settleJob(response.jobId);
          }
          return;
        }
        if (runId !== runIdRef.current || !activeRef.current) return;
        jobIdRef.current = null;
        pollAbortRef.current = null;
        if (status.status === "complete") {
          let pdfBase64: string;
          try {
            pdfBase64 = await invokeNative<string>("pdf_engine_result", {
              jobId: response.jobId,
            });
          } catch (error) {
            dispatch({ type: "error", jobId: response.jobId, error: sanitizeClientError(error) });
            return;
          }
          if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key)
            return;
          dispatch({
            type: "complete",
            jobId: response.jobId,
            page: requestedPage,
            requestKey: key,
            targetLang: lang,
            cached: status.cached,
            pdfBase64,
          });
          schedulePrefetch(resolvedPath, lang, translationContext, requestedPage);
        } else if (status.status === "cancelled") {
          dispatch({ type: "cancelled", jobId: response.jobId });
        } else {
          dispatch({
            type: "error",
            jobId: response.jobId,
            error: status.error || "PDF 翻译失败",
          });
        }
      } catch (error) {
        if (runId !== runIdRef.current || isAbortError(error)) return;
        dispatch({ type: "error", error: sanitizeClientError(error) });
      }
    },
    [pollJob, schedulePrefetch, settleJob],
  );

  const start = useCallback(
    (nextTargetLang?: string) => {
      if (!supported) return;
      clearPrefetchTimer();
      setPrefetch({ status: "idle", page: null });
      const lang = (nextTargetLang ||
        translationConfig.targetLang) as typeof translationConfig.targetLang;
      const key = buildHighFidelityPdfRequestKey(
        bookId,
        pageNumber,
        lang,
        providerRef.current,
        String(contextEpoch),
      );
      setTargetLang(lang);
      activeRef.current = true;
      suppressedRef.current = false;
      latestKeyRef.current = key;
      lastObservedKeyRef.current = key;
      dispatch({
        type: "activate",
        requestKey: key,
        page: pageNumber,
        targetLang: lang,
        engineReady: false,
      });
      void (async () => {
        const runId = ++runIdRef.current;
        try {
          const ready = await readEngineInfo(runId);
          if (
            !ready ||
            runId !== runIdRef.current ||
            !activeRef.current ||
            latestKeyRef.current !== key
          )
            return;
          void beginTranslate(key, lang, false);
        } catch (error) {
          if (runId === runIdRef.current && activeRef.current) {
            dispatch({ type: "error", error: sanitizeClientError(error) });
          }
        }
      })();
    },
    [
      beginTranslate,
      bookId,
      clearPrefetchTimer,
      pageNumber,
      readEngineInfo,
      supported,
      translationConfig.targetLang,
      contextEpoch,
    ],
  );

  const install = useCallback(() => {
    if (!supported || !activeRef.current) return;
    clearPageTimer();
    clearPrefetchTimer();
    suppressedRef.current = false;
    const key = latestKeyRef.current;
    const lang = targetLang;
    void (async () => {
      const runId = ++runIdRef.current;
      const oldJob = await cancelCurrentJob();
      if (oldJob) dispatch({ type: "cancelled", jobId: oldJob });
      if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key) return;
      try {
        const info = await invokeNative<PdfEngineInfoResponse>("pdf_engine_info");
        if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key)
          return;
        if (info.ready) {
          void beginTranslate(key, lang, false);
          return;
        }
        const jobId = createJobId();
        const response = await invokeNative<PdfEngineStartResponse>("pdf_engine_start", {
          request: { jobId, action: "setup" } satisfies PdfEngineRequest,
        });
        if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key) {
          void settleJob(response.jobId);
          return;
        }
        jobIdRef.current = response.jobId;
        const controller = new AbortController();
        pollAbortRef.current = controller;
        dispatch({
          type: "installing",
          jobId: response.jobId,
          phase: "starting",
          startedAt: Date.now(),
        });
        const status = await pollJob(response.jobId, runId, controller.signal);
        if (!status) {
          if (runId === runIdRef.current) {
            jobIdRef.current = null;
            pollAbortRef.current = null;
            void settleJob(response.jobId);
          }
          return;
        }
        if (runId !== runIdRef.current || !activeRef.current) return;
        jobIdRef.current = null;
        pollAbortRef.current = null;
        if (status.status === "complete") {
          const afterSetup = await invokeNative<PdfEngineInfoResponse>("pdf_engine_info");
          if (
            afterSetup.ready &&
            runId === runIdRef.current &&
            activeRef.current &&
            latestKeyRef.current === key
          ) {
            void beginTranslate(key, lang, false);
          } else if (runId === runIdRef.current && activeRef.current) {
            dispatch({ type: "error", error: "PDF engine 安装未完成" });
          }
        } else if (status.status === "cancelled") {
          dispatch({ type: "cancelled", jobId: response.jobId });
        } else {
          dispatch({
            type: "error",
            jobId: response.jobId,
            error: status.error || "PDF engine 安装失败",
          });
        }
      } catch (error) {
        if (runId === runIdRef.current && activeRef.current) {
          dispatch({ type: "error", error: sanitizeClientError(error) });
        }
      }
    })();
  }, [
    beginTranslate,
    cancelCurrentJob,
    clearPageTimer,
    clearPrefetchTimer,
    pollJob,
    settleJob,
    supported,
    targetLang,
  ]);

  const cancel = useCallback(() => {
    if (!activeRef.current) return;
    clearPageTimer();
    clearPrefetchTimer();
    setPrefetch({ status: "idle", page: null });
    suppressedRef.current = true;
    const runId = ++runIdRef.current;
    const jobId = jobIdRef.current;
    void cancelCurrentJob().finally(() => {
      if (activeRef.current && runId === runIdRef.current)
        dispatch({ type: "cancelled", jobId: jobId || undefined });
    });
  }, [cancelCurrentJob, clearPageTimer, clearPrefetchTimer]);

  const retry = useCallback(() => {
    if (!activeRef.current) return;
    suppressedRef.current = false;
    clearPageTimer();
    clearPrefetchTimer();
    const key = latestKeyRef.current;
    const runId = ++runIdRef.current;
    void (async () => {
      try {
        const info = await invokeNative<PdfEngineInfoResponse>("pdf_engine_info");
        if (runId !== runIdRef.current || !activeRef.current || latestKeyRef.current !== key)
          return;
        if (!info.ready) {
          dispatch({ type: "needs-setup", requestKey: key, page: pageNumber, targetLang });
          return;
        }
        if (runId === runIdRef.current && activeRef.current && latestKeyRef.current === key) {
          void beginTranslate(key, targetLang, true);
        }
      } catch (error) {
        if (activeRef.current && runId === runIdRef.current)
          dispatch({ type: "error", error: sanitizeClientError(error) });
      }
    })();
  }, [beginTranslate, clearPageTimer, clearPrefetchTimer, pageNumber, targetLang]);

  const resumeVisibleAfterExport = useCallback(() => {
    exportLockRef.current = false;
    exportRequestRef.current = null;
    if (!activeRef.current || suppressedRef.current) return;
    const key = latestKeyRef.current;
    window.setTimeout(() => {
      if (activeRef.current && !exportLockRef.current && latestKeyRef.current === key) {
        void beginTranslate(key, targetLang, false);
      }
    }, 0);
  }, [beginTranslate, targetLang]);

  const startExport = useCallback(() => {
    if (!activeRef.current || exportLockRef.current || !filePathRef.current) return;
    void (async () => {
      let destinationPath: string | null = null;
      try {
        const selected = await save({
          title: "保存整本译文 PDF",
          defaultPath: `${bookId}-translated.pdf`,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        destinationPath = typeof selected === "string" ? selected : null;
        if (!destinationPath) return;
        const sourcePath = filePathRef.current;
        if (!sourcePath) return;
        const resolvedPath = await resolveDesktopDataPath(sourcePath);
        await invokeNative("pdf_engine_validate_export_destination", {
          sourcePath: resolvedPath,
          destinationPath,
          overwriteApproved: true,
        });

        exportLockRef.current = true;
        clearPageTimer();
        clearPrefetchTimer();
        setPrefetch({ status: "idle", page: null });
        const runId = ++runIdRef.current;
        await cancelCurrentJob();
        if (!activeRef.current || runId !== runIdRef.current) return;
        const providerNow = providerRef.current;
        const translationContext = lastTranslationContextRef.current;
        exportRequestRef.current = { resolvedPath, destinationPath, translationContext };
        setBookExport({ status: "planning", destinationPath });
        const jobId = createJobId();
        const response = await invokeNative<PdfEngineStartResponse>("pdf_engine_start", {
          request: {
            jobId,
            action: "plan-export",
            filePath: resolvedPath,
            targetLang,
            baseUrl: providerNow.baseUrl,
            apiKey: providerNow.apiKey,
            model: providerNow.model,
            profileId: providerNow.profileId,
            useExactRequestUrl: providerNow.useExactRequestUrl,
            translationContext,
          } satisfies PdfEngineRequest,
        });
        if (runId !== runIdRef.current || !activeRef.current) {
          void settleJob(response.jobId);
          return;
        }
        jobIdRef.current = response.jobId;
        const controller = new AbortController();
        pollAbortRef.current = controller;
        const status = await pollQuietJob(response.jobId, runId, controller.signal);
        if (jobIdRef.current === response.jobId) jobIdRef.current = null;
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        if (!status || runId !== runIdRef.current) return;
        if (status.status !== "complete") {
          throw new Error(status.error || "无法统计整本翻译任务");
        }
        const plan = await invokeNative<PdfExportPlan>("pdf_engine_plan_result", {
          jobId: response.jobId,
        });
        if (runId !== runIdRef.current || !activeRef.current) return;
        setBookExport({ status: "confirming", destinationPath, plan, warnings: plan.warnings });
      } catch (error) {
        exportLockRef.current = false;
        exportRequestRef.current = null;
        setBookExport({
          status: "error",
          destinationPath: destinationPath || undefined,
          error: sanitizeClientError(error),
        });
      }
    })();
  }, [
    bookId,
    cancelCurrentJob,
    clearPageTimer,
    clearPrefetchTimer,
    pollQuietJob,
    settleJob,
    targetLang,
  ]);

  const confirmExport = useCallback(() => {
    const exportRequest = exportRequestRef.current;
    if (!activeRef.current || !exportLockRef.current || !exportRequest) return;
    void (async () => {
      const runId = ++runIdRef.current;
      const providerNow = providerRef.current;
      const plan = bookExport.plan;
      setBookExport({
        status: "exporting",
        destinationPath: exportRequest.destinationPath,
        plan,
        current: 0,
        total: plan?.totalPages,
        warnings: plan?.warnings,
      });
      try {
        const jobId = createJobId();
        const response = await invokeNative<PdfEngineStartResponse>("pdf_engine_start", {
          request: {
            jobId,
            action: "export",
            filePath: exportRequest.resolvedPath,
            targetLang,
            baseUrl: providerNow.baseUrl,
            apiKey: providerNow.apiKey,
            model: providerNow.model,
            profileId: providerNow.profileId,
            useExactRequestUrl: providerNow.useExactRequestUrl,
            translationContext: exportRequest.translationContext,
          } satisfies PdfEngineRequest,
        });
        if (runId !== runIdRef.current || !activeRef.current) {
          void settleJob(response.jobId);
          return;
        }
        jobIdRef.current = response.jobId;
        const controller = new AbortController();
        pollAbortRef.current = controller;
        let finalStatus: PdfEngineStatusResponse | null = null;
        for (let attempt = 0; attempt < MAX_STATUS_POLLS * 200; attempt += 1) {
          if (controller.signal.aborted || runId !== runIdRef.current || !activeRef.current) return;
          const status = await invokeNative<PdfEngineStatusResponse>("pdf_engine_status", {
            jobId: response.jobId,
          });
          if (status.progress?.bookTotal) {
            setBookExport((current) => ({
              ...current,
              current: status.progress?.bookCurrent || 0,
              total: status.progress?.bookTotal,
            }));
          }
          if (terminal(status.status)) {
            finalStatus = status;
            break;
          }
          await wait(STATUS_POLL_MS, controller.signal);
        }
        if (jobIdRef.current === response.jobId) jobIdRef.current = null;
        if (pollAbortRef.current === controller) pollAbortRef.current = null;
        if (!finalStatus || finalStatus.status !== "complete") {
          throw new Error(finalStatus?.error || "整本翻译未完成");
        }
        const saved = await invokeNative<PdfExportSaveResult>("pdf_engine_save_export", {
          jobId: response.jobId,
          sourcePath: exportRequest.resolvedPath,
          destinationPath: exportRequest.destinationPath,
          overwriteApproved: true,
        });
        if (runId !== runIdRef.current || !activeRef.current) return;
        setBookExport({
          status: "complete",
          destinationPath: saved.destinationPath,
          plan,
          current: plan?.totalPages,
          total: plan?.totalPages,
          warnings: saved.warnings,
        });
        resumeVisibleAfterExport();
      } catch (error) {
        setBookExport((current) => ({
          ...current,
          status: "error",
          error: sanitizeClientError(error),
        }));
        resumeVisibleAfterExport();
      }
    })();
  }, [bookExport.plan, resumeVisibleAfterExport, settleJob, targetLang]);

  const cancelExport = useCallback(() => {
    if (!exportLockRef.current && bookExport.status === "idle") return;
    const runId = ++runIdRef.current;
    void cancelCurrentJob().finally(() => {
      if (runId !== runIdRef.current) return;
      setBookExport((current) => ({ ...current, status: "cancelled" }));
      resumeVisibleAfterExport();
    });
  }, [bookExport.status, cancelCurrentJob, resumeVisibleAfterExport]);

  const exit = useCallback(() => {
    activeRef.current = false;
    suppressedRef.current = true;
    runIdRef.current += 1;
    latestKeyRef.current = "";
    lastObservedKeyRef.current = null;
    clearPageTimer();
    clearPrefetchTimer();
    exportLockRef.current = false;
    exportRequestRef.current = null;
    setPrefetch({ status: "idle", page: null });
    setBookExport({ status: "idle" });
    const oldJob = jobIdRef.current;
    void cancelCurrentJob();
    dispatch({ type: "exit" });
    if (oldJob) void settleJob(oldJob);
  }, [cancelCurrentJob, clearPageTimer, clearPrefetchTimer, settleJob]);

  useEffect(() => {
    if (!supported) {
      activeRef.current = false;
      runIdRef.current += 1;
      clearPageTimer();
      clearPrefetchTimer();
      void cancelCurrentJob();
      dispatch({ type: "exit" });
      return;
    }
    latestKeyRef.current = requestKey;
    if (!activeRef.current || lastObservedKeyRef.current === requestKey) return;
    lastObservedKeyRef.current = requestKey;
    suppressedRef.current = false;
    clearPrefetchTimer();
    setPrefetch({ status: "idle", page: null });
    dispatch({ type: "page-change", requestKey, page: pageNumber, targetLang });
    clearPageTimer();
    // Whole-book export owns the single native engine until it finishes. A
    // reader navigation only updates the desired visible page; it must not
    // cancel the export process or invalidate its generation token.
    if (exportLockRef.current) return;
    const oldJob = jobIdRef.current;
    jobIdRef.current = null;
    runIdRef.current += 1;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (oldJob) void settleJob(oldJob);
    pageTimerRef.current = window.setTimeout(() => {
      pageTimerRef.current = null;
      if (!activeRef.current || suppressedRef.current || latestKeyRef.current !== requestKey)
        return;
      void beginTranslate(requestKey, targetLang, false);
    }, PAGE_DEBOUNCE_MS);
    return clearPageTimer;
  }, [
    beginTranslate,
    cancelCurrentJob,
    clearPageTimer,
    clearPrefetchTimer,
    pageNumber,
    requestKey,
    settleJob,
    supported,
    targetLang,
  ]);

  useEffect(() => {
    return () => {
      activeRef.current = false;
      runIdRef.current += 1;
      clearPageTimer();
      clearPrefetchTimer();
      pollAbortRef.current?.abort();
      const oldJob = jobIdRef.current;
      jobIdRef.current = null;
      if (oldJob) void settleJob(oldJob);
    };
  }, [clearPageTimer, clearPrefetchTimer, settleJob]);

  return {
    state,
    provider,
    start,
    install,
    cancel,
    retry,
    exit,
    prefetch,
    bookExport,
    startExport,
    confirmExport,
    cancelExport,
  };
}
