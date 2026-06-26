// ─────────────────────────────────────────────────────────────────────────────
// Integration tests for the shortenUrl service.
// All external dependencies (Supabase DB, KV) are mocked at the function level.
// We test the full orchestration logic including collision retry, race conditions,
// and validation flow.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { shortenUrl, ShortenError } from "../../src/services/shortener";
import * as queries from "../../src/db/queries";
import * as cache from "../../src/services/cache";
import * as validator from "../../src/services/validator";
import { ConflictError } from "../../src/db/queries";
import type { Env, UrlRecord } from "../../src/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_ENV: Env = {
  REDIRECT_CACHE: {} as KVNamespace,
  RATE_LIMIT_KV: {} as KVNamespace,
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_KEY: "test-key",
  BASE_URL: "https://mlnk.io",
  REDIRECT_MODE: "302",
  DEFAULT_TTL_DAYS: "365",
  MAX_URL_LENGTH: "2048",
  KEY_MIN_LENGTH: "6",
  KEY_MAX_LENGTH: "12",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "30",
  COLLISION_MAX_RETRIES: "3",
  ENABLE_SAFE_BROWSING: "false",
  ANALYTICS_ENABLED: "true",
};

const MOCK_KV = {} as KVNamespace;

function mockDb() {
  return {} as ReturnType<typeof import("../../src/db/client")["getSupabaseClient"]>;
}

function makeRecord(overrides: Partial<UrlRecord> = {}): UrlRecord {
  return {
    id: 1,
    short_key: "abc123",
    long_url: "https://example.com",
    is_custom: false,
    expires_at: null,
    created_at: new Date().toISOString(),
    creator_ip_hash: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("shortenUrl — happy paths", () => {
  beforeEach(() => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();
    vi.spyOn(queries, "keyExists").mockResolvedValue(false);
    vi.spyOn(queries, "insertUrl").mockResolvedValue(makeRecord());
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns a ShortenResponse with the correct structure", async () => {
    const result = await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );

    expect(result).toMatchObject({
      short_url: expect.stringContaining("https://mlnk.io/"),
      short_key: expect.any(String),
      long_url: "https://example.com",
    });
  });

  it("trims the URL before processing", async () => {
    const result = await shortenUrl(
      { url: "  https://example.com  " },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );
    expect(result.long_url).toBe("https://example.com");
  });

  it("respects custom expires_in_days", async () => {
    vi.spyOn(queries, "insertUrl").mockResolvedValue(
      makeRecord({ expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString() })
    );
    const result = await shortenUrl(
      { url: "https://example.com", expiresInDays: 7 },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );
    expect(result.expires_at).not.toBeNull();
  });

  it("creates a custom alias when requested", async () => {
    vi.spyOn(queries, "insertUrl").mockResolvedValue(
      makeRecord({ short_key: "my-promo", is_custom: true })
    );
    const result = await shortenUrl(
      { url: "https://example.com", customAlias: "my-promo" },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );
    expect(result.short_key).toBe("my-promo");
    expect(result.short_url).toBe("https://mlnk.io/my-promo");
  });

  it("warms the KV cache after insert", async () => {
    const setCachedSpy = vi.spyOn(cache, "setCached").mockResolvedValue();
    await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );
    expect(setCachedSpy).toHaveBeenCalledOnce();
  });
});

describe("shortenUrl — validation failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws ShortenError for an invalid URL", async () => {
    await expect(
      shortenUrl({ url: "not-a-url" }, mockDb(), MOCK_KV, MOCK_ENV)
    ).rejects.toThrow(ShortenError);
  });

  it("throws ShortenError for a URL that is too long", async () => {
    const longUrl = "https://example.com/" + "a".repeat(2100);
    await expect(
      shortenUrl({ url: longUrl }, mockDb(), MOCK_KV, MOCK_ENV)
    ).rejects.toMatchObject({ code: "URL_TOO_LONG" });
  });

  it("throws ShortenError for an SSRF URL", async () => {
    await expect(
      shortenUrl({ url: "http://169.254.169.254/latest/meta-data/" }, mockDb(), MOCK_KV, MOCK_ENV)
    ).rejects.toMatchObject({ code: "SSRF_BLOCKED" });
  });

  it("throws ShortenError for a self-referential URL", async () => {
    await expect(
      shortenUrl({ url: "https://mlnk.io/abc" }, mockDb(), MOCK_KV, MOCK_ENV)
    ).rejects.toMatchObject({ code: "SELF_REFERENTIAL" });
  });

  it("throws ShortenError when Safe Browsing flags the URL", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({
      safe: false,
      threat: "MALWARE",
    });
    await expect(
      shortenUrl({ url: "https://evil.example.com" }, mockDb(), MOCK_KV, MOCK_ENV)
    ).rejects.toMatchObject({ code: "MALICIOUS_URL" });
  });

  it("throws ShortenError for an invalid alias", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    await expect(
      shortenUrl(
        { url: "https://example.com", customAlias: "<script>" },
        mockDb(),
        MOCK_KV,
        MOCK_ENV
      )
    ).rejects.toMatchObject({ code: "ALIAS_INVALID" });
  });

  it("throws ShortenError for a reserved alias", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    await expect(
      shortenUrl(
        { url: "https://example.com", customAlias: "api" },
        mockDb(),
        MOCK_KV,
        MOCK_ENV
      )
    ).rejects.toMatchObject({ code: "ALIAS_INVALID" });
  });
});

