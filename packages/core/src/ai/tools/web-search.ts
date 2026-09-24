import { DOMParser } from "@xmldom/xmldom";
import type { SafeWebFetchResult } from "../../services";
import { getPlatformService } from "../../services";
import { type SafeWebFetcher, cleanHtmlToText } from "./web-fetch";

const BING_RSS_ENDPOINT = "https://www.bing.com/search?format=rss&q=";
const MAX_QUERY_LENGTH = 512;
const MAX_RESULTS = 10;

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export interface WebSearchProvider {
  search(query: string): Promise<WebSearchResult[]>;
}

function textContent(node: Node | null): string {
  return node?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function parseRss(body: string): WebSearchResult[] {
  const document = new DOMParser({
    errorHandler: { warning: () => undefined, error: () => undefined },
  }).parseFromString(body, "text/xml");
  const items = Array.from(document.getElementsByTagName("item"));
  return items
    .map((item) => {
      const title = textContent(item.getElementsByTagName("title")[0] ?? null);
      const snippet = cleanHtmlToText(
        textContent(item.getElementsByTagName("description")[0] ?? null),
        1200,
      );
      const url = textContent(item.getElementsByTagName("link")[0] ?? null);
      return { title, snippet, url };
    })
    .filter((item) => item.title && /^https?:\/\//i.test(item.url))
    .slice(0, MAX_RESULTS);
}

function defaultFetcher(): SafeWebFetcher {
  return async (url: string): Promise<SafeWebFetchResult> => {
    const platform = getPlatformService();
    if (!platform.capabilities?.safeWebFetch || !platform.safeWebFetch) {
      throw new Error("Safe web search is unavailable on this platform");
    }
    return platform.safeWebFetch(url);
  };
}

export class BingRssSearchProvider implements WebSearchProvider {
  constructor(private readonly fetcher: SafeWebFetcher = defaultFetcher()) {}

  async search(query: string): Promise<WebSearchResult[]> {
    const normalizedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (!normalizedQuery) throw new Error("Search query is empty");
    const response = await this.fetcher(
      `${BING_RSS_ENDPOINT}${encodeURIComponent(normalizedQuery)}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Web search failed with HTTP ${response.status}`);
    }
    return parseRss(response.body);
  }
}

export { parseRss };
