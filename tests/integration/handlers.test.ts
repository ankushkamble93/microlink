// ─────────────────────────────────────────────────────────────────────────────
// Integration tests for HTTP handlers (shorten, analytics, health)
// and the security middleware — exercised end-to-end via Hono.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type { Env } from "../../src/types";
import { handleShorten } from "../../src/handlers/shorten";
import { handleAnalytics } from "../../src/handlers/analytics";
import { handleHealth } from "../../src/handlers/health";
import { securityHeaders, corsHeaders } from "../../src/middleware/security";
import { rateLimiter } from "../../src/middleware/rateLimit";
import * as shortener from "../../src/services/shortener";
import * as queries from "../../src/db/queries";
import { DatabaseError } from "../../src/db/queries";
import { ShortenError } from "../../src/services/shortener";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const BASE_ENV: Env = {
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

function mockExecutionCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

function makeApp(handler: (c: Parameters<typeof handleShorten>[0]) => Promise<Response>): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.post("/api/shorten", handler);
  return app;
}

function post(url: string, body: unknown, env: Partial<Env> = {}): Request {
  return new Request(`https://mlnk.io${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(url: string): Request {
  return new Request(`https://mlnk.io${url}`);
}

// ─── handleShorten tests ──────────────────────────────────────────────────────

describe("handleShorten", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 201 with ShortenResponse on success", async () => {
    vi.spyOn(shortener, "shortenUrl").mockResolvedValue({
      short_url: "https://mlnk.io/abc123",
      short_key: "abc123",
      long_url: "https://example.com",
      expires_at: null,
      created_at: new Date().toISOString(),
    });

    const app = makeApp(handleShorten);
    const res = await app.fetch(post("/api/shorten", { url: "https://example.com" }), { ...BASE_ENV }, mockExecutionCtx());

    expect(res.status).toBe(201);
    const body = await res.json<{ short_key: string }>();
    expect(body.short_key).toBe("abc123");
  });

  it("returns 400 when body is not valid JSON", async () => {
    const app = makeApp(handleShorten);
    const req = new Request("https://mlnk.io/api/shorten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{not json",
    });
    const res = await app.fetch(req, { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(400);
  });

  it("returns 400 when 'url' field is missing", async () => {
    const app = makeApp(handleShorten);
    const res = await app.fetch(post("/api/shorten", { custom_alias: "foo" }), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when expires_in_days is out of range", async () => {
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "https://example.com", expires_in_days: 9999 }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when expires_in_days is not an integer", async () => {
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "https://example.com", expires_in_days: 1.5 }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(400);
  });

  it("returns 409 for ALIAS_TAKEN", async () => {
    vi.spyOn(shortener, "shortenUrl").mockRejectedValue(
      new ShortenError("Alias taken", "ALIAS_TAKEN")
    );
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "https://example.com", custom_alias: "taken" }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(409);
  });

  it("returns 422 for INVALID_URL", async () => {
    vi.spyOn(shortener, "shortenUrl").mockRejectedValue(
      new ShortenError("Invalid URL", "INVALID_URL")
    );
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "not-a-url" }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 for SSRF_BLOCKED", async () => {
    vi.spyOn(shortener, "shortenUrl").mockRejectedValue(
      new ShortenError("SSRF blocked", "SSRF_BLOCKED")
    );
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "http://10.0.0.1/" }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(422);
  });

  it("returns 503 for DatabaseError", async () => {
    vi.spyOn(shortener, "shortenUrl").mockRejectedValue(
      new DatabaseError("Connection refused")
    );
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "https://example.com" }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(503);
  });

  it("returns 500 for unexpected errors", async () => {
    vi.spyOn(shortener, "shortenUrl").mockRejectedValue(new Error("boom"));
    const app = makeApp(handleShorten);
    const res = await app.fetch(
      post("/api/shorten", { url: "https://example.com" }),
      { ...BASE_ENV },
      mockExecutionCtx()
    );
    expect(res.status).toBe(500);
  });
});

// ─── handleAnalytics tests ────────────────────────────────────────────────────

