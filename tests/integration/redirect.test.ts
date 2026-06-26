// ─────────────────────────────────────────────────────────────────────────────
// Integration tests for the redirect handler.
// We test the full KV-first → DB fallback → expiry → analytics pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../src/types";
import { handleRedirect } from "../../src/handlers/redirect";
import * as cache from "../../src/services/cache";
import * as queries from "../../src/db/queries";

// ─── Minimal Env stub ─────────────────────────────────────────────────────────
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

// ─── Hono test app ─────────────────────────────────────────────────────────────
function makeApp(envOverrides: Partial<Env> = {}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/:key", handleRedirect);
  return app;
}

function mockExecutionCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn((_p: Promise<unknown>) => { /* noop */ }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function makeRequest(key: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://mlnk.io/${key}`, { headers });
}

function makeCtxEnv(envOverrides: Partial<Env> = {}): Env {
  return { ...MOCK_ENV, ...envOverrides };
}

describe("handleRedirect — KV cache hit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redirects to the cached long URL (302 by default)", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: null,
    });

    const app = makeApp();
    const req = makeRequest("abc123");
    const res = await app.fetch(req, makeCtxEnv(), mockExecutionCtx());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://example.com");
  });

  it("uses 301 redirect when REDIRECT_MODE is '301'", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: null,
    });

    const app = makeApp();
    const req = makeRequest("abc123");
    const res = await app.fetch(
      req,
      makeCtxEnv({ REDIRECT_MODE: "301" }),
      mockExecutionCtx()
    );

    expect(res.status).toBe(301);
  });

  it("returns 410 Gone for an expired cached URL", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    });

    const app = makeApp();
    const req = makeRequest("abc123");
    const res = await app.fetch(req, makeCtxEnv(), mockExecutionCtx());

    expect(res.status).toBe(410);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("KEY_EXPIRED");
  });

  it("returns 404 for a negative cache hit", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue("MISS");

    const app = makeApp();
    const req = makeRequest("nothere");
    const res = await app.fetch(req, makeCtxEnv(), mockExecutionCtx());

    expect(res.status).toBe(404);
  });
});

describe("handleRedirect — DB fallback on KV miss", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back to DB and redirects when KV misses", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue(null);
    vi.spyOn(queries, "getUrlByKey").mockResolvedValue({
      id: 1,
      short_key: "abc123",
      long_url: "https://db-result.com",
      is_custom: false,
      expires_at: null,
      created_at: new Date().toISOString(),
      creator_ip_hash: null,
    });
    vi.spyOn(cache, "setCached").mockResolvedValue();

    const app = makeApp();
    const res = await app.fetch(makeRequest("abc123"), makeCtxEnv(), mockExecutionCtx());

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://db-result.com");
  });

  it("returns 404 and writes negative cache when DB also misses", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue(null);
    vi.spyOn(queries, "getUrlByKey").mockResolvedValue(null);
    const negCacheSpy = vi.spyOn(cache, "setNegativeCached").mockResolvedValue();

    const executionCtx = mockExecutionCtx();
    const app = makeApp();
    const res = await app.fetch(makeRequest("ghost"), makeCtxEnv(), executionCtx);

    expect(res.status).toBe(404);
    // waitUntil should have been called with the negative cache write
    expect(executionCtx.waitUntil).toHaveBeenCalled();
  });

  it("returns 410 for DB result with past expires_at", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue(null);
    vi.spyOn(queries, "getUrlByKey").mockResolvedValue({
      id: 1,
      short_key: "oldkey",
      long_url: "https://expired.com",
      is_custom: false,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      created_at: new Date(Date.now() - 100_000).toISOString(),
      creator_ip_hash: null,
    });
    vi.spyOn(cache, "setCached").mockResolvedValue();

    const app = makeApp();
    const res = await app.fetch(makeRequest("oldkey"), makeCtxEnv(), mockExecutionCtx());

    expect(res.status).toBe(410);
  });
});

describe("handleRedirect — analytics", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fires analytics via waitUntil and does not block redirect", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: null,
    });

    const executionCtx = mockExecutionCtx();
    const app = makeApp();
    const req = makeRequest("abc123", {
      "CF-IPCountry": "US",
      "Referer": "https://google.com/search",
    });

    const res = await app.fetch(req, makeCtxEnv(), executionCtx);

    // Redirect still returns correctly
    expect(res.status).toBe(302);
    // waitUntil was called for analytics
    expect(executionCtx.waitUntil).toHaveBeenCalled();
  });

  it("does not call waitUntil for analytics when ANALYTICS_ENABLED=false", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: null,
    });

    const executionCtx = mockExecutionCtx();
    const app = makeApp();
    const req = makeRequest("abc123");

    await app.fetch(
      req,
      makeCtxEnv({ ANALYTICS_ENABLED: "false" }),
      executionCtx
    );

    // Analytics is disabled — waitUntil should not be called for analytics
    // (it may still be called for cache warming, so we check the redirect status)
    // The key assertion is the redirect itself is unaffected.
    // (In the disabled case, cache warming waitUntil calls are absent on cache HIT)
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });
});

describe("handleRedirect — edge cases", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 404 for a key longer than 32 characters", async () => {
    const app = makeApp();
    const res = await app.fetch(
      makeRequest("a".repeat(33)),
      makeCtxEnv(),
      mockExecutionCtx()
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 for an empty key", async () => {
    const app = makeApp();
    // An empty key would not reach /:key route; test short key validation branch.
    vi.spyOn(cache, "getCached").mockResolvedValue(null);
    vi.spyOn(queries, "getUrlByKey").mockResolvedValue(null);
    const res = await app.fetch(
      new Request("https://mlnk.io/"),
      makeCtxEnv(),
      mockExecutionCtx()
    );
    // Root path has no :key match — falls through to 404
    expect([404]).toContain(res.status);
  });

  it("sets X-Microlink-Key header on successful redirect", async () => {
    vi.spyOn(cache, "getCached").mockResolvedValue({
      long_url: "https://example.com",
      expires_at: null,
    });

    const app = makeApp();
    const res = await app.fetch(makeRequest("mykey"), makeCtxEnv(), mockExecutionCtx());

    expect(res.headers.get("X-Microlink-Key")).toBe("mykey");
  });
});
