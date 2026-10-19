import type { ChapterTranslationResult } from "@readany/core/translation";
import { describe, expect, it } from "vitest";
import type { ImmersiveSourceSnapshot } from "./types";
import {
  buildImmersiveRequestKey,
  buildImmersiveTranslationParagraphs,
  immersiveTranslationReducer,
  initialImmersiveTranslationState,
  shouldScheduleImmersiveAutoRun,
} from "./useImmersiveTranslation";

const snapshot = (fingerprint = "source-a"): ImmersiveSourceSnapshot => ({
  kind: "epub",
  bookId: "book-1",
  sectionIndex: 2,
  pageKey: "section-2",
  fingerprint,
  expectedBlockIds: ["a", "b"],
  blocks: [
    { kind: "epub", contentKind: "prose", id: "a", text: "same", tagName: "p", sourceIndex: 0 },
    { kind: "epub", contentKind: "prose", id: "b", text: "same", tagName: "p", sourceIndex: 1 },
  ],
});

const result = (paragraphId: string, translatedText: string): ChapterTranslationResult => ({
  paragraphId,
  originalText: "same",
  translatedText,
});

function sourcedState(runId = 1) {
  const begun = immersiveTranslationReducer(initialImmersiveTranslationState, {
    type: "begin",
    runId,
    requestKey: "book-1:2:ZH",
    targetLang: "ZH",
  });
  return immersiveTranslationReducer(begun, { type: "source", runId, snapshot: snapshot() });
}