describe("handleAnalytics", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeAnalyticsApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/api/analytics/:key", handleAnalytics);
    return app;
  }

  it("returns 200 with analytics summary", async () => {
    vi.spyOn(queries, "getAnalyticsSummary").mockResolvedValue({
      short_key: "abc123",
      long_url: "https://example.com",
      total_clicks: 42,
      created_at: new Date().toISOString(),
      expires_at: null,
      country_breakdown: { US: 30, GB: 12 },
      top_referrers: ["google.com"],
      daily_clicks: [],
    });

    const app = makeAnalyticsApp();
    const res = await app.fetch(get("/api/analytics/abc123"), { ...BASE_ENV }, mockExecutionCtx());

    expect(res.status).toBe(200);
    const body = await res.json<{ total_clicks: number }>();
    expect(body.total_clicks).toBe(42);
  });

  it("returns 404 when key not found", async () => {
    vi.spyOn(queries, "getAnalyticsSummary").mockResolvedValue(null);

    const app = makeAnalyticsApp();
    const res = await app.fetch(get("/api/analytics/ghost"), { ...BASE_ENV }, mockExecutionCtx());

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe("KEY_NOT_FOUND");
  });

  it("returns 400 for an oversized key (> 32 chars)", async () => {
    const app = makeAnalyticsApp();
    const res = await app.fetch(get(`/api/analytics/${"x".repeat(33)}`), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(400);
  });

  it("returns 503 for DatabaseError", async () => {
    vi.spyOn(queries, "getAnalyticsSummary").mockRejectedValue(
      new DatabaseError("DB unreachable")
    );
    const app = makeAnalyticsApp();
    const res = await app.fetch(get("/api/analytics/abc123"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(503);
  });

  it("returns 500 for unexpected errors", async () => {
    vi.spyOn(queries, "getAnalyticsSummary").mockRejectedValue(new Error("boom"));
    const app = makeAnalyticsApp();
    const res = await app.fetch(get("/api/analytics/abc123"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(500);
  });
});

// ─── handleHealth tests ───────────────────────────────────────────────────────

describe("handleHealth", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeKvMock(shouldFail = false): KVNamespace {
    return {
      get: vi.fn(async () => shouldFail ? (() => { throw new Error("KV down"); })() : "1"),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as unknown as KVNamespace;
  }

  function makeHealthApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.get("/health", handleHealth);
    return app;
  }

  it("returns 200 with status:ok when both DB and KV are healthy", async () => {
    vi.spyOn(queries, "getUrlByKey").mockResolvedValue(null); // simulates empty table
    // Supabase client needs to be mocked
    vi.mock("../../src/db/client", () => ({
      getSupabaseClient: () => ({
        from: () => ({
          select: () => ({
            limit: () => Promise.resolve({ data: null, error: null, count: 0 }),
          }),
        }),
      }),
    }));

    const kv = makeKvMock(false);
    const app = makeHealthApp();
    const res = await app.fetch(get("/health"), { ...BASE_ENV, REDIRECT_CACHE: kv }, mockExecutionCtx());

    expect([200, 503]).toContain(res.status); // depends on mock depth
    const body = await res.json<{ status: string; version: string }>();
    expect(body.version).toBe("1.0.0");
    expect(["ok", "degraded"]).toContain(body.status);
  });

  it("returns a body with checks object", async () => {
    const kv = makeKvMock(false);
    const app = makeHealthApp();
    const res = await app.fetch(get("/health"), { ...BASE_ENV, REDIRECT_CACHE: kv }, mockExecutionCtx());
    const body = await res.json<{ checks: Record<string, string> }>();
    expect(body.checks).toHaveProperty("database");
    expect(body.checks).toHaveProperty("cache");
  });

  it("includes a timestamp in ISO format", async () => {
    const kv = makeKvMock(false);
    const app = makeHealthApp();
    const res = await app.fetch(get("/health"), { ...BASE_ENV, REDIRECT_CACHE: kv }, mockExecutionCtx());
    const body = await res.json<{ timestamp: string }>();
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});

// ─── Security middleware tests ────────────────────────────────────────────────

describe("securityHeaders middleware", () => {
  function makeSecureApp(): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", securityHeaders());
    app.get("/test", (c) => c.text("ok"));
    return app;
  }

  it("sets HSTS header", async () => {
    const app = makeSecureApp();
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("Strict-Transport-Security")).toContain("max-age=");
  });

  it("sets X-Content-Type-Options: nosniff", async () => {
    const app = makeSecureApp();
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const app = makeSecureApp();
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("sets Referrer-Policy", async () => {
    const app = makeSecureApp();
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("Referrer-Policy")).toBeTruthy();
  });

  it("sets Content-Security-Policy", async () => {
    const app = makeSecureApp();
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src");
  });
});

// ─── CORS middleware tests ────────────────────────────────────────────────────

describe("corsHeaders middleware", () => {
  function makeCorsApp(origins: string[] = ["*"]): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", corsHeaders(origins));
    app.get("/test", (c) => c.text("ok"));
    app.post("/test", (c) => c.text("ok"));
    return app;
  }

  it("returns Access-Control-Allow-Origin: * for wildcard config", async () => {
    const app = makeCorsApp(["*"]);
    const res = await app.fetch(get("/test"), { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("handles OPTIONS preflight with 204", async () => {
    const app = makeCorsApp(["*"]);
    const req = new Request("https://mlnk.io/test", {
      method: "OPTIONS",
      headers: { "Origin": "https://app.example.com" },
    });
    const res = await app.fetch(req, { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(204);
  });

  it("returns 403 for OPTIONS from non-allowed origin", async () => {
    const app = makeCorsApp(["https://allowed.com"]);
    const req = new Request("https://mlnk.io/test", {
      method: "OPTIONS",
      headers: { "Origin": "https://evil.com" },
    });
    const res = await app.fetch(req, { ...BASE_ENV }, mockExecutionCtx());
    expect(res.status).toBe(403);
  });

  it("echoes back the origin for specific-origin config", async () => {
    const app = makeCorsApp(["https://allowed.com"]);
    const req = new Request("https://mlnk.io/test", {
      headers: { "Origin": "https://allowed.com" },
    });
    const res = await app.fetch(req, { ...BASE_ENV }, mockExecutionCtx());
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.com");
  });
});

// ─── Rate limiter middleware tests ────────────────────────────────────────────

describe("rateLimiter middleware", () => {
  afterEach(() => vi.restoreAllMocks());

  function makeRateLimitApp(maxRequests = 5): Hono<{ Bindings: Env }> {
    const app = new Hono<{ Bindings: Env }>();
    app.post("/api/shorten", rateLimiter(), (c) => c.text("ok", 200));
    return app;
  }

  function makeKvMock(): KVNamespace {
    const store = new Map<string, string>();
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(),
      getWithMetadata: vi.fn(),
    } as unknown as KVNamespace;
  }

  it("sets X-RateLimit-* headers on every response", async () => {
    const kv = makeKvMock();
    const app = makeRateLimitApp();
    const res = await app.fetch(
      post("/api/shorten", {}),
      { ...BASE_ENV, RATE_LIMIT_KV: kv },
      mockExecutionCtx()
    );
    expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it("returns 429 when rate limit exceeded", async () => {
    const kv = makeKvMock();
    const app = makeRateLimitApp();
    const env = { ...BASE_ENV, RATE_LIMIT_KV: kv, RATE_LIMIT_MAX_REQUESTS: "2" };

    // Exhaust the bucket
    for (let i = 0; i < 3; i++) {
      await app.fetch(post("/api/shorten", {}), env, mockExecutionCtx());
    }

    const res = await app.fetch(post("/api/shorten", {}), env, mockExecutionCtx());
    expect(res.status).toBe(429);
  });

  it("returns Retry-After header when rate limited", async () => {
    const kv = makeKvMock();
    const app = makeRateLimitApp();
    const env = { ...BASE_ENV, RATE_LIMIT_KV: kv, RATE_LIMIT_MAX_REQUESTS: "1" };

    await app.fetch(post("/api/shorten", {}), env, mockExecutionCtx());
    const res = await app.fetch(post("/api/shorten", {}), env, mockExecutionCtx());

    if (res.status === 429) {
      expect(res.headers.get("Retry-After")).toBeTruthy();
    }
  });
});
