// ─────────────────────────────────────────────────────────────────────────────
// microlink — GET /:key redirect handler
//
// Critical path: every millisecond counts here.
// Read order:
//   1. Cloudflare KV (sub-millisecond P99 at edge)
//   2. Supabase DB (only on KV miss)
//
// Analytics are written AFTER the redirect via ctx.waitUntil — they are
// completely off the critical path and add 0ms to redirect latency.
//
// Expiry check is performed locally (no extra DB round-trip) using the
// expires_at stored in the cache entry or fetched alongside the URL record.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import type { Env } from "../types";
import { ErrorCode } from "../types";
import { getCached, setCached, setNegativeCached } from "../services/cache";
import { getSupabaseClient } from "../db/client";
import { getUrlByKey } from "../db/queries";
import { insertAnalyticsEvent } from "../db/queries";
import { sanitizeReferrer } from "../services/validator";

export async function handleRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const shortKey = c.req.param("key");
  const env = c.env;

  if (!shortKey || shortKey.length === 0 || shortKey.length > 32) {
    return notFoundResponse(c);
  }

  // ── 1. KV hot-path lookup ─────────────────────────────────────────────────
  const cacheResult = await getCached(env.REDIRECT_CACHE, shortKey);

  if (cacheResult === "MISS") {
    // Confirmed 404 via negative cache — return immediately.
    return notFoundResponse(c);
  }

  let longUrl: string;
  let expiresAt: Date | null = null;

  if (cacheResult !== null) {
    // Cache HIT
    longUrl = cacheResult.long_url;
    expiresAt = cacheResult.expires_at ? new Date(cacheResult.expires_at) : null;
  } else {
    // ── 2. DB fallback (only on true cache miss) ───────────────────────────
    const db = getSupabaseClient(env);
    const record = await getUrlByKey(db, shortKey);

    if (!record) {
      // Write negative cache to absorb repeat 404 requests.
      c.executionCtx.waitUntil(setNegativeCached(env.REDIRECT_CACHE, shortKey));
      return notFoundResponse(c);
    }

    longUrl = record.long_url;
    expiresAt = record.expires_at ? new Date(record.expires_at) : null;

    // Warm KV cache (non-blocking).
    const cacheEntry = { long_url: longUrl, expires_at: record.expires_at };
    c.executionCtx.waitUntil(
      setCached(env.REDIRECT_CACHE, shortKey, cacheEntry, expiresAt)
    );
  }

  // ── 3. Expiry check (local, zero DB hits) ─────────────────────────────────
  if (expiresAt !== null && expiresAt.getTime() < Date.now()) {
    return expiredResponse(c);
  }

  // ── 4. Log analytics event out-of-band ────────────────────────────────────
  if (env.ANALYTICS_ENABLED === "true") {
    const country = c.req.header("CF-IPCountry") ?? null;
    const referrer = sanitizeReferrer(c.req.header("Referer") ?? null);

    c.executionCtx.waitUntil(
      (async (): Promise<void> => {
        try {
          const db = getSupabaseClient(env);
          await insertAnalyticsEvent(db, {
            short_key: shortKey,
            clicked_at: new Date().toISOString(),
            country_code: country && country.length === 2 ? country : null,
            referrer_host: referrer,
          });
        } catch (err) {
          console.warn("Analytics write failed (non-fatal):", err);
        }
      })()
    );
  }

  // ── 5. Redirect ───────────────────────────────────────────────────────────
  const redirectStatus = env.REDIRECT_MODE === "301" ? 301 : 302;

  return new Response(null, {
    status: redirectStatus,
    headers: {
      Location: longUrl,
      // Prevent caching of 301s at the browser level when mode is 302.
      "Cache-Control":
        redirectStatus === 301
          ? "public, max-age=3600"
          : "no-store, no-cache, must-revalidate",
      "X-Microlink-Key": shortKey,
    },
  });
}

// ─── Error Responses ──────────────────────────────────────────────────────────

function notFoundResponse(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: "Short URL not found",
      code: ErrorCode.KEY_NOT_FOUND,
    },
    404
  );
}

function expiredResponse(c: Context<{ Bindings: Env }>): Response {
  return c.json(
    {
      error: "This short URL has expired",
      code: ErrorCode.KEY_EXPIRED,
    },
    410
  );
}
