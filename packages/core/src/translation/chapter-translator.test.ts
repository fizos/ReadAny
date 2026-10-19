import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "../services/platform";
import { setPlatformService } from "../services/platform";
import type { ContextSnapshot } from "./book-context";
import { translateChapter } from "./chapter-translator";

function createPlatform(
  fetchImpl: IPlatformService["fetch"],
  values = new Map<string, string>(),
): IPlatformService {
  return {
    platformType: "desktop",
    isMobile: false,
    isDesktop: true,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    writeTextFile: vi.fn(),
    readTextFile: vi.fn(),
    mkdir: vi.fn(),
    exists: vi.fn(),
    deleteFile: vi.fn(),
    getAppDataDir: vi.fn(),
    getDataDir: vi.fn(),
    joinPath: vi.fn(),
    convertFileSrc: vi.fn(),
    pickFile: vi.fn(),
    loadDatabase: vi.fn(),
    fetch: fetchImpl,
    createWebSocket: vi.fn(),
    getAppVersion: vi.fn(),
    kvGetItem: vi.fn(async (key: string) => values.get(key) ?? null),
    kvSetItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    kvRemoveItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
    kvGetAllKeys: vi.fn(async () => [...values.keys()]),
    copyToClipboard: vi.fn(),
    shareOrDownloadFile: vi.fn(),
  };
}

afterEach(() => {
  setPlatformService(null as unknown as IPlatformService);
});

describe("translateChapter cancellation", () => {
  it("passes its AbortSignal to an in-flight provider fetch", async () => {
    let requestSignal: AbortSignal | undefined;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const fetchImpl = vi.fn<IPlatformService["fetch"]>(async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      resolveStarted();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectAborted = () =>
          reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal?.aborted) {
          rejectAborted();
        } else {
          signal?.addEventListener("abort", rejectAborted, { once: true });
        }
      });
    });
    setPlatformService(createPlatform(fetchImpl));

    const controller = new AbortController();
    const translation = translateChapter({
      paragraphs: [{ id: "p1", text: "hello", tagName: "p" }],
      sourceLang: "AUTO",
      targetLang: "zh-CN",
      config: {
        provider: {
          id: "ai",
          name: "AI",
          baseUrl: "https://provider.example/v1",
          model: "model-a",
        },
        targetLang: "zh-CN",
      },
      signal: controller.signal,
      concurrency: 1,
    });

    await started;
    controller.abort();

    await expect(translation).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal).toBe(controller.signal);
  });
});

describe("translateChapter book context", () => {
  const config = {
    provider: {
      id: "ai" as const,
      name: "AI",
      baseUrl: "https://provider.example/v1",
      model: "model-a",
    },
    targetLang: "zh-CN" as const,
  };
  const paragraph = [{ id: "p1", text: "Widget protocol", tagName: "p" }];

  function snapshot(
    digest: string,
    serialized: string,
    status: ContextSnapshot["status"] = "ready",
  ): ContextSnapshot {
    return {
      status,
      revision: digest,
      epoch: 0,
      serialized,
      digest,
    };
  }

  it("passes a ready snapshot to the AI prompt and reuses the same snapshot cache", async () => {
    const values = new Map<string, string>();
    const fetchImpl = vi.fn<IPlatformService["fetch"]>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(request.messages[0].content).toContain('{"bookId":"book-a"');
      return Response.json({ choices: [{ message: { content: "协议" } }] });
    });
    setPlatformService(createPlatform(fetchImpl, values));
    const context = snapshot("book-a-revision-1", '{"bookId":"book-a","revision":"r1"}');

    await expect(
      translateChapter({
        paragraphs: paragraph,
        sourceLang: "AUTO",
        targetLang: "zh-CN",
        config,
        context,
        concurrency: 1,
      }),
    ).resolves.toEqual([
      { paragraphId: "p1", originalText: "Widget protocol", translatedText: "协议" },
    ]);
    await vi.waitFor(() => expect(values.size).toBeGreaterThan(0));

    await translateChapter({
      paragraphs: paragraph,
      sourceLang: "AUTO",
      targetLang: "zh-CN",
      config,
      context,
      concurrency: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retranslates when the snapshot changes and disabled context does not reuse it", async () => {
    const values = new Map<string, string>();
    const prompts: string[] = [];
    const fetchImpl = vi.fn<IPlatformService["fetch"]>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      prompts.push(request.messages[0].content);
      return Response.json({ choices: [{ message: { content: "协议" } }] });
    });
    setPlatformService(createPlatform(fetchImpl, values));
    const first = snapshot("book-a-revision-1", '{"bookId":"book-a","revision":"r1"}');
    const changed = snapshot("book-a-revision-2", '{"bookId":"book-a","revision":"r2"}');
    const disabled = snapshot("none", "", "disabled");

    await translateChapter({
      paragraphs: paragraph,
      sourceLang: "AUTO",
      targetLang: "zh-CN",
      config,
      context: first,
      concurrency: 1,
    });
    await vi.waitFor(() => expect(values.size).toBeGreaterThan(0));
    await translateChapter({
      paragraphs: paragraph,
      sourceLang: "AUTO",
      targetLang: "zh-CN",
      config,
      context: changed,
      concurrency: 1,
    });
    await vi.waitFor(() => expect(values.size).toBeGreaterThan(1));
    await translateChapter({
      paragraphs: paragraph,
      sourceLang: "AUTO",
      targetLang: "zh-CN",
      config,
      context: disabled,
      concurrency: 1,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(prompts[0]).toContain(
      '<book_context_json>{"bookId":"book-a","revision":"r1"}</book_context_json>',
    );
    expect(prompts[1]).toContain(
      '<book_context_json>{"bookId":"book-a","revision":"r2"}</book_context_json>',
    );
    expect(prompts[2]).not.toContain("book_context_json");
  });
});
