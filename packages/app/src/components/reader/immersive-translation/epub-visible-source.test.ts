import { describe, expect, it } from "vitest";
import { selectVisibleEpubSourceBlocks } from "./epub-visible-source";

const block = (id: string, left: number, right: number) => ({
  id,
  text: `text-${id}`,
  tagName: "p",
  sourceIndex: Number(id.slice(1)),
  rects: [{ left, right, top: 0, bottom: 40, width: right - left, height: 40 }],
});

describe("selectVisibleEpubSourceBlocks", () => {
  it("submits only blocks intersecting the current paginated viewport", () => {
    const blocks = [
      block("p0", 0, 400),
      block("p1", 410, 790),
      block("p2", 820, 1200),
      block("p3", 1210, 1590),
    ];

    expect(
      selectVisibleEpubSourceBlocks(blocks, { mode: "paginated", left: 800, right: 1600 }).map(
        (item) => item.id,
      ),
    ).toEqual(["p2", "p3"]);
  });

  it("submits only blocks intersecting the current scrolled viewport", () => {
    const blocks = [
      {
        ...block("p0", 0, 600),
        rects: [{ left: 0, right: 600, top: -120, bottom: -20, width: 600, height: 100 }],
      },
      {
        ...block("p1", 0, 600),
        rects: [{ left: 0, right: 600, top: 40, bottom: 180, width: 600, height: 140 }],
      },
      {
        ...block("p2", 0, 600),
        rects: [{ left: 0, right: 600, top: 900, bottom: 1000, width: 600, height: 100 }],
      },
    ];

    expect(
      selectVisibleEpubSourceBlocks(blocks, {
        mode: "scrolled",
        left: 0,
        right: 600,
        top: 800,
        bottom: 1600,
      }).map((item) => item.id),
    ).toEqual(["p2"]);
  });
});
