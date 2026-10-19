import { describe, expect, it } from "vitest";
import {
  buildHighFidelityPdfRequestKey,
  highFidelityPdfReducer,
  initialHighFidelityPdfState,
  resolveHighFidelityPdfProvider,
  getPdfProviderDisplay,
} from "./high-fidelity-pdf";

const provider = {
  profileId: "endpoint-a",
  profileLabel: "Local AI",
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "secret",
  model: "model-a",
  useExactRequestUrl: false,
  usesActiveAiEndpoint: false,
};

describe("high-fidelity PDF request identity", () => {
  it("changes when the page, target, model, profile, or URL changes", () => {
    const base = buildHighFidelityPdfRequestKey("book", 2, "zh-CN", provider);
    expect(buildHighFidelityPdfRequestKey("book", 2, "zh-CN", provider, "new-profile")).not.toBe(base);
    expect(buildHighFidelityPdfRequestKey("book", 3, "zh-CN", provider)).not.toBe(base);
    expect(buildHighFidelityPdfRequestKey("book", 2, "ja", provider)).not.toBe(base);
    expect(
      buildHighFidelityPdfRequestKey("book", 2, "zh-CN", { ...provider, model: "model-b" }),
    ).not.toBe(base);
    expect(
      buildHighFidelityPdfRequestKey("book", 2, "zh-CN", { ...provider, profileId: "endpoint-b" }),
    ).not.toBe(base);
    expect(
      buildHighFidelityPdfRequestKey("book", 2, "zh-CN", {
        ...provider,
        baseUrl: "http://localhost",
      }),
    ).not.toBe(base);
  });
});

describe("high-fidelity PDF reducer", () => {
  it("snapshots public model selection and clears progress for the next page", () => {
    const display = getPdfProviderDisplay(provider);
    expect(Object.keys(display).sort()).toEqual(["model", "profileLabel", "usesActiveAiEndpoint"]);
    const started = highFidelityPdfReducer(initialHighFidelityPdfState, {
      type: "translating", jobId: "a", requestKey: "a", page: 1, targetLang: "ZH",
      phase: "starting", startedAt: 1, provider: display,
    });
    const progressing = highFidelityPdfReducer(started, {
      type: "progress", jobId: "a", phase: "translating",
      progress: { stage: "translate", current: 2, total: 5, requestsStarted: 3, requestsCompleted: 2 },
    });
    expect(progressing.progress?.current).toBe(2);
    expect(progressing.provider?.model).toBe("model-a");
    const next = highFidelityPdfReducer(progressing, { type: "page-change", requestKey: "b", page: 2, targetLang: "ZH" });
    expect(next.progress).toBeUndefined();
    expect(next.provider).toBeUndefined();
    expect(highFidelityPdfReducer(next, {type:"progress", jobId:"a", phase:"saving", progress:{current:5,total:5}})).toEqual(next);
  });

  it("honors the selected translation endpoint and model rather than the chat model", () => {
    const result = resolveHighFidelityPdfProvider(
      { provider: { id:"ai", name:"AI", endpointId:"translate", model:"translation-model" }, targetLang:"zh-CN" },
      { endpoints:[{id:"translate", name:"Translator", baseUrl:"https://example.test/v1", apiKey:"key", provider:"custom", models:[], modelsFetched:true}],
        activeEndpointId:"chat", activeModel:"chat-model", temperature:0.7, maxTokens:100, slidingWindowSize:8 },
    );
    expect(result.profileId).toBe("translate");
    expect(result.model).toBe("translation-model");
    expect(result.usesActiveAiEndpoint).toBe(false);
  });
  it("clears an old page immediately and rejects its late completion", () => {
    const old = { ...initialHighFidelityPdfState, enabled: true, jobId: "old", pdfBase64: "old-pdf" };
    const changed = highFidelityPdfReducer(old, {
      type: "page-change", requestKey: "page-2", page: 2, targetLang: "ZH",
    });
    expect(changed.page).toBe(2);
    expect(changed.pdfBase64).toBeUndefined();
    expect(highFidelityPdfReducer(changed, {
      type: "complete", jobId: "old", page: 1, requestKey: "page-1", targetLang: "ZH", pdfBase64: "stale",
    })).toEqual(changed);
  });
  it("ignores stale progress and completion from a replaced job", () => {
    const active = highFidelityPdfReducer(initialHighFidelityPdfState, {
      type: "translating",
      jobId: "new-job",
      requestKey: "new-key",
      page: 3,
      targetLang: "zh-CN",
      phase: "translating",
      startedAt: 1,
    });
    const staleProgress = highFidelityPdfReducer(active, {
      type: "progress",
      jobId: "old-job",
      phase: "saving",
    });
    const staleComplete = highFidelityPdfReducer(staleProgress, {
      type: "complete",
      jobId: "old-job",
      page: 2,
      requestKey: "old-key",
      targetLang: "zh-CN",
      pdfBase64: "old",
    });
    expect(staleProgress).toEqual(active);
    expect(staleComplete).toEqual(active);
  });

  it("settles cancellation visibly and clears the old result", () => {
    const complete = highFidelityPdfReducer(
      highFidelityPdfReducer(initialHighFidelityPdfState, {
        type: "translating",
        jobId: "job",
        requestKey: "key",
        page: 1,
        targetLang: "zh-CN",
        phase: "saving",
        startedAt: 1,
      }),
      {
        type: "complete",
        jobId: "job",
        page: 1,
        requestKey: "key",
        targetLang: "zh-CN",
        cached: true,
        pdfBase64: "pdf",
      },
    );
    const cancelled = highFidelityPdfReducer(complete, { type: "cancelled" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.enabled).toBe(true);
    expect(cancelled.pdfBase64).toBeUndefined();
  });

  it("uses the active AI endpoint when quick translation is configured as free", () => {
    const resolved = resolveHighFidelityPdfProvider(
      { provider: { id: "microsoft", name: "free" }, targetLang: "zh-CN" },
      {
        endpoints: [
          {
            id: "active",
            name: "Configured AI",
            provider: "custom",
            apiKey: "key",
            baseUrl: "https://example.test/v1",
            models: [],
            modelsFetched: true,
          },
        ],
        activeEndpointId: "active",
        activeModel: "chat-model",
        temperature: 0.7,
        maxTokens: 100,
        slidingWindowSize: 8,
      },
    );
    expect(resolved.usesActiveAiEndpoint).toBe(true);
    expect(resolved.profileId).toBe("active");
    expect(resolved.model).toBe("chat-model");
  });
});
