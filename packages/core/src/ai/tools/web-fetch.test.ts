import { describe, expect, it } from "vitest";
import { cleanHtmlToText, fetchWebPage } from "./web-fetch";

describe("web fetch text extraction", () => {
  it("removes active and navigation content and decodes entities", () => {
    const html = `<html><head><style>body { display:none }</style></head><body>
      <nav>Ignore navigation</nav><main><h1>Title &amp; More</h1>
      <p>Hello&nbsp;world &#x1F600;.</p><script>alert('xss')</script>
      <form>Ignore form</form><iframe src="https://evil.test">Ignore frame</iframe>
      <p>Keep this text.</p></main></body></html>`;
    const text = cleanHtmlToText(html);
    expect(text).toContain("Title & More");
    expect(text).toContain("Hello world 😀.");
    expect(text).toContain("Keep this text.");
    expect(text).not.toContain("Ignore navigation");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("Ignore form");
    expect(text).not.toContain("evil.test");
    expect(text).not.toContain("<");
    expect(cleanHtmlToText("<script>drop everything")).toBe("");
  });

  it("bounds the extracted body", () => {
    expect(cleanHtmlToText(`<p>${"x".repeat(100)}</p>`, 20)).toHaveLength(20);
  });

  it("uses an injectable fetcher and rejects unsupported URLs/statuses", async () => {
    const fetcher = async (url: string) => ({
      finalUrl: `${url}/final`,
      status: 200,
      contentType: "text/html",
      body: "<p>Readable page</p>",
    });
    await expect(fetchWebPage("https://example.com/path", fetcher)).resolves.toMatchObject({
      finalUrl: "https://example.com/path/final",
      text: "Readable page",
    });
    await expect(fetchWebPage("file:///tmp/private", fetcher)).rejects.toThrow("Only http");
    await expect(
      fetchWebPage("https://example.com", async () => ({
        finalUrl: "https://example.com",
        status: 404,
        contentType: "text/html",
        body: "not found",
      })),
    ).rejects.toThrow("HTTP 404");
  });
});
