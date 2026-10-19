import { describe, expect, it } from "vitest";
import {
  buildEpubSourceSnapshot,
  buildPdfSourceBlocks,
  buildPdfSourceSnapshot,
  calculatePdfBlockSlot,
  normalizePdfRect,
} from "./pdf-geometry";
import { classifyPdfSourceResult } from "./source-state";

function span(
  text: string,
  left: number,
  top: number,
  width: number,
  height: number,
  sourceIndex?: number,
) {
  return {
    text,
    rect: { left, top, width, height },
    sourceIndex,
  };
}

describe("PDF immersive source geometry", () => {
  it("normalizes coordinates and keeps fingerprints/IDs stable across zoom", () => {
    const atOne = buildPdfSourceSnapshot({
      bookId: "book",
      sectionIndex: 2,
      pageKey: "page-3",
      pageWidth: 600,
      pageHeight: 1000,
      spans: [span("hello", 60, 200, 120, 24, 0)],
    });
    const atTwo = buildPdfSourceSnapshot({
      bookId: "book",
      sectionIndex: 2,
      pageKey: "page-3",
      pageWidth: 1200,
      pageHeight: 2000,
      spans: [span("hello", 120, 400, 240, 48, 0)],
    });

    const first = atOne.blocks[0];
    const second = atTwo.blocks[0];
    expect(first?.kind).toBe("pdf");
    expect(second?.kind).toBe("pdf");
    if (first?.kind !== "pdf" || second?.kind !== "pdf") throw new Error("expected PDF blocks");
    expect(second.rect).toEqual(first.rect);
    expect(second.id).toBe(first.id);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(atTwo.fingerprint).toBe(atOne.fingerprint);
  });

  it("merges adjacent fragments on one baseline without losing word spacing", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [span("Hello", 100, 100, 250, 24, 0), span("world", 360, 100, 250, 24, 1)],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("Hello world");
  });

  it("assigns two columns independently and never joins adjacent rows across the gutter", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [
        span("left one", 80, 180, 320, 24, 0),
        span("right one", 600, 180, 320, 24, 1),
        span("left two", 80, 240, 320, 24, 2),
        span("right two", 600, 240, 320, 24, 3),
      ],
    });
    expect(blocks.map((block) => [block.text, block.columnIndex])).toEqual([
      ["left one", 0],
      ["left two", 0],
      ["right one", 1],
      ["right two", 1],
    ]);
  });

  it("merges adjacent PDF lines in the same reading track into paragraph-sized requests", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [
        span("First line of the paragraph", 100, 200, 600, 24, 0),
        span("continues on the next line.", 100, 232, 600, 24, 1),
        span("A new paragraph starts here.", 100, 300, 600, 24, 2),
      ],
    });

    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.text)).toEqual([
      "First line of the paragraph continues on the next line.",
      "A new paragraph starts here.",
    ]);
  });

  it("splits regions at full-width separators and inserts spanning lines by page order", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [
        span("Page title", 80, 30, 840, 24, 0),
        span("one", 80, 180, 320, 24, 1),
        span("two", 600, 180, 320, 24, 2),
        span("Section break", 100, 500, 800, 24, 3),
        span("three", 80, 650, 320, 24, 4),
        span("four", 600, 650, 320, 24, 5),
        span("Page footer", 80, 940, 840, 24, 6),
      ],
    });
    expect(blocks.filter((block) => block.spanning).map((block) => block.text)).toEqual([
      "Page title",
      "Section break",
      "Page footer",
    ]);
    expect(blocks.map((block) => block.text)).toEqual([
      "Page title",
      "one",
      "two",
      "Section break",
      "three",
      "four",
      "Page footer",
    ]);
    expect(blocks.map((block) => block.regionIndex)).toEqual([0, 1, 1, 1, 2, 2, 2]);
  });

  it("keeps a narrow centered heading ahead of both columns", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [
        span("Centered heading", 260, 100, 480, 24, 0),
        span("left one", 80, 180, 320, 24, 1),
        span("right one", 600, 180, 320, 24, 2),
        span("left two", 80, 240, 320, 24, 3),
        span("right two", 600, 240, 320, 24, 4),
      ],
    });

    expect(blocks[0]?.text).toBe("Centered heading");
    expect(blocks[0]?.spanning).toBe(true);
    expect(blocks.slice(1).map((block) => block.text)).toEqual([
      "left one",
      "left two",
      "right one",
      "right two",
    ]);
  });

  it("classifies text-layer lifecycle, including ready-but-empty", () => {
    const snapshot = {
      kind: "pdf" as const,
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      fingerprint: "fp",
      blocks: [],
      expectedBlockIds: [],
    };
    expect(classifyPdfSourceResult("loading", undefined)).toEqual({
      status: "retryable",
      reason: "text-layer-not-ready",
    });
    expect(classifyPdfSourceResult("missing", undefined).status).toBe("retryable");
    expect(classifyPdfSourceResult("ready", snapshot)).toEqual({
      status: "unsupported",
      reason: "no-extractable-text",
    });
    expect(classifyPdfSourceResult("error", undefined, "boom")).toEqual({
      status: "error",
      message: "boom",
    });
  });

  it("normalizes arbitrary page bounds to the same unit interval", () => {
    expect(
      normalizePdfRect(
        { left: 100, top: 200, width: 200, height: 100 },
        { left: 0, top: 0, width: 1000, height: 1000 },
      ),
    ).toEqual({ left: 0.1, top: 0.2, width: 0.2, height: 0.1, right: 0.3, bottom: 0.3 });
  });

  it("classifies high-confidence template and programming snippets without translating code", () => {
    const lines = [
      ['<p v-if="visible">', 100],
      ["You get a discount!", 130],
      ["</p>", 160],
      ["{#if visible}", 220],
      ["shown", 250],
      ["{/if}", 280],
      ["<Card>", 340],
      ["{items.map(item => <span>{item}</span>)}", 370],
      ["</Card>", 400],
      ["This is ordinary prose on the page.", 460],
    ] as const;
    const snapshot = buildPdfSourceSnapshot({
      bookId: "book",
      sectionIndex: 35,
      pageKey: "page-35",
      pageWidth: 600,
      pageHeight: 900,
      spans: lines.map(([text, top], sourceIndex) => span(text, 100, top, 400, 20, sourceIndex)),
    });

    const codeBlocks = snapshot.blocks.filter((block) => block.contentKind === "code");
    expect(
      codeBlocks
        .filter(
          (block): block is Extract<(typeof snapshot.blocks)[number], { kind: "pdf" }> =>
            block.kind === "pdf",
        )
        .map((block) => block.sourceLines),
    ).toEqual([
      ['<p v-if="visible">', "You get a discount!", "</p>"],
      ["{#if visible}", "shown", "{/if}"],
      ["<Card>", "{items.map(item => <span>{item}</span>)}", "</Card>"],
    ]);
    expect(
      snapshot.blocks.some((block) => block.text === "This is ordinary prose on the page."),
    ).toBe(true);
    expect(snapshot.expectedBlockIds).toEqual(
      snapshot.blocks.filter((block) => block.contentKind === "prose").map((block) => block.id),
    );
    expect(snapshot.expectedBlockIds).not.toEqual(
      expect.arrayContaining(codeBlocks.map((b) => b.id)),
    );
  });

  it("marks EPUB pre/code blocks as code and excludes them from requests", () => {
    const snapshot = buildEpubSourceSnapshot("book", 0, "chapter", [
      { id: "prose", text: "A paragraph.", tagName: "p", sourceIndex: 0 },
      { id: "pre", text: "const value = 1;\nreturn value;", tagName: "pre", sourceIndex: 1 },
      { id: "code", text: "<Widget />", tagName: "code", sourceIndex: 2 },
    ]);
    expect(snapshot.blocks.map((block) => block.contentKind)).toEqual(["prose", "code", "code"]);
    expect(snapshot.expectedBlockIds).toEqual(["prose"]);
  });

  it("uses the next block in the same track and ignores same-row neighboring columns", () => {
    const blocks = buildPdfSourceBlocks({
      bookId: "book",
      sectionIndex: 0,
      pageKey: "p1",
      pageWidth: 1000,
      pageHeight: 1000,
      spans: [
        span("left first", 80, 180, 320, 24, 0),
        span("right same row", 600, 180, 320, 24, 1),
        span("left next", 80, 240, 320, 24, 2),
      ],
    });
    const left = blocks.find((block) => block.text === "left first");
    const right = blocks.find((block) => block.text === "right same row");
    const leftNext = blocks.find((block) => block.text === "left next");
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(leftNext).toBeDefined();
    if (!left || !right || !leftNext) throw new Error("expected source blocks");
    expect(calculatePdfBlockSlot(left, blocks).bottom).toBeCloseTo(leftNext.rect.top);
    expect(calculatePdfBlockSlot(right, blocks).bottom).toBeCloseTo(0.985);
  });
});