describe("immersiveTranslationReducer", () => {
  it("filters code at the execute request boundary", () => {
    const source: ImmersiveSourceSnapshot = {
      ...snapshot(),
      expectedBlockIds: ["prose", "code"],
      blocks: [
        {
          kind: "epub",
          contentKind: "prose",
          id: "prose",
          text: "translate me",
          tagName: "p",
          sourceIndex: 0,
        },
        {
          kind: "epub",
          contentKind: "code",
          id: "code",
          text: "const x = 1;",
          tagName: "pre",
          sourceIndex: 1,
        },
      ],
    };
    expect(buildImmersiveTranslationParagraphs(source)).toEqual([
      { id: "prose", text: "translate me", tagName: "p" },
    ]);
    const state = immersiveTranslationReducer(
      immersiveTranslationReducer(initialImmersiveTranslationState, {
        type: "begin",
        runId: 1,
        requestKey: "book:0:page:ZH",
        targetLang: "ZH",
      }),
      { type: "source", runId: 1, snapshot: source },
    );
    expect(state.snapshot?.expectedBlockIds).toEqual(["prose"]);
    expect(state.progress.totalChars).toBe("translate me".length);
  });

  it("completes from prose results while code-only blocks do not affect progress", () => {
    const source: ImmersiveSourceSnapshot = {
      ...snapshot(),
      expectedBlockIds: ["prose"],
      blocks: [
        {
          kind: "epub",
          contentKind: "prose",
          id: "prose",
          text: "translate me",
          tagName: "p",
          sourceIndex: 0,
        },
        {
          kind: "epub",
          contentKind: "code",
          id: "code",
          text: "const x = 1;",
          tagName: "pre",
          sourceIndex: 1,
        },
      ],
    };
    const begun = immersiveTranslationReducer(initialImmersiveTranslationState, {
      type: "begin",
      runId: 1,
      requestKey: "book:0:page:ZH",
      targetLang: "ZH",
    });
    const current = immersiveTranslationReducer(begun, {
      type: "source",
      runId: 1,
      snapshot: source,
    });
    const finished = immersiveTranslationReducer(current, {
      type: "finish",
      runId: 1,
      fingerprint: source.fingerprint,
      results: [result("prose", "translated")],
    });
    expect(finished.status).toBe("complete");
    expect(finished.progress.totalChars).toBe("translate me".length);
    expect(finished.progress.translatedChars).toBe("translate me".length);
  });

  it("uses the visible location in the request identity", () => {
    expect(buildImmersiveRequestKey("book", 2, "page-3", "ZH")).not.toBe(
      buildImmersiveRequestKey("book", 2, "page-4", "ZH"),
    );
  });

  it("uses the provider configuration in the request identity", () => {
    expect(buildImmersiveRequestKey("book", 2, "page-3", "ZH", "ai|one|model-a")).not.toBe(
      buildImmersiveRequestKey("book", 2, "page-3", "ZH", "ai|two|model-b"),
    );
  });

  it("restarts extraction after a PDF layout relocation even when the legacy ready gate is stale", () => {
    expect(
      shouldScheduleImmersiveAutoRun({
        enabled: true,
        sourceReady: false,
        requestKey: "book:28:page-28:zh:ai",
        lastRequestedKey: null,
      }),
    ).toBe(true);
  });

  it("rejects late chunks from an old page and old fingerprint", () => {
    const current = sourcedState(2);
    const oldRun = immersiveTranslationReducer(current, {
      type: "chunk",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "old")],
    });
    const wrongSource = immersiveTranslationReducer(current, {
      type: "chunk",
      runId: 2,
      fingerprint: "source-b",
      results: [result("a", "wrong")],
    });

    expect(oldRun).toBe(current);
    expect(wrongSource).toBe(current);
  });

  it("keeps duplicate source text isolated by block id", () => {
    const current = sourcedState();
    const next = immersiveTranslationReducer(current, {
      type: "chunk",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "first"), result("b", "second")],
    });

    expect(next.results).toEqual({ a: "first", b: "second" });
  });

  it("ignores unknown and blank results and finishes as partial", () => {
    const current = sourcedState();
    const next = immersiveTranslationReducer(current, {
      type: "finish",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "translated"), result("b", " "), result("other", "unknown")],
    });

    expect(next.status).toBe("partial");
    expect(next.results).toEqual({ a: "translated" });
  });

  it("only completes when every expected block has a non-empty result", () => {
    const current = sourcedState();
    const next = immersiveTranslationReducer(current, {
      type: "finish",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "first"), result("b", "second")],
    });

    expect(next.status).toBe("complete");
    expect(next.progress.translatedChars).toBe(next.progress.totalChars);
  });

  it("cancels to idle without results and partial with results", () => {
    const empty = immersiveTranslationReducer(sourcedState(), { type: "cancel", runId: 1 });
    const withResult = immersiveTranslationReducer(
      immersiveTranslationReducer(sourcedState(), {
        type: "chunk",
        runId: 1,
        fingerprint: "source-a",
        results: [result("a", "first")],
      }),
      { type: "cancel", runId: 1 },
    );

    expect(empty).toMatchObject({ status: "idle", enabled: false });
    expect(withResult).toMatchObject({ status: "partial", enabled: true });
  });

  it("a new target language atomically clears the previous page results", () => {
    const previous = immersiveTranslationReducer(sourcedState(), {
      type: "chunk",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "first")],
    });
    const next = immersiveTranslationReducer(previous, {
      type: "begin",
      runId: 2,
      requestKey: "book-1:2:JA",
      targetLang: "JA",
    });

    expect(next).toMatchObject({
      status: "extracting",
      targetLang: "JA",
      snapshot: null,
      results: {},
    });
  });

  it("preserves partial results while retrying the same source", () => {
    const partial = immersiveTranslationReducer(sourcedState(), {
      type: "chunk",
      runId: 1,
      fingerprint: "source-a",
      results: [result("a", "first")],
    });
    const extracting = immersiveTranslationReducer(partial, {
      type: "begin",
      runId: 2,
      requestKey: "book-1:2:ZH",
      targetLang: "ZH",
      preserveCurrent: true,
    });
    const translating = immersiveTranslationReducer(extracting, {
      type: "source",
      runId: 2,
      snapshot: snapshot(),
    });

    expect(extracting.results).toEqual({ a: "first" });
    expect(translating.results).toEqual({ a: "first" });
  });
});
