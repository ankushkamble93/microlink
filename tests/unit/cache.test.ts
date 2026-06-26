import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getCached,
  setCached,
  setNegativeCached,
  invalidateCache,
} from "../../src/services/cache";
import type { CacheEntry } from "../../src/types";

function makeKvMock(initial?: Record<string, string>): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

const ENTRY: CacheEntry = {
  long_url: "https://example.com/very/long/path",
  expires_at: null,
};

describe("getCached", () => {
  it("returns null on a true cache miss", async () => {
    const kv = makeKvMock();
    expect(await getCached(kv, "abc123")).toBeNull();
  });

  it("returns the parsed CacheEntry on a hit", async () => {
    const kv = makeKvMock({ "url:abc123": JSON.stringify(ENTRY) });
    const result = await getCached(kv, "abc123");
    expect(result).toEqual(ENTRY);
  });

  it("returns 'MISS' sentinel when negative cache is set", async () => {
    const kv = makeKvMock({ "miss:abc123": "1" });
    const result = await getCached(kv, "abc123");
    expect(result).toBe("MISS");
  });

  it("returns null (not 'MISS') when only positive cache key is corrupt", async () => {
    const kv = makeKvMock({ "url:corrupt": "{{invalid" });
    const result = await getCached(kv, "corrupt");
    expect(result).toBeNull();
  });
});

describe("setCached", () => {
  it("stores the entry in KV", async () => {
    const kv = makeKvMock();
    await setCached(kv, "mykey", ENTRY, null);
    expect(kv.put).toHaveBeenCalledWith(
      "url:mykey",
      JSON.stringify(ENTRY),
      expect.objectContaining({ expirationTtl: 86400 })
    );
  });

  it("uses the URL's expiry as TTL when it's shorter", async () => {
    const kv = makeKvMock();
    const expiresAt = new Date(Date.now() + 3600 * 1000); // 1 hour from now
    await setCached(kv, "mykey", ENTRY, expiresAt);
    const call = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0];
    const opts = call[2] as { expirationTtl: number };
    expect(opts.expirationTtl).toBeLessThanOrEqual(3600);
    expect(opts.expirationTtl).toBeGreaterThan(3590);
  });

  it("does not write to KV when the URL is already expired", async () => {
    const kv = makeKvMock();
    const expiresAt = new Date(Date.now() - 1000); // already expired
    await setCached(kv, "mykey", ENTRY, expiresAt);
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe("setNegativeCached", () => {
  it("writes the negative cache key with a short TTL", async () => {
    const kv = makeKvMock();
    await setNegativeCached(kv, "ghost");
    expect(kv.put).toHaveBeenCalledWith(
      "miss:ghost",
      "1",
      expect.objectContaining({ expirationTtl: 60 })
    );
  });
});

describe("invalidateCache", () => {
  it("deletes both positive and negative cache keys", async () => {
    const kv = makeKvMock({
      "url:mykey": JSON.stringify(ENTRY),
      "miss:mykey": "1",
    });
    await invalidateCache(kv, "mykey");
    expect(kv.delete).toHaveBeenCalledWith("url:mykey");
    expect(kv.delete).toHaveBeenCalledWith("miss:mykey");
  });
});
