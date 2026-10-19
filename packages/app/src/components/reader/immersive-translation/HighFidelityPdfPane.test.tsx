import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HighFidelityPdfPane } from "./HighFidelityPdfPane";
import { type HighFidelityPdfStatus, initialHighFidelityPdfState } from "./high-fidelity-pdf";

vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "worker.js" }));

function markup(status: HighFidelityPdfStatus, first = false, last = false) {
  return renderToStaticMarkup(
    <HighFidelityPdfPane
      state={{
        ...initialHighFidelityPdfState,
        status,
        enabled: true,
        page: 2,
        pdfBase64: "fixture",
      }}
      currentPage={2}
      totalPages={3}
      canGoPrev={!first}
      canGoNext={!last}
      providerLabel="test"
      providerModel="test"
      onPrev={() => {}}
      onNext={() => {}}
      onInstall={() => {}}
      onCancel={() => {}}
      onRetry={() => {}}
      onExit={() => {}}
      prefetch={{ status: "ready", page: 3 }}
      bookExport={{ status: "idle" }}
      onStartExport={() => {}}
      onConfirmExport={() => {}}
      onCancelExport={() => {}}
    />,
  );
}

describe("translated PDF controls", () => {
  it.each(["needs-setup", "installing", "translating", "complete", "error", "cancelled"] as const)(
    "keeps navigation discoverable during %s",
    (status) => {
      const html = markup(status);
      expect(html).toContain('aria-label="上一页"');
      expect(html).toContain('aria-label="下一页"');
      expect(html).toContain("第 2 页 / 3");
    },
  );
  it("honors reader-owned first and last page boundaries", () => {
    expect(markup("complete", true)).toMatch(/disabled=""[^>]*aria-label="上一页"/);
    expect(markup("complete", false, true)).toMatch(/disabled=""[^>]*aria-label="下一页"/);
  });
  it("provides fit and manual zoom for complete artifacts", () => {
    const html = markup("complete");
    for (const label of ["适合页面", "适合宽度", "缩小 25%", "放大 25%", "缩放到 100%"])
      expect(html).toContain(`aria-label="${label}"`);
  });
  it("retains offline setup information", () => {
    expect(markup("needs-setup")).toContain("初始化无需联网");
    expect(markup("installing")).toContain("无需下载");
  });
  it("shows next-page prefetch and whole-book export controls", () => {
    const html = markup("complete");
    expect(html).toContain("第 3 页已预翻译");
    expect(html).toContain("保存整本译文");
  });
  it("states cached, missing, and non-text page counts before whole-book AI work", () => {
    const html = renderToStaticMarkup(
      <HighFidelityPdfPane
        state={{
          ...initialHighFidelityPdfState,
          enabled: true,
          status: "complete",
          pdfBase64: "fixture",
        }}
        currentPage={2}
        totalPages={12}
        canGoPrev
        canGoNext
        providerLabel="test"
        providerModel="test"
        onPrev={() => {}}
        onNext={() => {}}
        onInstall={() => {}}
        onCancel={() => {}}
        onRetry={() => {}}
        onExit={() => {}}
        prefetch={{ status: "idle", page: null }}
        bookExport={{
          status: "confirming",
          destinationPath: "D:\\translated.pdf",
          plan: { totalPages: 12, cachedPages: 4, missingPages: 6, nonTextPages: 2 },
        }}
        onStartExport={() => {}}
        onConfirmExport={() => {}}
        onCancelExport={() => {}}
      />,
    );
    expect(html).toContain("可复用缓存 4 页");
    expect(html).toContain("调用 AI 翻译 6 页");
    expect(html).toContain("无文字层原样保留 2 页");
  });
});
