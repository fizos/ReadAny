/**
 * Translation Cache
 * Cross-platform cache for translation results using IPlatformService KV storage.
 *
 * All methods are async to support both Web (localStorage) and RN (AsyncStorage).
 */

import { getPlatformService } from "../services/platform";
import type { TranslatorName } from "./types";

const CACHE_PREFIX = "readany_translation_cache_";

/**
 * Request settings that affect an AI translation result.
 *
 * API keys are deliberately excluded: rotating a key does not change the
 * provider/model response, and putting secrets in a persistent key is unsafe.
 */
export interface TranslationCacheConfig {
  baseUrl?: string;
  model?: string;
  useExactRequestUrl?: boolean;
  endpointId?: string;
  /** Optional book-context identity; omitted for legacy/no-context calls. */
  contextDigest?: string;
  contextMode?: "book-v1" | "none";
}

/** Generate cache key */
function getCacheKey(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  config?: TranslationCacheConfig,
): string {
  const hash = simpleHash(text);
  if (provider !== "ai") {
    // Preserve the long-standing key shape for non-AI providers so their
    // existing persistent translations remain reusable.
    return `${CACHE_PREFIX}${provider}_${sourceLang}_${targetLang}_${hash}`;
  }

  const requestIdentity = JSON.stringify({
    endpoint: normalizeEndpoint(config?.baseUrl),
    model: config?.model?.trim() || "gpt-4o-mini",
    useExactRequestUrl: config?.useExactRequestUrl === true,
    endpointId: config?.endpointId?.trim() || "",
    ...(config?.contextDigest
      ? {
          contextDigest: config.contextDigest,
          contextMode: config.contextMode || "book-v1",
        }
      : {}),
  });
  const configHash = simpleHash(requestIdentity);
  return `${CACHE_PREFIX}${provider}_${configHash}_${sourceLang}_${targetLang}_${hash}`;
}

function normalizeEndpoint(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  return trimmed || "https://api.openai.com";
}

/** Simple hash function for cache key */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/** Get translation from cache */
export async function getFromCache(
  text: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  config?: TranslationCacheConfig,
): Promise<string | null> {
  try {
    const platform = getPlatformService();
    const key = getCacheKey(text, sourceLang, targetLang, provider, config);
    const cached = await platform.kvGetItem(key);
    if (cached) {
      const { translation, timestamp } = JSON.parse(cached);
      // Cache expires after 7 days
      if (Date.now() - timestamp < 7 * 24 * 60 * 60 * 1000) {
        return translation;
      }
      await platform.kvRemoveItem(key);
    }
  } catch (err) {
    console.warn("[Translation] Cache read error:", err);
  }
  return null;
}

/** Store translation in cache */
export async function storeInCache(
  text: string,
  translation: string,
  sourceLang: string,
  targetLang: string,
  provider: TranslatorName,
  config?: TranslationCacheConfig,
): Promise<void> {
  try {
    const platform = getPlatformService();
    const key = getCacheKey(text, sourceLang, targetLang, provider, config);
    await platform.kvSetItem(
      key,
      JSON.stringify({
        translation,
        timestamp: Date.now(),
      }),
    );
  } catch (err) {
    console.warn("[Translation] Cache write error:", err);
  }
}

/** Clear all translation cache */
export async function clearTranslationCache(): Promise<void> {
  try {
    const platform = getPlatformService();
    const allKeys = await platform.kvGetAllKeys();
    const keysToRemove = allKeys.filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(keysToRemove.map((key) => platform.kvRemoveItem(key)));
  } catch (err) {
    console.warn("[Translation] Failed to clear translation cache:", err);
  }
}
