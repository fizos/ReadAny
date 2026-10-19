import { resolveDesktopDataPath } from "@/lib/storage/desktop-library-root";
import { useSettingsStore } from "@/stores/settings-store";
import { getPlatformService } from "@readany/core/services";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveHighFidelityPdfProvider } from "../immersive-translation/high-fidelity-pdf";
import type { PrepareBookContext } from "../immersive-translation/useBookTranslationContext";
import {
  type EpubFidelityBlock,
  applyEpubTranslation,
  cloneEpubForPreview,
  collectEpubBlocks,
} from "./epub-dom";
import { exportEpubTranslation } from "./epub-export";
import { type EpubTranslationSession, translateEpubBlocks } from "./epub-translator";

export interface EpubReadingSource {
  document: Document;
  sectionKey: string;
  visibleIds: string[];
}

export type EpubTranslationStatus =
  | "idle"
  | "extracting"
  | "processing"
  | "ready"
  | "error"
  | "cancelled";
export interface EpubTranslationState {
  enabled: boolean;
  status: EpubTranslationStatus;
  targetLang: string;
  chapterKey: string;
  document: Document | null;
  translations: Record<string, string>;
  anchorId: string | null;
  anchorRevision: number;
  requested: number;
  completed: number;
  cached: number;
  error?: string;
}

export interface EpubExportState {
  status: "idle" | "confirming" | "processing" | "complete" | "cancelled" | "error";
  current: number;
  total: number;
  label?: string;
  destination?: string;
  error?: string;
}

type ChapterOwner = {
  identity: string;
  document: Document;
  source: Document;
  sectionKey: string;
  blocks: EpubFidelityBlock[];
  results: Record<string, string>;
  requested: Set<string>;
  queue: Set<string>;
  controller: AbortController;
  session?: EpubTranslationSession;
  busy: boolean;
  paused: boolean;
  cached: number;
};

const emptyState: EpubTranslationState = {
  enabled: false,
  status: "idle",
  targetLang: "",
  chapterKey: "",
  document: null,
  translations: {},
  anchorId: null,
  anchorRevision: 0,
  requested: 0,
  completed: 0,
  cached: 0,
};
const emptyExport: EpubExportState = { status: "idle", current: 0, total: 0 };

