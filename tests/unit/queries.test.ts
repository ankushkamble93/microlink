// ─────────────────────────────────────────────────────────────────────────────
// Unit tests for the DB query layer.
// We mock the Supabase client's fluent builder chain to test all branches.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getUrlByKey,
  keyExists,
  insertUrl,
  deleteUrl,
  insertAnalyticsEvent,
  getAnalyticsSummary,
  DatabaseError,
  ConflictError,
} from "../../src/db/queries";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Supabase chain builder mock ──────────────────────────────────────────────
// Supabase uses a fluent builder pattern: .from().select().eq().single() etc.
// Some chains resolve via .single() / .limit(), others are directly thenable
// (the chain object itself is a Promise-like via .then() on the builder).
// We make the chain object thenable AND provide terminal methods.

type ChainResult = { data?: unknown; error?: unknown; count?: number | null };

function makeChain(result: ChainResult): Record<string, unknown> {
  // Make the chain itself thenable (handles `await db.from().select().eq()` patterns)
  const resolved = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    then: (onfulfilled: (v: ChainResult) => unknown, onrejected: (r: unknown) => unknown) =>
      resolved.then(onfulfilled, onrejected),
    catch: (onrejected: (r: unknown) => unknown) => resolved.catch(onrejected),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    insert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    order: vi.fn().mockReturnThis(),
  };
  return chain;
}

function makeDb(chainResult: ChainResult): SupabaseClient {
  const chain = makeChain(chainResult);
  return {
    from: vi.fn().mockReturnValue(chain),
  } as unknown as SupabaseClient;
}

// ─── getUrlByKey ──────────────────────────────────────────────────────────────

describe("getUrlByKey", () => {
  it("returns the record on success", async () => {
    const record = {
      id: 1,
      short_key: "abc123",
      long_url: "https://example.com",
      is_custom: false,
      expires_at: null,
      created_at: "2024-01-01T00:00:00Z",
      creator_ip_hash: null,
    };
    const db = makeDb({ data: record, error: null });
    const result = await getUrlByKey(db, "abc123");
    expect(result).toEqual(record);
  });

  it("returns null on PGRST116 (no rows)", async () => {
    const db = makeDb({ data: null, error: { code: "PGRST116", message: "no rows" } });
    const result = await getUrlByKey(db, "missing");
    expect(result).toBeNull();
  });

  it("throws DatabaseError on other DB errors", async () => {
    const db = makeDb({ data: null, error: { code: "XXXXX", message: "other error" } });
    await expect(getUrlByKey(db, "abc")).rejects.toThrow(DatabaseError);
  });
});

// ─── keyExists ────────────────────────────────────────────────────────────────

describe("keyExists", () => {
  it("returns true when count > 0", async () => {
    const db = makeDb({ count: 1, error: null });
    const result = await keyExists(db, "abc123");
    expect(result).toBe(true);
  });

  it("returns false when count is 0", async () => {
    const db = makeDb({ count: 0, error: null });
    const result = await keyExists(db, "abc123");
    expect(result).toBe(false);
  });

  it("returns false when count is null", async () => {
    const db = makeDb({ count: null, error: null });
    const result = await keyExists(db, "abc123");
    expect(result).toBe(false);
  });

  it("throws DatabaseError on error", async () => {
    const db = makeDb({ error: { code: "XXXXX", message: "fail" } });
    await expect(keyExists(db, "abc")).rejects.toThrow(DatabaseError);
  });
});

// ─── insertUrl ────────────────────────────────────────────────────────────────

describe("insertUrl", () => {
  const params = {
    short_key: "newkey",
    long_url: "https://example.com",
    is_custom: false,
    expires_at: null,
    creator_ip_hash: null,
  };

  it("returns the inserted record on success", async () => {
    const record = { id: 42, ...params, created_at: "2024-01-01T00:00:00Z" };
    const db = makeDb({ data: record, error: null });
    const result = await insertUrl(db, params);
    expect(result).toEqual(record);
  });

  it("throws ConflictError on unique violation (23505)", async () => {
    const db = makeDb({ data: null, error: { code: "23505", message: "unique violation" } });
    await expect(insertUrl(db, params)).rejects.toThrow(ConflictError);
  });

  it("throws DatabaseError on other errors", async () => {
    const db = makeDb({ data: null, error: { code: "XXXXX", message: "fail" } });
    await expect(insertUrl(db, params)).rejects.toThrow(DatabaseError);
  });
});

// ─── deleteUrl ────────────────────────────────────────────────────────────────

describe("deleteUrl", () => {
  it("resolves without error on success", async () => {
    const db = makeDb({ error: null });
    await expect(deleteUrl(db, "abc123")).resolves.toBeUndefined();
  });

  it("throws DatabaseError on error", async () => {
    const db = makeDb({ error: { code: "XXXXX", message: "fail" } });
    await expect(deleteUrl(db, "abc123")).rejects.toThrow(DatabaseError);
  });
});

// ─── insertAnalyticsEvent ─────────────────────────────────────────────────────

describe("insertAnalyticsEvent", () => {
  const event = {
    short_key: "abc123",
    clicked_at: new Date().toISOString(),
    country_code: "US",
    referrer_host: "google.com",
  };

  it("resolves without error on success", async () => {
    const db = makeDb({ error: null });
    await expect(insertAnalyticsEvent(db, event)).resolves.toBeUndefined();
  });

  it("warns but does not throw on error (non-fatal analytics)", async () => {
    const db = makeDb({ error: { code: "XXXXX", message: "fail" } });
    // Should NOT throw — analytics failures are non-fatal
    await expect(insertAnalyticsEvent(db, event)).resolves.toBeUndefined();
  });
});

// ─── Error classes ────────────────────────────────────────────────────────────

describe("DatabaseError", () => {
  it("has the correct name and message", () => {
    const err = new DatabaseError("something failed", "42P01");
    expect(err.name).toBe("DatabaseError");
    expect(err.message).toBe("something failed");
    expect(err.code).toBe("42P01");
  });

  it("works without a code", () => {
    const err = new DatabaseError("no code");
    expect(err.code).toBeUndefined();
  });
});

describe("ConflictError", () => {
  it("has the correct name", () => {
    const err = new ConflictError("conflict");
    expect(err.name).toBe("ConflictError");
  });
});
