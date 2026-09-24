import { describe, expect, it } from "vitest";
import { BingRssSearchProvider, parseRss } from "./web-search";

const RSS_FIXTURE = `<?xml version="1.0"?><rss><channel>
  <item><title>First &amp; Best</title><description><![CDATA[<b>A short &amp; useful summary.</b>]]></description><link>https://example.com/one</link></item>
  <item><title>Second</title><description>Another result</description><link>https://example.com/two?a=1&amp;b=2</link></item>
  <item><title>Ignored local</title><description>Do not include</description><link>file:///tmp/nope</link></item>
</channel></rss>`;

describe("Bing RSS search provider", () => {
  it("parses title, summary, and URL from an RSS fixture without network access", () => {
    expect(parseRss(RSS_FIXTURE)).toEqual([
      {
        title: "First & Best",
        snippet: "A short & useful summary.",
        url: "https://example.com/one",
      },
      {
        title: "Second",
        snippet: "Another result",
        url: "https://example.com/two?a=1&b=2",
      },
    ]);
  });

  it("uses an injectable fetcher and encodes the query", async () => {
    const calls: string[] = [];
    const provider = new BingRssSearchProvider(async (url) => {
      calls.push(url);
      return { finalUrl: url, status: 200, contentType: "application/rss+xml", body: RSS_FIXTURE };
    });
    await expect(provider.search("read any & safety")).resolves.toHaveLength(2);
    expect(calls[0]).toContain("q=read%20any%20%26%20safety");
  });

  it("reports HTTP failures clearly", async () => {
    const provider = new BingRssSearchProvider(async () => ({
      finalUrl: "https://www.bing.com/",
      status: 503,
      contentType: "text/plain",
      body: "busy",
    }));
    await expect(provider.search("anything")).rejects.toThrow("HTTP 503");
  });
});
