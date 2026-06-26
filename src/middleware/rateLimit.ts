// ─────────────────────────────────────────────────────────────────────────────
// microlink — Token Bucket Rate Limiter (Cloudflare KV-backed)
//
// Algorithm: Token Bucket
//   • Each IP starts with a full bucket of MAX_REQUESTS tokens.
//   • Tokens refill linearly at rate (MAX_REQUESTS / WINDOW_MS) per ms.
//   • Each request consumes one token.
//   • If the bucket is empty, respond 429 Too Many Requests.
//
// KV storage:
//   • Key: `rl:{ip_hash}`  (hashed IP, never raw)
//   • Value: JSON { tokens: number, last_refill: number }
//   • TTL: WINDOW_MS * 2 (auto-expiry for inactive IPs)
//
// Trade-offs vs alternatives:
//   • Cloudflare's native rate limiting (paid): more accurate at edge, costs money.
//   • Durable Objects: perfectly consistent, free tier limits apply.
//   • KV: slightly inconsistent under extreme concurrency (eventual consistency),
//     but perfectly adequate for protecting the API from casual abuse.
//     For a free-tier project this is the right trade-off.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context, Next } from "hono";
import type { Env, TokenBucketState } from "../types";
import { ErrorCode } from "../types";

const KV_PREFIX = "rl:";

async function hashIpForRateLimit(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest("SHA-256", data);
  // Use only first 16 bytes (32 hex chars) — sufficient for uniqueness, shorter key.
  return Array.from(new Uint8Array(buf).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function rateLimitKey(ipHash: string): string {
  return `${KV_PREFIX}${ipHash}`;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp ms when bucket fully refills
  retryAfterMs: number;
}

/**
 * Check and consume one token from the IP's bucket.
 * Reads → computes refill → decrements → writes back.
 *
 * Note: KV reads and writes are not atomic. Under very high concurrency from
 * the same IP, multiple requests could read the same state before any write
 * completes, effectively allowing small bursts over the limit. This is an
 * acceptable trade-off for a free-tier implementation; use Durable Objects
 * for strict enforcement.
 */
export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const ipHash = await hashIpForRateLimit(ip);
  const key = rateLimitKey(ipHash);
  const now = Date.now();

  // Read current bucket state
  const raw = await kv.get(key, "text");
  let state: TokenBucketState;

  if (raw === null) {
    // First request from this IP — full bucket minus one token for current req.
    state = { tokens: config.maxRequests - 1, last_refill: now };
    await kv.put(key, JSON.stringify(state), {
      expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
    });
    return {
      allowed: true,
      remaining: state.tokens,
      resetAt: now + config.windowMs,
      retryAfterMs: 0,
    };
  }

  try {
    state = JSON.parse(raw) as TokenBucketState;
  } catch {
    // Corrupted state — reset bucket.
    state = { tokens: config.maxRequests, last_refill: now };
  }

  // Compute token refill since last request
  const elapsedMs = now - state.last_refill;
  const refillRate = config.maxRequests / config.windowMs; // tokens per ms
  const newTokens = Math.min(
    config.maxRequests,
    state.tokens + elapsedMs * refillRate
  );

  if (newTokens < 1) {
    // Bucket empty — rate limited
    const tokensNeeded = 1 - newTokens;
    const retryAfterMs = Math.ceil(tokensNeeded / refillRate);

    return {
      allowed: false,
      remaining: 0,
      resetAt: now + retryAfterMs,
      retryAfterMs,
    };
  }

  // Consume one token and persist
  const updatedState: TokenBucketState = {
    tokens: newTokens - 1,
    last_refill: now,
  };

  await kv.put(key, JSON.stringify(updatedState), {
    expirationTtl: Math.ceil((config.windowMs * 2) / 1000),
  });

  return {
    allowed: true,
    remaining: Math.floor(updatedState.tokens),
    resetAt: now + config.windowMs,
    retryAfterMs: 0,
  };
}

/**
 * Hono middleware factory. Apply to routes that need rate limiting.
 *
 * Usage:
 *   app.post('/api/shorten', rateLimiter(), handler)
 */
export function rateLimiter() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> => {
    const env = c.env;
    const windowMs = parseInt(env.RATE_LIMIT_WINDOW_MS, 10);
    const maxRequests = parseInt(env.RATE_LIMIT_MAX_REQUESTS, 10);

    // Extract real IP — Cloudflare sets CF-Connecting-IP.
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown";

    const result = await checkRateLimit(env.RATE_LIMIT_KV, ip, {
      windowMs,
      maxRequests,
    });

    // Always set rate limit headers (RFC 6585 / draft-ietf-httpapi-ratelimit-headers).
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));

    if (!result.allowed) {
      c.header("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
      return c.json(
        {
          error: "Too many requests. Please slow down.",
          code: ErrorCode.RATE_LIMITED,
          retry_after_ms: result.retryAfterMs,
        },
        429
      );
    }

    await next();
  };
}
