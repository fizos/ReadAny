import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ImmersiveTranslationPane } from "./ImmersiveTranslationPane";
import type { ImmersiveTranslationState } from "./useImmersiveTranslation";

const state: ImmersiveTranslationState = {
  status: "complete",
  enabled: true,
  runId: 1,
  requestKey: "book:0:ZH",
  targetLang: "ZH",
  progress: { totalChars: 10, translatedChars: 10 },
  results: {
    title: "关于封面插图",
    line1: "这是一段明显长于原文单行空间的中文翻译，应当正常换行而不是被裁掉。",
  },
  snapshot: {
    kind: "pdf",
    bookId: "book",
    sectionIndex: 0,
    pageKey: "page-0",
    fingerprint: "page",
    pageWidth: 600,
    pageHeight: 900,
    expectedBlockIds: ["title", "line1"],
    blocks: [
      {
        kind: "pdf",
        contentKind: "prose",
        id: "title",
        fingerprint: "title",
        text: "about the cover illustration",
        tagName: "line",
        pageKey: "page-0",
        pageWidth: 600,
        pageHeight: 900,
        rotation: 0,
        rect: { left: 0.2, top: 0.2, width: 0.6, height: 0.03, right: 0.8, bottom: 0.23 },
        regionIndex: 0,
        columnIndex: -1,
        sourceIndex: 0,
        spanning: true,
        spans: [],
        sourceLines: ["about the cover illustration"],
      },
      {
        kind: "pdf",
        contentKind: "prose",
        id: "line1",
        fingerprint: "line1",
        text: "A long paragraph line",
        tagName: "line",
        pageKey: "page-0",
        pageWidth: 600,
        pageHeight: 900,
        rotation: 0,
        rect: { left: 0.18, top: 0.3, width: 0.64, height: 0.02, right: 0.82, bottom: 0.32 },
        regionIndex: 1,
        columnIndex: 0,
        sourceIndex: 1,
        spanning: false,
        spans: [],
        sourceLines: ["A long paragraph line"],
      },
      {
        kind: "pdf",
        contentKind: "code",
        id: "code1",
        fingerprint: "code1",
        text: '<p v-if="hasDiscount">\n  You get a discount!\n</p>',
        tagName: "line",
        pageKey: "page-0",
        pageWidth: 600,
        pageHeight: 900,
        rotation: 0,
        rect: { left: 0.18, top: 0.4, width: 0.4, height: 0.08, right: 0.58, bottom: 0.48 },
        regionIndex: 1,
        columnIndex: 0,
        sourceIndex: 2,
        spanning: false,
        spans: [],
        sourceLines: ['<p v-if="hasDiscount">', "  You get a discount!", "</p>"],
      },
    ],
  },
};

describe("ImmersiveTranslationPane PDF layout", () => {
  it("anchors translated PDF text to source geometry", () => {
    const markup = renderToStaticMarkup(
      <ImmersiveTranslationPane state={state} onRetry={() => undefined} onExit={() => undefined} />,
    );

    expect(markup).toContain('data-pdf-translation-geometry="true"');
    expect(markup).toContain('class="absolute box-border');
    expect(markup).toContain("left:20%");
    expect(markup).toContain("top:20%");
    expect(markup).toContain("这是一段明显长于原文单行空间的中文翻译");
    expect(markup).toContain(
      "&lt;p v-if=&quot;hasDiscount&quot;&gt;\n  You get a discount!\n&lt;/p&gt;",
    );
  });
});