export function useEpubTranslation(options: {
  supported: boolean;
  bookId: string;
  sectionIndex: number;
  locationKey: string;
  ready: boolean;
  bookTitle: string;
  filePath?: string;
  fixedLayout?: boolean;
  getSource: () => EpubReadingSource | null;
  getBookBlob: () => Promise<Blob>;
  prepareContext: PrepareBookContext;
  contextEpoch: number;
}) {
  const [state, setState] = useState<EpubTranslationState>(emptyState);
  const [bookExport, setExport] = useState<EpubExportState>(emptyExport);
  const settings = useSettingsStore();
  const provider = useMemo(
    () => resolveHighFidelityPdfProvider(settings.translationConfig, settings.aiConfig),
    [settings.translationConfig, settings.aiConfig],
  );
  const providerSignature = JSON.stringify([
    provider.profileId,
    provider.baseUrl,
    provider.model,
    provider.useExactRequestUrl,
  ]);
  const identity = `${options.bookId}:${options.sectionIndex}:${state.targetLang}:${options.contextEpoch}:${providerSignature}`;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const stateRef = useRef(state);
  stateRef.current = state;
  const ownerRef = useRef<ChapterOwner | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const exportCommitted = useRef(false);
  const activeIdentityRef = useRef(identity);
  activeIdentityRef.current = identity;
  const [retryEpoch, setRetryEpoch] = useState(0);

  const publish = useCallback(
    (owner: ChapterOwner, status: EpubTranslationStatus, error?: string) => {
      if (
        ownerRef.current !== owner ||
        owner.controller.signal.aborted ||
        owner.identity !== activeIdentityRef.current
      )
        return;
      setState((previous) => ({
        ...previous,
        status,
        translations: { ...owner.results },
        requested: owner.requested.size,
        completed: [...owner.requested].filter((id) => owner.results[id]).length,
        cached: owner.cached,
        error,
      }));
    },
    [],
  );

  const drain = useCallback(
    async (owner: ChapterOwner) => {
      if (owner.busy || owner.paused || owner.controller.signal.aborted) return;
      owner.busy = true;
      try {
        if (!owner.session) {
          const context = await optionsRef.current.prepareContext(
            stateRef.current.targetLang,
            owner.controller.signal,
            owner.blocks
              .map((block) => block.text)
              .join("\n")
              .slice(0, 4000),
            "",
            owner.sectionKey,
          );
          owner.session = {
            bookId: optionsRef.current.bookId,
            sectionKey: owner.sectionKey,
            targetLang: stateRef.current.targetLang,
            provider: { ...providerRef.current },
            context: context.status === "ready" ? context.serialized : "",
            contextDigest: context.digest || "none",
            signal: owner.controller.signal,
          };
        }
        while (owner.queue.size && !owner.controller.signal.aborted) {
          const ids = [...owner.queue];
          owner.queue.clear();
          const blocks = owner.blocks.filter(
            (block) => ids.includes(block.id) && !owner.results[block.id],
          );
          publish(owner, "processing");
          await translateEpubBlocks(blocks, owner.session, (result) => {
            if (
              owner.controller.signal.aborted ||
              ownerRef.current !== owner ||
              owner.identity !== activeIdentityRef.current
            )
              return;
            owner.results[result.id] = result.translation;
            if (result.cached) owner.cached++;
            publish(owner, "processing");
          });
        }
        publish(owner, "ready");
      } catch (error) {
        if (!owner.controller.signal.aborted) {
          owner.paused = true;
          publish(owner, "error", error instanceof Error ? error.message : String(error));
        }
      } finally {
        owner.busy = false;
      }
    },
    [publish],
  );

  const requestVisible = useCallback(
    (ids: string[]) => {
      const owner = ownerRef.current;
      if (
        !owner ||
        owner.paused ||
        owner.controller.signal.aborted ||
        owner.identity !== activeIdentityRef.current
      )
        return;
      const allowed = new Set(owner.blocks.map((block) => block.id));
      for (const id of ids) {
        if (!allowed.has(id)) continue;
        owner.requested.add(id);
        if (!owner.results[id]) owner.queue.add(id);
      }
      if (owner.queue.size) void drain(owner);
    },
    [drain],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scope and credentials changes must cancel the previous chapter owner.
  useEffect(() => {
    ownerRef.current?.controller.abort();
    ownerRef.current = null;
    if (!state.enabled || !options.supported) return;
    setState((previous) => ({
      ...emptyState,
      enabled: true,
      targetLang: previous.targetLang,
      status: "extracting",
    }));
    return () => {
      ownerRef.current?.controller.abort();
      ownerRef.current = null;
    };
  }, [identity, state.enabled, options.supported, provider.apiKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation and retry tokens trigger recapture without changing chapter identity.
  useEffect(() => {
    if (!state.enabled || !options.supported || !options.ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const capture = () => {
      if (cancelled) return;
      const source = optionsRef.current.getSource();
      if (!source) {
        if (attempts++ < 30) {
          timer = setTimeout(capture, 150);
          return;
        }
        setState((previous) => ({
          ...previous,
          status: "error",
          error: "当前 EPUB 页面尚未就绪，请重试。",
        }));
        return;
      }
      let owner = ownerRef.current;
      if (!owner || owner.source !== source.document || owner.identity !== identity) {
        owner?.controller.abort();
        const doc = cloneEpubForPreview(source.document);
        const blocks = collectEpubBlocks(doc);
        owner = {
          identity,
          source: source.document,
          sectionKey: source.sectionKey,
          document: doc,
          blocks,
          results: {},
          requested: new Set(),
          queue: new Set(),
          controller: new AbortController(),
          busy: false,
          paused: false,
          cached: 0,
        };
        ownerRef.current = owner;
        setState((previous) => ({
          ...previous,
          chapterKey: identity,
          document: doc,
          translations: {},
          requested: 0,
          completed: 0,
          cached: 0,
          error: undefined,
        }));
      }
      setState((previous) => ({
        ...previous,
        anchorId: source.visibleIds[0] ?? null,
        anchorRevision: previous.anchorRevision + 1,
      }));
      if (!source.visibleIds.length) publish(owner, "ready");
      else requestVisible(source.visibleIds);
    };
    timer = setTimeout(capture, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    identity,
    state.enabled,
    options.supported,
    options.ready,
    options.locationKey,
    requestVisible,
    publish,
    retryEpoch,
    provider.apiKey,
  ]);

  const start = useCallback((targetLang?: string) => {
    if (!optionsRef.current.supported) return;
    ownerRef.current?.controller.abort();
    ownerRef.current = null;
    setState({
      ...emptyState,
      enabled: true,
      targetLang: targetLang || useSettingsStore.getState().translationConfig.targetLang,
      status: "extracting",
    });
    setRetryEpoch((value) => value + 1);
  }, []);
  const retry = useCallback(() => {
    const owner = ownerRef.current;
    if (!owner) {
      start(stateRef.current.targetLang);
      return;
    }
    if (owner.controller.signal.aborted) {
      ownerRef.current = {
        ...owner,
        controller: new AbortController(),
        session: undefined,
        busy: false,
        paused: false,
        queue: new Set(),
      };
    }
    if (ownerRef.current) ownerRef.current.paused = false;
    requestVisible([...owner.requested]);
  }, [requestVisible, start]);
  const cancel = useCallback(() => {
    ownerRef.current?.controller.abort();
    setState((previous) => ({ ...previous, status: "cancelled" }));
  }, []);
  const exit = useCallback(() => {
    ownerRef.current?.controller.abort();
    if (!exportCommitted.current) exportController.current?.abort();
    ownerRef.current = null;
    setState(emptyState);
  }, []);

  const startExport = useCallback(() => setExport({ ...emptyExport, status: "confirming" }), []);
  const cancelExport = useCallback(() => {
    if (exportCommitted.current) return;
    exportController.current?.abort();
    if (!exportController.current) setExport(emptyExport);
  }, []);
  const confirmExport = useCallback(async () => {
    if (exportController.current) return;
    const captured = optionsRef.current;
    const lang = stateRef.current.targetLang;
    const model = { ...providerRef.current };
    const controller = new AbortController();
    let temporaryPath: string | null = null;
    exportCommitted.current = false;
    exportController.current = controller;
    setExport({ ...emptyExport, status: "processing", label: "读取原书" });
    try {
      const filename = `${captured.bookTitle.replace(/[<>:"/\\|?*]/g, "_") || "book"}-${lang}.epub`;
      const platform = getPlatformService();
      let destination: string | null = null;
      if (platform.isDesktop) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        destination = await save({
          defaultPath: filename,
          filters: [{ name: "EPUB", extensions: ["epub"] }],
        });
        if (!destination) {
          setExport(emptyExport);
          return;
        }
        if (captured.filePath) {
          const original = await resolveDesktopDataPath(captured.filePath);
          const normalize = (path: string) => path.replace(/\\/g, "/").toLocaleLowerCase();
          if (normalize(original) === normalize(destination))
            throw new Error("请选择与原书不同的文件名，原书会保留。");
        }
      }
      const source = await captured.getBookBlob();
      const blob = await exportEpubTranslation({
        source,
        targetLang: lang,
        signal: controller.signal,
        onProgress: (current, total, label) =>
          setExport({ status: "processing", current, total, label }),
        translateDocument: async (doc, sectionKey) => {
          const blocks = collectEpubBlocks(doc);
          if (!blocks.length) return;
          const context = await captured.prepareContext(
            lang,
            controller.signal,
            blocks
              .map((block) => block.text)
              .join("\n")
              .slice(0, 4000),
            "",
            sectionKey,
          );
          const completed = new Set<string>();
          await translateEpubBlocks(
            blocks,
            {
              bookId: captured.bookId,
              sectionKey,
              targetLang: lang,
              provider: model,
              context: context.status === "ready" ? context.serialized : "",
              contextDigest: context.digest || "none",
              signal: controller.signal,
            },
            (result) => {
              const block = blocks.find((item) => item.id === result.id);
              if (!block || !applyEpubTranslation(block, result.translation))
                throw new Error("导出段落结构校验失败。");
              completed.add(result.id);
            },
          );
          if (completed.size !== blocks.length)
            throw new Error("章节仍有未翻译内容，未生成不完整的整本译文。");
        },
      });
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (destination) {
        temporaryPath = `${destination}.readany-${crypto.randomUUID()}.tmp`;
        await platform.writeFile(temporaryPath, new Uint8Array(await blob.arrayBuffer()));
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        // Commit is an atomic rename. Cancellation remains effective until this point.
        exportCommitted.current = true;
        const { rename } = await import("@tauri-apps/plugin-fs");
        await rename(temporaryPath, destination);
        temporaryPath = null;
      } else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setExport((previous) => ({
        ...previous,
        status: "complete",
        destination: destination || filename,
      }));
    } catch (error) {
      setExport((previous) => ({
        ...previous,
        status: controller.signal.aborted ? "cancelled" : "error",
        error: controller.signal.aborted
          ? undefined
          : error instanceof Error
            ? error.message
            : String(error),
      }));
    } finally {
      if (temporaryPath)
        await getPlatformService()
          .deleteFile(temporaryPath)
          .catch(() => {});
      exportCommitted.current = false;
      if (exportController.current === controller) exportController.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      ownerRef.current?.controller.abort();
      exportController.current?.abort();
    },
    [],
  );
  return {
    state,
    provider,
    start,
    retry,
    cancel,
    exit,
    requestVisible,
    bookExport,
    startExport,
    confirmExport,
    cancelExport,
  };
}
