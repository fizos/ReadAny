import type { EpubSourceBlockInput } from "./pdf-geometry";

export interface MeasuredEpubSourceBlock extends EpubSourceBlockInput {
  rects: Array<{
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
  }>;
}

export type EpubVisibleViewport =
  | { mode: "paginated"; left: number; right: number }
  | { mode: "scrolled"; left: number; right: number; top: number; bottom: number };

export function selectVisibleEpubSourceBlocks(
  blocks: readonly MeasuredEpubSourceBlock[],
  viewport: EpubVisibleViewport,
): EpubSourceBlockInput[] {
  return blocks
    .filter((block) =>
      block.rects.some((rect) => {
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (viewport.mode === "paginated") {
          return rect.right > viewport.left && rect.left < viewport.right;
        }
        return (
          rect.right > viewport.left &&
          rect.left < viewport.right &&
          rect.bottom > viewport.top &&
          rect.top < viewport.bottom
        );
      }),
    )
    .map(({ id, text, tagName, sourceIndex }) => ({ id, text, tagName, sourceIndex }));
}
