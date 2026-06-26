// ─────────────────────────────────────────────────────────────────────────────
// microlink — Core Shortening Service
//
// Orchestrates:
//   1. URL validation + Safe Browsing check
//   2. Key generation (hash-based with collision retry loop)
//   3. Atomic DB insertion (unique constraint prevents race conditions)
//   4. KV cache warm-up after successful insert
//
// Collision Resolution Strategy:
//   SHA-256(url + salt) → truncated Base62 key of length KEY_MIN_LENGTH.
//   If the key collides (rare with ~3.5 trillion possibilities at length 7):
//     • Salt becomes "1", "2", … up to COLLISION_MAX_RETRIES.
//     • After max retries, fall back to a cryptographically random key.
//   DB-level UNIQUE constraint is the authoritative source of truth —
//   the application retry loop is a performance optimisation only.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env, ShortenResponse, CacheEntry } from "../types";
import { ErrorCode } from "../types";
import { urlToKey, generateRandomKey, parseSeed, idToKey } from "./encoder";
import { validateUrl, validateAlias, isSafeUrl, hashIp } from "./validator";
import { getUrlByKey, insertUrl, keyExists } from "../db/queries";
import { ConflictError } from "../db/queries";
import { setCached } from "./cache";

export class ShortenError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = "ShortenError";
  }
}

export interface ShortenOptions {
  url: string;
  customAlias?: string;
  expiresInDays?: number;
  creatorIp?: string;
}

export async function shortenUrl(
  options: ShortenOptions,
  db: SupabaseClient,
  kv: KVNamespace,
  env: Env
): Promise<ShortenResponse> {
  const {
    url: rawInput,
    customAlias,
    expiresInDays,
    creatorIp,
  } = options;

  // Normalize whitespace at the service layer so callers don't need to.
  const rawUrl = rawInput.trim();

  const maxLength = parseInt(env.MAX_URL_LENGTH, 10);
  const keyMinLength = parseInt(env.KEY_MIN_LENGTH, 10);
  const maxRetries = parseInt(env.COLLISION_MAX_RETRIES, 10);
  const seed = parseSeed(env.ID_SHUFFLE_SEED);

  // ── 1. Validate URL ──────────────────────────────────────────────────────
  const urlValidation = validateUrl(rawUrl, env.BASE_URL, maxLength);
  if (!urlValidation.ok) {
    throw new ShortenError(urlValidation.message, urlValidation.code);
  }

  // ── 2. Safe Browsing check (async, before any DB writes) ─────────────────
  const safetyResult = await isSafeUrl(rawUrl, env);
  if (!safetyResult.safe) {
    throw new ShortenError(
      `URL was flagged as potentially malicious (${safetyResult.threat ?? "UNKNOWN"})`,
      ErrorCode.MALICIOUS_URL
    );
  }

  // ── 3. Compute expiry timestamp ──────────────────────────────────────────
  let expiresAt: Date | null = null;
  const ttlDays = expiresInDays ?? parseInt(env.DEFAULT_TTL_DAYS, 10);
  if (ttlDays > 0 && ttlDays <= 3650) { // max 10 years
    expiresAt = new Date(Date.now() + ttlDays * 86_400_000);
  }

  // ── 4. Hash creator IP for GDPR-compliant storage ────────────────────────
  const creatorIpHash = creatorIp ? await hashIp(creatorIp) : null;

  // ── 5a. Custom alias path ────────────────────────────────────────────────
  if (customAlias) {
    const aliasValidation = validateAlias(customAlias);
    if (!aliasValidation.ok) {
      throw new ShortenError(aliasValidation.message, aliasValidation.code);
    }

    // Attempt atomic insert — the DB UNIQUE constraint prevents dual-write races.
    try {
      const record = await insertUrl(db, {
        short_key: customAlias,
        long_url: rawUrl,
        is_custom: true,
        expires_at: expiresAt?.toISOString() ?? null,
        creator_ip_hash: creatorIpHash,
      });

      // Warm cache immediately after successful insert.
      const cacheEntry: CacheEntry = {
        long_url: rawUrl,
        expires_at: expiresAt?.toISOString() ?? null,
      };
      await setCached(kv, customAlias, cacheEntry, expiresAt);

      return buildResponse(record.short_key, rawUrl, record.expires_at, record.created_at, env.BASE_URL);
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new ShortenError(
          `Custom alias '${customAlias}' is already taken`,
          ErrorCode.ALIAS_TAKEN
        );
      }
      throw err;
    }
  }

  // ── 5b. Auto-generated key path with collision retry loop ─────────────────
  //
  // Strategy: derive a deterministic Base62 key from SHA-256(url + salt).
  // On collision, append an incrementing salt ("1", "2", …).
  // After max retries, fall back to a random key (always unique probability-wise).
  //
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let shortKey: string;

    if (attempt === maxRetries) {
      // Final fallback: cryptographically random key (astronomically low collision probability).
      shortKey = generateRandomKey(keyMinLength + 1);
    } else {
      const salt = attempt === 0 ? "" : String(attempt);
      shortKey = await urlToKey(rawUrl, salt, keyMinLength);
    }

    // Optimistic existence check (saves a DB write round-trip on collisions).
    // Not strictly necessary — the insert UNIQUE constraint is authoritative —
    // but avoids noisy conflict errors in DB logs on hot keys.
    const exists = await keyExists(db, shortKey);
    if (exists) continue;

    try {
      const record = await insertUrl(db, {
        short_key: shortKey,
        long_url: rawUrl,
        is_custom: false,
        expires_at: expiresAt?.toISOString() ?? null,
        creator_ip_hash: creatorIpHash,
      });

      const cacheEntry: CacheEntry = {
        long_url: rawUrl,
        expires_at: expiresAt?.toISOString() ?? null,
      };
      await setCached(kv, shortKey, cacheEntry, expiresAt);

      return buildResponse(record.short_key, rawUrl, record.expires_at, record.created_at, env.BASE_URL);
    } catch (err) {
      if (err instanceof ConflictError) {
        // Concurrent insert raced past our existence check — retry with next salt.
        continue;
      }
      throw err;
    }
  }

  // Should be unreachable: maxRetries + 1 attempts always include a random fallback.
  throw new ShortenError(
    "Unable to generate a unique short key after maximum retries",
    ErrorCode.COLLISION_EXHAUSTED
  );
}

/**
 * Resolve a short key to its destination URL, respecting expiry.
 * Returns null if the key is not found in the DB.
 */
export async function resolveKey(
  shortKey: string,
  db: SupabaseClient
): Promise<{ long_url: string; expires_at: string | null } | null> {
  const record = await getUrlByKey(db, shortKey);
  if (!record) return null;

  return { long_url: record.long_url, expires_at: record.expires_at };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildResponse(
  shortKey: string,
  longUrl: string,
  expiresAt: string | null,
  createdAt: string,
  baseUrl: string
): ShortenResponse {
  return {
    short_url: `${baseUrl.replace(/\/$/, "")}/${shortKey}`,
    short_key: shortKey,
    long_url: longUrl,
    expires_at: expiresAt,
    created_at: createdAt,
  };
}

// Re-export for convenience in handlers
export { idToKey, parseSeed };
