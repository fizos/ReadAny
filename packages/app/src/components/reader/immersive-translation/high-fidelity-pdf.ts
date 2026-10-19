import type { AIConfig, TranslationConfig } from "@readany/core";

export type HighFidelityPdfStatus =
  | "idle"
  | "needs-setup"
  | "installing"
  | "translating"
  | "complete"
  | "cancelled"
  | "error";

export type PdfEnginePhase =
  | "starting"
  | "preparing"
  | "installing"
  | "assets"
  | "extracting"
  | "layout"
  | "translating"
  | "typesetting"
  | "saving"
  | "cache"
  | "complete"
  | "cancelled"
  | "error"
  | string;

export interface HighFidelityPdfState {
  enabled: boolean;
  status: HighFidelityPdfStatus;
  jobId: string | null;
  requestKey: string | null;
  page: number | null;
  targetLang: string;
  phase: PdfEnginePhase;
  error?: string;
  cached?: boolean;
  /** Base64 PDF returned by the native boundary (at most 20 MiB). */
  pdfBase64?: string;
  engineReady: boolean | null;
  startedAt: number | null;
  progress?: PdfEngineProgress;
  /** Public, immutable selection used for this job; never store credentials here. */
  provider?: PdfProviderDisplay;
}

export interface PdfEngineProgress {
  stage?: string;
  current?: number;
  total?: number;
  requestsStarted?: number;
  requestsCompleted?: number;
  receivedBytes?: number;
  bookCurrent?: number;
  bookTotal?: number;
}

export interface PdfExportPlan {
  totalPages: number;
  cachedPages: number;
  missingPages: number;
  nonTextPages: number;
  warnings?: string[];
}

export interface PdfExportSaveResult {
  destinationPath: string;
  bytes: number;
  sha256: string;
  warnings?: string[];
}

export type PdfPrefetchStatus = "idle" | "processing" | "ready" | "error";

export interface PdfPrefetchState {
  status: PdfPrefetchStatus;
  page: number | null;
  error?: string;
}

export type PdfBookExportStatus =
  | "idle"
  | "planning"
  | "confirming"
  | "exporting"
  | "complete"
  | "cancelled"
  | "error";

export interface PdfBookExportState {
  status: PdfBookExportStatus;
  destinationPath?: string;
  plan?: PdfExportPlan;
  current?: number;
  total?: number;
  error?: string;
  warnings?: string[];
}

export type PdfProviderDisplay = Pick<HighFidelityPdfProvider,
  "profileLabel" | "model" | "usesActiveAiEndpoint">;

export function getPdfProviderDisplay(provider: HighFidelityPdfProvider): PdfProviderDisplay {
  return { profileLabel: provider.profileLabel, model: provider.model,
    usesActiveAiEndpoint: provider.usesActiveAiEndpoint };
}

export interface HighFidelityPdfProvider {
  profileId: string;
  profileLabel: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  useExactRequestUrl: boolean;
  /** True when the normal quick translator was configured to a non-AI provider. */
  usesActiveAiEndpoint: boolean;
}

export interface PdfEngineRequest {
  jobId: string;
  action: "setup" | "translate" | "plan-export" | "export";
  filePath?: string;
  page?: number;
  targetLang?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  profileId?: string;
  useExactRequestUrl?: boolean;
  force?: boolean;
  translationContext?: string;
}

export interface PdfEngineStatusResponse {
  jobId: string;
  status: "running" | "complete" | "error" | "cancelled";
  phase: PdfEnginePhase;
  error?: string;
  cached?: boolean;
  progress?: PdfEngineProgress;
}

export const initialHighFidelityPdfState: HighFidelityPdfState = {
  enabled: false,
  status: "idle",
  jobId: null,
  requestKey: null,
  page: null,
  targetLang: "",
  phase: "starting",
  engineReady: null,
  startedAt: null,
};

export function buildHighFidelityPdfRequestKey(
  bookId: string,
  page: number,
  targetLang: string,
  provider: Pick<HighFidelityPdfProvider, "profileId" | "model" | "baseUrl" | "useExactRequestUrl">,
  contextIdentity = "none",
): string {
  return [
    bookId,
    String(Math.max(1, page)),
    targetLang,
    provider.profileId,
    provider.model,
    provider.baseUrl,
    String(provider.useExactRequestUrl),
    contextIdentity,
  ].join("|");
}

/** Resolve the AI chat endpoint required by the high-fidelity engine. */
export function resolveHighFidelityPdfProvider(
  translationConfig: TranslationConfig,
  aiConfig: AIConfig,
): HighFidelityPdfProvider {
  const usesActiveAiEndpoint = translationConfig.provider.id !== "ai";
  const profileId = usesActiveAiEndpoint
    ? aiConfig.activeEndpointId
    : translationConfig.provider.endpointId || aiConfig.activeEndpointId;
  const endpoint = aiConfig.endpoints.find((item) => item.id === profileId);

  return {
    profileId,
    profileLabel: endpoint?.name || profileId || "AI endpoint",
    baseUrl: endpoint?.baseUrl || "",
    apiKey: endpoint?.apiKey || "",
    model:
      translationConfig.provider.id === "ai"
        ? translationConfig.provider.model || aiConfig.activeModel
        : aiConfig.activeModel,
    useExactRequestUrl: Boolean(
      endpoint?.useExactRequestUrl ?? translationConfig.provider.useExactRequestUrl,
    ),
    usesActiveAiEndpoint,
  };
}

