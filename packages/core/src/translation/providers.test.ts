import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "../services/platform";
import { setPlatformService } from "../services/platform";
import {
  aiTranslate,
  buildAITranslationPrompt,
  microsoftTranslate,
  toMicrosoftLangCode,
} from "./providers";

function createPlatform(fetchImpl: IPlatformService["fetch"]): IPlatformService {
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
    kvGetItem: vi.fn(),
    kvSetItem: vi.fn(),
    kvRemoveItem: vi.fn(),
    kvGetAllKeys: vi.fn(),
    copyToClipboard: vi.fn(),
    shareOrDownloadFile: vi.fn(),
  };
}

afterEach(() => {
  setPlatformService(null as unknown as IPlatformService);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AI translator transport", () => {
  it("uses platform fetch instead of browser fetch for OpenAI-compatible translation", async () => {
    const platformFetch = vi.fn<IPlatformService["fetch"]>(async function (this: IPlatformService) {
      expect(this).toBe(platform);
      return Response.json({ choices: [{ message: { content: "你好" } }] });
    });
    const platform = createPlatform(platformFetch);
    const browserFetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", browserFetch);
    setPlatformService(platform);

    await expect(
      aiTranslate(
        ["hello"],
        "AUTO",
        "zh-CN",
        "test-key",
        "https://api.example.test/v1",
        "test-model",
      ),
    ).resolves.toEqual(["你好"]);

    expect(platformFetch).toHaveBeenCalledWith(
      "https://api.example.test/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-key",
        },
      }),
    );
    const request = JSON.parse(String(platformFetch.mock.calls[0][1]?.body));
    expect(request.stream).toBe(false);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("accepts OpenAI-compatible SSE responses returned by custom providers", async () => {
    const platformFetch = vi.fn<IPlatformService["fetch"]>(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"你"}}]}',
            'data: {"choices":[{"delta":{"content":"好"}}]}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    setPlatformService(createPlatform(platformFetch));

    await expect(
      aiTranslate(
        ["hello"],
        "AUTO",
        "zh-CN",
        "test-key",
        "https://api.example.test/v1",
        "test-model",
      ),
    ).resolves.toEqual(["你好"]);
  });
});

describe("buildAITranslationPrompt", () => {
  it("asks AI to translate classical Chinese into modern vernacular Chinese", () => {
    const prompt = buildAITranslationPrompt("AUTO", "zh-CN");

    expect(prompt).toContain("Classical/Literary Chinese");
    expect(prompt).toContain("modern vernacular Simplified Chinese");
    expect(prompt).toContain("学而不思则罔，思而不学则殆");
    expect(prompt).toContain("not the original sentence");
    expect(prompt).toContain("Do not mention source, author, title");
    expect(prompt).toContain("most likely modern meaning in context");
  });

  it("keeps numbered output requirements for batch translation", () => {
    const prompt = buildAITranslationPrompt("AUTO", "zh-CN", { numbered: true });

    expect(prompt).toContain('keep the same numbering format "N. translation"');
    expect(prompt).toContain("Do not add any explanation");
  });
});

describe("Microsoft translator", () => {
  it("normalizes Chinese language variants to Microsoft script codes", () => {
    expect(toMicrosoftLangCode("zh-CN")).toBe("zh-Hans");
    expect(toMicrosoftLangCode("zh-cn")).toBe("zh-Hans");
    expect(toMicrosoftLangCode("zh_Hans")).toBe("zh-Hans");
    expect(toMicrosoftLangCode("zh")).toBe("zh-Hans");
    expect(toMicrosoftLangCode("zh-TW")).toBe("zh-Hant");
    expect(toMicrosoftLangCode("zh_hant")).toBe("zh-Hant");
    expect(toMicrosoftLangCode("ja")).toBe("ja");
  });

  it("requests Simplified Chinese without an empty source language parameter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("token"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ translations: [{ text: "你好" }] }]), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(microsoftTranslate(["hello"], "AUTO", "zh_Hans")).resolves.toEqual(["你好"]);

    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const requestUrl = new URL(url);
    expect(requestUrl.searchParams.get("api-version")).toBe("3.0");
    expect(requestUrl.searchParams.get("to")).toBe("zh-Hans");
    expect(requestUrl.searchParams.has("from")).toBe(false);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer token",
    });
    expect(init.body).toBe(JSON.stringify([{ Text: "hello" }]));
  });
});