describe("shortenUrl — collision resolution", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries on key collision and succeeds", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();

    // First two key attempts exist, third is free
    const existsSpy = vi
      .spyOn(queries, "keyExists")
      .mockResolvedValueOnce(true)   // attempt 0: collision
      .mockResolvedValueOnce(true)   // attempt 1: collision
      .mockResolvedValue(false);     // attempt 2+: free

    vi.spyOn(queries, "insertUrl").mockResolvedValue(makeRecord({ short_key: "newkey" }));

    const result = await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );

    expect(result).toBeDefined();
    expect(existsSpy).toHaveBeenCalledTimes(3);
  });

  it("handles DB-level ConflictError during concurrent custom alias race", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();

    // keyExists says it's free (race condition window)
    vi.spyOn(queries, "keyExists").mockResolvedValue(false);

    // But DB throws ConflictError (concurrent insert won the race)
    vi.spyOn(queries, "insertUrl").mockRejectedValue(
      new ConflictError("Unique constraint violation")
    );

    await expect(
      shortenUrl(
        { url: "https://example.com", customAlias: "raced-alias" },
        mockDb(),
        MOCK_KV,
        MOCK_ENV
      )
    ).rejects.toMatchObject({ code: "ALIAS_TAKEN" });
  });

  it("falls back to random key after max retries", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();

    // Make all hash-derived keys collide, but allow the random fallback.
    vi.spyOn(queries, "keyExists")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false); // random fallback

    vi.spyOn(queries, "insertUrl").mockResolvedValue(
      makeRecord({ short_key: "random7" })
    );

    const result = await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      { ...MOCK_ENV, COLLISION_MAX_RETRIES: "3" }
    );

    expect(result).toBeDefined();
  });

  it("handles DB ConflictError mid-retry loop and continues to next attempt", async () => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();
    vi.spyOn(queries, "keyExists").mockResolvedValue(false);

    // First insert conflicts, second succeeds
    vi.spyOn(queries, "insertUrl")
      .mockRejectedValueOnce(new ConflictError("collision"))
      .mockResolvedValue(makeRecord({ short_key: "succeed" }));

    const result = await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );

    expect(result.short_key).toBe("succeed");
  });
});

describe("shortenUrl — expiry handling", () => {
  beforeEach(() => {
    vi.spyOn(validator, "isSafeUrl").mockResolvedValue({ safe: true });
    vi.spyOn(cache, "setCached").mockResolvedValue();
    vi.spyOn(queries, "keyExists").mockResolvedValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it("sets expires_at when expiresInDays is provided", async () => {
    const futureDateStr = new Date(Date.now() + 30 * 86_400_000).toISOString();
    vi.spyOn(queries, "insertUrl").mockResolvedValue(
      makeRecord({ expires_at: futureDateStr })
    );

    const result = await shortenUrl(
      { url: "https://example.com", expiresInDays: 30 },
      mockDb(),
      MOCK_KV,
      MOCK_ENV
    );

    expect(result.expires_at).not.toBeNull();
  });

  it("omits expires_at when DEFAULT_TTL_DAYS is 0 (never expire)", async () => {
    vi.spyOn(queries, "insertUrl").mockResolvedValue(makeRecord({ expires_at: null }));

    const result = await shortenUrl(
      { url: "https://example.com" },
      mockDb(),
      MOCK_KV,
      { ...MOCK_ENV, DEFAULT_TTL_DAYS: "0" }
    );

    expect(result.expires_at).toBeNull();
  });
});
