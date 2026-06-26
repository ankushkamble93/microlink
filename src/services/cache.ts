// ─────────────────────────────────────────────────────────────────────────────
// microlink — Cloudflare KV Cache Layer
//
// Architecture:
//   • KV is the hot-path cache; every redirect checks KV before hitting Supabase.
//   • TTL on KV entries is capped at the URL's own expiry to prevent serving
//     stale redirects after a URL expires.
//   • Cache entries store { long_url, expires_at } as JSON so the redirect
//     handler can perform expiry checks locally without a DB call.
//   • Negative lookups (KEY_NOT_FOUND) are cached briefly to absorb traffic
//     spikes targeting non-existent keys.
// ─────────────────────────────────────────────────────────────────────────────

import type { CacheEntry } from "../types";

const CACHE_PREFIX = "url:";
const NEGATIVE_PREFIX = "miss:";
const DEFAULT_TTL_SECONDS = 86_400;     // 24 hours
const NEGATIVE_CACHE_TTL_SECONDS = 60; // 1 minute for 404s

function cacheKey(shortKey: string): string {
  return `${CACHE_PREFIX}${shortKey}`;
}

function negativeCacheKey(shortKey: string): string {
  return `${NEGATIVE_PREFIX}${shortKey}`;
}

/**
 * Read a URL entry from KV. Returns null on miss (or negative-cache hit).
 * The caller should treat null as "go to DB".
 */
export async function getCached(
  kv: KVNamespace,
  shortKey: string
): Promise<CacheEntry | null | "MISS"> {
  // Check positive cache first
  const raw = await kv.get(cacheKey(shortKey), "text");
  if (raw !== null) {
    try {
      return JSON.parse(raw) as CacheEntry;
    } catch {
      // Corrupted cache entry — treat as miss, let next request re-warm.
      return null;
    }
  }

  // Check negative cache (recently confirmed 404)
  const neg = await kv.get(negativeCacheKey(shortKey), "text");
  if (neg !== null) {
    return "MISS"; // Sentinel: key is definitively absent
  }

  return null; // True cache miss — go to DB
}

/**
 * Write a URL entry into KV.
 * TTL is computed as the minimum of DEFAULT_TTL and the remaining time until
 * expiry, ensuring KV never serves a redirect past the URL's expiry date.
 */
export async function setCached(
  kv: KVNamespace,
  shortKey: string,
  entry: CacheEntry,
  expiresAt: Date | null
): Promise<void> {
  let ttlSeconds = DEFAULT_TTL_SECONDS;

  if (expiresAt !== null) {
    const secondsUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
    if (secondsUntilExpiry <= 0) {
      // URL already expired — don't cache it at all.
      return;
    }
    ttlSeconds = Math.min(ttlSeconds, secondsUntilExpiry);
  }

  await kv.put(cacheKey(shortKey), JSON.stringify(entry), {
    expirationTtl: ttlSeconds,
  });
}

/**
 * Write a negative cache entry for a key that does not exist in the DB.
 * This absorbs bot traffic hammering non-existent keys.
 */
export async function setNegativeCached(
  kv: KVNamespace,
  shortKey: string
): Promise<void> {
  await kv.put(negativeCacheKey(shortKey), "1", {
    expirationTtl: NEGATIVE_CACHE_TTL_SECONDS,
  });
}

/**
 * Invalidate a cache entry (e.g., after deletion or expiry).
 */
export async function invalidateCache(
  kv: KVNamespace,
  shortKey: string
): Promise<void> {
  await Promise.all([
    kv.delete(cacheKey(shortKey)),
    kv.delete(negativeCacheKey(shortKey)),
  ]);
}
