import { describe, expect, it } from "vitest";
import { parseBookGlossary } from "./BookTranslationProfileDialog";

describe("book glossary editor", () => {
  it("retains unchanged automatic terms and marks changes as manual", () => {
    expect(parseBookGlossary("token = 词元\ncache = 缓存", [
      { source: "token", target: "词元", origin: "auto" },
      { source: "cache", target: "高速缓存", origin: "auto" },
    ])).toEqual([
      { source: "token", target: "词元", origin: "auto" },
      { source: "cache", target: "缓存", origin: "manual" },
    ]);
  });
  it("rejects malformed, duplicate and oversized rows without silently dropping input", () => {
    expect(() => parseBookGlossary("token", [])).toThrow();
    expect(() => parseBookGlossary("token=", [])).toThrow();
    expect(() => parseBookGlossary("Token=词元\ntoken=标记", [])).toThrow();
    expect(() => parseBookGlossary(`${"x".repeat(101)}=词`, [])).toThrow();
    expect(() => parseBookGlossary(Array.from({ length: 101 }, (_, i) => `term${i}=词`).join("\n"), [])).toThrow();
    expect(parseBookGlossary("  \n ", [])).toEqual([]);
  });
});
