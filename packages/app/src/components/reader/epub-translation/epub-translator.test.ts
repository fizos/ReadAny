import { describe, expect, it } from "vitest";
import {
  type EpubTranslationSession,
  epubCacheIdentity,
  parseEpubBatchResponse,
} from "./epub-translator";

describe("EPUB fidelity translation response boundary", () => {
  it("rejects omitted, duplicated and unexpected paragraphs rather than claiming a full page", () => {
    expect(() =>
      parseEpubBatchResponse('{"translations":[{"id":"a","text":"译文"}]}', ["a", "b"]),
    ).toThrow("部分段落");
    expect(() =>
      parseEpubBatchResponse(
        '{"translations":[{"id":"a","text":"译文"},{"id":"a","text":"重复"}]}',
        ["a", "b"],
      ),
    ).toThrow("重复");
    expect(() =>
      parseEpubBatchResponse('{"translations":[{"id":"x","text":"译文"}]}', ["a"]),
    ).toThrow("无效");
  });
  it("maps out-of-order responses by stable id", () => {
    const result = parseEpubBatchResponse(
      '```json\n{"translations":[{"id":"b","text":"乙"},{"id":"a","text":"甲"}]}\n```',
      ["a", "b"],
    );
    expect(result.get("a")).toBe("甲");
    expect(result.get("b")).toBe("乙");
  });
  it("versions result identity by source, language, model and book context without credentials", () => {
    const session: EpubTranslationSession = {
      bookId: "book",
      sectionKey: "EPUB/ch1.xhtml",
      targetLang: "zh-CN",
      context: "reference",
      contextDigest: "context-v1",
      signal: new AbortController().signal,
      provider: {
        profileId: "test",
        profileLabel: "Test",
        baseUrl: "https://example.com/v1",
        model: "test-model",
        apiKey: "SECRET-NOT-STORED",
        useExactRequestUrl: false,
        usesActiveAiEndpoint: false,
      },
    };
    const identity = epubCacheIdentity(session, "[[R0]]source[[/R0]]");
    expect(identity).not.toContain(session.provider.apiKey);
    expect(identity).not.toContain(session.context);
    expect(identity).not.toBe(
      epubCacheIdentity({ ...session, targetLang: "ja" }, "[[R0]]source[[/R0]]"),
    );
    expect(identity).not.toBe(
      epubCacheIdentity({ ...session, contextDigest: "context-v2" }, "[[R0]]source[[/R0]]"),
    );
    expect(identity).not.toBe(
      epubCacheIdentity(
        { ...session, provider: { ...session.provider, model: "other" } },
        "[[R0]]source[[/R0]]",
      ),
    );
    expect(identity).not.toBe(epubCacheIdentity(session, "[[R0]]changed[[/R0]]"));
  });
});
