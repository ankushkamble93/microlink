import { describe, it, expect } from "vitest";
import {
  encodeBase62,
  decodeBase62,
  shuffleId,
  idToKey,
  generateRandomKey,
  urlToKey,
  parseSeed,
} from "../../src/services/encoder";

describe("parseSeed", () => {
  it("returns default seed when undefined", () => {
    const seed = parseSeed(undefined);
    expect(seed).toBe(2654435761n);
  });

  it("returns default seed for empty string", () => {
    expect(parseSeed("")).toBe(2654435761n);
  });

  it("parses a valid positive integer string", () => {
    expect(parseSeed("12345")).toBe(12345n);
  });

  it("returns default seed for negative input", () => {
    expect(parseSeed("-1")).toBe(2654435761n);
  });

  it("returns default seed for non-numeric string", () => {
    expect(parseSeed("abc")).toBe(2654435761n);
  });
});

describe("encodeBase62", () => {
  it("encodes 0 to '000000'", () => {
    expect(encodeBase62(0, 6)).toBe("000000");
  });

  it("encodes 1 correctly", () => {
    expect(encodeBase62(1, 6)).toBe("000001");
  });

  it("encodes 61 to 'z' (last Base62 char)", () => {
    // 61 in base62 = 'z'
    expect(encodeBase62(61, 1)).toBe("z");
  });

  it("encodes 62 to '10'", () => {
    expect(encodeBase62(62, 2)).toBe("10");
  });

  it("pads to minimum length", () => {
    expect(encodeBase62(1, 8).length).toBe(8);
  });

  it("does not truncate values exceeding minLength", () => {
    const encoded = encodeBase62(62 ** 7, 6);
    expect(encoded.length).toBeGreaterThan(6);
  });

  it("throws for negative numbers", () => {
    expect(() => encodeBase62(-1)).toThrow(RangeError);
  });

  it("throws for non-integer", () => {
    expect(() => encodeBase62(1.5)).toThrow(RangeError);
  });

  it("large value round-trips correctly", () => {
    const n = 1_000_000_000;
    const encoded = encodeBase62(n, 6);
    expect(decodeBase62(encoded)).toBe(n);
  });
});

describe("decodeBase62", () => {
  it("decodes '0' to 0", () => {
    expect(decodeBase62("0")).toBe(0);
  });

  it("decodes '10' to 62", () => {
    expect(decodeBase62("10")).toBe(62);
  });

  it("throws for empty string", () => {
    expect(() => decodeBase62("")).toThrow(RangeError);
  });

  it("throws for invalid character", () => {
    expect(() => decodeBase62("abc!")).toThrow(RangeError);
  });

  it("round-trips with encodeBase62", () => {
    for (const n of [0, 1, 61, 62, 999, 123456, 999999999]) {
      expect(decodeBase62(encodeBase62(n, 1))).toBe(n);
    }
  });
});

describe("shuffleId", () => {
  it("is deterministic for the same seed", () => {
    const a = shuffleId(42, 2654435761n);
    const b = shuffleId(42, 2654435761n);
    expect(a).toBe(b);
  });

  it("produces different outputs for different IDs", () => {
    const a = shuffleId(1);
    const b = shuffleId(2);
    expect(a).not.toBe(b);
  });

  it("is a bijection — no two IDs map to the same shuffled value", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const shuffled = shuffleId(i);
      expect(seen.has(shuffled)).toBe(false);
      seen.add(shuffled);
    }
  });

  it("output is within 32-bit unsigned range", () => {
    for (let i = 0; i < 100; i++) {
      const shuffled = shuffleId(i);
      expect(shuffled).toBeGreaterThanOrEqual(0);
      expect(shuffled).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("handles id=0", () => {
    expect(() => shuffleId(0)).not.toThrow();
  });

  it("handles MAX_SAFE_INTEGER-like inputs gracefully", () => {
    // shuffleId coerces to 32-bit so only lower 32 bits matter
    const result = shuffleId(2 ** 32 - 1);
    expect(typeof result).toBe("number");
  });
});

describe("idToKey", () => {
  it("returns a string of at least minLength chars", () => {
    expect(idToKey(1, undefined, 6).length).toBeGreaterThanOrEqual(6);
  });

  it("is deterministic", () => {
    expect(idToKey(100)).toBe(idToKey(100));
  });

  it("different IDs produce different keys", () => {
    expect(idToKey(1)).not.toBe(idToKey(2));
  });
});

describe("generateRandomKey", () => {
  it("returns a key of the requested length", () => {
    expect(generateRandomKey(7).length).toBe(7);
    expect(generateRandomKey(12).length).toBe(12);
  });

  it("contains only Base62 characters", () => {
    const alphabet = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    const key = generateRandomKey(20);
    for (const char of key) {
      expect(alphabet.has(char)).toBe(true);
    }
  });

  it("generates unique keys across multiple calls (statistical test)", () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateRandomKey(7)));
    // With 62^7 ≈ 3.5T possibilities, 500 draws should all be unique.
    expect(keys.size).toBe(500);
  });
});

describe("urlToKey", () => {
  it("returns a string of the requested length", async () => {
    const key = await urlToKey("https://example.com", "", 7);
    expect(key.length).toBe(7);
  });

  it("is deterministic for the same url + salt", async () => {
    const a = await urlToKey("https://example.com", "salt1", 7);
    const b = await urlToKey("https://example.com", "salt1", 7);
    expect(a).toBe(b);
  });

  it("different URLs produce different keys (collision resistance)", async () => {
    const a = await urlToKey("https://example.com/a", "", 7);
    const b = await urlToKey("https://example.com/b", "", 7);
    expect(a).not.toBe(b);
  });

  it("different salts produce different keys (collision resolution)", async () => {
    const url = "https://example.com";
    const a = await urlToKey(url, "", 7);
    const b = await urlToKey(url, "1", 7);
    const c = await urlToKey(url, "2", 7);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("contains only Base62 characters", async () => {
    const alphabet = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
    const key = await urlToKey("https://test.io/path?query=value#hash", "", 7);
    for (const char of key) {
      expect(alphabet.has(char)).toBe(true);
    }
  });
});
