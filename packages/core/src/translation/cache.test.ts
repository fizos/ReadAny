import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "../services/platform";
import { setPlatformService } from "../services/platform";
import { getFromCache, storeInCache } from "./cache";

function createPlatform(): IPlatformService {
  const values = new Map<string, string>();
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
    fetch: vi.fn(),
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

describe("translation cache provider identity", () => {
  it("does not reuse an AI result for a different endpoint, model, or URL mode", async () => {
    setPlatformService(createPlatform());
    const endpointA = {
      baseUrl: "https://provider-a.example/v1",
      model: "model-a",
      useExactRequestUrl: false,
    };

    await storeInCache("hello", "你好", "AUTO", "zh-CN", "ai", endpointA);

    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...endpointA,
        baseUrl: "https://provider-b.example/v1",
      }),
    ).resolves.toBeNull();
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", { ...endpointA, model: "model-b" }),
    ).resolves.toBeNull();
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...endpointA,
        useExactRequestUrl: true,
      }),
    ).resolves.toBeNull();
  });

  it("reuses an AI result for the same configuration and keeps non-AI keys reusable", async () => {
    setPlatformService(createPlatform());
    const config = {
      baseUrl: "https://provider.example/v1/",
      model: "model-a",
      useExactRequestUrl: false,
    };

    await storeInCache("hello", "你好", "AUTO", "zh-CN", "ai", config);
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...config,
        baseUrl: "https://provider.example/v1",
      }),
    ).resolves.toBe("你好");

    await storeInCache("hello", "你好", "AUTO", "zh-CN", "deepl", {
      baseUrl: "https://deepl-a.example",
    });
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "deepl", {
        baseUrl: "https://deepl-b.example",
      }),
    ).resolves.toBe("你好");
  });

  it("reuses an AI result only for the same book-context digest", async () => {
    setPlatformService(createPlatform());
    const baseConfig = {
      baseUrl: "https://provider.example/v1",
      model: "model-a",
      contextMode: "book-v1" as const,
    };

    await storeInCache("hello", "你好", "AUTO", "zh-CN", "ai", {
      ...baseConfig,
      contextDigest: "book-a-revision-1",
    });

    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...baseConfig,
        contextDigest: "book-a-revision-1",
      }),
    ).resolves.toBe("你好");
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...baseConfig,
        contextDigest: "book-b-revision-1",
      }),
    ).resolves.toBeNull();
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...baseConfig,
        contextDigest: "book-a-revision-2",
      }),
    ).resolves.toBeNull();
    await expect(
      getFromCache("hello", "AUTO", "zh-CN", "ai", {
        ...baseConfig,
        contextDigest: "none",
        contextMode: "none",
      }),
    ).resolves.toBeNull();
  });
});