export type HighFidelityPdfAction =
  | { type: "context"; requestKey: string; page: number; targetLang: string; provider: PdfProviderDisplay }
  | {
      type: "activate";
      requestKey: string;
      page: number;
      targetLang: string;
      engineReady: boolean;
    }
  | { type: "needs-setup"; requestKey: string; page: number; targetLang: string }
  | { type: "page-change"; requestKey: string; page: number; targetLang: string }
  | { type: "installing"; jobId: string; phase: PdfEnginePhase; startedAt: number }
  | {
      type: "translating";
      jobId: string;
      requestKey: string;
      page: number;
      targetLang: string;
      phase: PdfEnginePhase;
      startedAt: number;
      provider?: PdfProviderDisplay;
    }
  | { type: "progress"; jobId: string; phase: PdfEnginePhase; progress?: PdfEngineProgress }
  | {
      type: "complete";
      jobId: string;
      page: number;
      requestKey: string;
      targetLang: string;
      cached?: boolean;
      pdfBase64?: string;
    }
  | {
      type: "cancelled";
      jobId?: string;
      requestKey?: string;
      page?: number;
      targetLang?: string;
    }
  | { type: "error"; jobId?: string; error: string }
  | { type: "exit" };

export function highFidelityPdfReducer(
  state: HighFidelityPdfState,
  action: HighFidelityPdfAction,
): HighFidelityPdfState {
  switch (action.type) {
    case "context":
      return { ...state, enabled: true, status: "translating", phase: "context", jobId: null,
        requestKey: action.requestKey, page: action.page, targetLang: action.targetLang,
        provider: action.provider, progress: undefined, error: undefined, pdfBase64: undefined,
        startedAt: Date.now() };
    case "activate":
      return {
        ...state,
        enabled: true,
        status: action.engineReady ? "translating" : "needs-setup",
        progress: undefined,
        provider: undefined,
        cached: undefined,
        requestKey: action.requestKey,
        page: action.page,
        targetLang: action.targetLang,
        engineReady: action.engineReady,
        error: undefined,
        pdfBase64: undefined,
        jobId: null,
        startedAt: action.engineReady ? state.startedAt : null,
      };
    case "needs-setup":
      return {
        ...state,
        enabled: true,
        status: "needs-setup",
        progress: undefined,
        provider: undefined,
        cached: undefined,
        requestKey: action.requestKey,
        page: action.page,
        targetLang: action.targetLang,
        engineReady: false,
        jobId: null,
        phase: "preparing",
        error: undefined,
        pdfBase64: undefined,
        startedAt: null,
      };
    case "page-change":
      return {
        ...state,
        enabled: true,
        status: "cancelled",
        progress: undefined,
        provider: undefined,
        requestKey: action.requestKey,
        page: action.page,
        targetLang: action.targetLang,
        jobId: null,
        phase: "cancelled",
        error: undefined,
        cached: undefined,
        pdfBase64: undefined,
        startedAt: null,
      };
    case "installing":
      return {
        ...state,
        enabled: true,
        status: "installing",
        progress: undefined,
        provider: undefined,
        cached: undefined,
        jobId: action.jobId,
        phase: action.phase,
        error: undefined,
        startedAt: action.startedAt,
      };
    case "translating":
      return {
        ...state,
        enabled: true,
        status: "translating",
        progress: undefined,
        provider: action.provider,
        cached: undefined,
        jobId: action.jobId,
        requestKey: action.requestKey,
        page: action.page,
        targetLang: action.targetLang,
        phase: action.phase,
        error: undefined,
        pdfBase64: undefined,
        startedAt: action.startedAt,
      };
    case "progress":
      if (state.jobId !== action.jobId || !state.enabled ||
          (state.status !== "installing" && state.status !== "translating")) return state;
      return { ...state, phase: action.phase, progress: action.progress };
    case "complete":
      if (state.jobId !== action.jobId || !state.enabled) return state;
      return {
        ...state,
        status: "complete",
        jobId: null,
        page: action.page,
        requestKey: action.requestKey,
        targetLang: action.targetLang,
        phase: "complete",
        cached: action.cached,
        pdfBase64: action.pdfBase64,
        error: undefined,
      };
    case "cancelled":
      if (action.jobId && state.jobId !== action.jobId) return state;
      return {
        ...state,
        enabled: true,
        status: "cancelled",
        jobId: null,
        requestKey: action.requestKey ?? state.requestKey,
        page: action.page ?? state.page,
        targetLang: action.targetLang ?? state.targetLang,
        phase: "cancelled",
        startedAt: null,
        pdfBase64: undefined,
      };
    case "error":
      if (action.jobId && state.jobId !== action.jobId) return state;
      return {
        ...state,
        enabled: true,
        status: "error",
        jobId: null,
        phase: "error",
        error: action.error,
        startedAt: null,
      };
    case "exit":
      return { ...initialHighFidelityPdfState };
    default:
      return state;
  }
}
