import type { SafeWebFetchResult } from "../../services";
import { getPlatformService } from "../../services";

export const MAX_WEB_TEXT_LENGTH = 24_000;

export interface WebFetchOutput {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

export type SafeWebFetcher = (url: string) => Promise<SafeWebFetchResult>;

const REMOVED_ELEMENT_PATTERN =
  /<(script|style|nav|form|iframe|noscript|template|svg|canvas|head|footer|aside|object|embed|portal)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const REMOVED_SELF_CLOSING_PATTERN =
  /<(script|style|nav|form|iframe|noscript|template|svg|canvas|head|footer|aside|object|embed|portal)\b[^>]*\/?>/gi;
const REMOVED_UNCLOSED_PATTERN =
  /<(script|style|nav|form|iframe|noscript|template|svg|canvas|head|footer|aside|object|embed|portal)\b[^>]*>[\s\S]*$/i;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TAG_PATTERN = /<[^>]*>/g;
const LINE_BREAK_PATTERN =
  /<\/?(address|article|blockquote|br|dd|div|dl|dt|h[1-6]|hr|li|main|p|pre|section|table|tr|td|th)\b[^>]*>/gi;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (entity, key: string) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedKey.slice(2), 16);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
        : entity;
    }
    if (normalizedKey.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedKey.slice(1), 10);
      return Number.isFinite(codePoint)
        ? String.fromCodePoint(Math.min(codePoint, 0x10ffff))
        : entity;
    }
    return NAMED_ENTITIES[normalizedKey] ?? entity;
  });
}

/** Convert untrusted HTML into bounded, readable plain text. */
export function cleanHtmlToText(input: string, maxLength = MAX_WEB_TEXT_LENGTH): string {
  const withoutDangerousElements = input
    .replace(COMMENT_PATTERN, " ")
    .replace(REMOVED_ELEMENT_PATTERN, "\n")
    .replace(REMOVED_UNCLOSED_PATTERN, "\n")
    .replace(REMOVED_SELF_CLOSING_PATTERN, "\n");
  const withLineBreaks = withoutDangerousElements.replace(LINE_BREAK_PATTERN, "\n");
  const withoutTags = withLineBreaks.replace(TAG_PATTERN, " ");
  const decoded = decodeEntities(decodeEntities(withoutTags));
  const lines = decoded
    .split("\0")
    .join("")
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean);
  return lines.join("\n").slice(0, maxLength).trim();
}

function ensureSafeWebFetch(fetcher?: SafeWebFetcher): SafeWebFetcher {
  if (fetcher) return fetcher;
  return async (url) => {
    const platform = getPlatformService();
    if (!platform.capabilities?.safeWebFetch || !platform.safeWebFetch) {
      throw new Error("Safe web fetch is unavailable on this platform");
    }
    return platform.safeWebFetch(url);
  };
}

export async function fetchWebPage(url: string, fetcher?: SafeWebFetcher): Promise<WebFetchOutput> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) {
    throw new Error("Only http and https URLs are supported");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("URLs containing user credentials are not allowed");
  }

  const response = await ensureSafeWebFetch(fetcher)(parsedUrl.toString());
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Web fetch failed with HTTP ${response.status}`);
  }
  return {
    finalUrl: response.finalUrl,
    status: response.status,
    contentType: response.contentType,
    text: cleanHtmlToText(response.body),
  };
}
