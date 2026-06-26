import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateUrl,
  validateAlias,
  isSafeUrl,
  sanitizeReferrer,
  hashIp,
} from "../../src/services/validator";

const BASE_URL = "https://mlnk.io";
const MAX_LENGTH = 2048;

describe("validateUrl", () => {
  // ── Valid URLs ─────────────────────────────────────────────────────────────
  it("accepts a standard https URL", () => {
    const result = validateUrl("https://example.com", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(true);
  });

  it("accepts a http URL", () => {
    const result = validateUrl("http://example.com/path?q=1", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(true);
  });

  it("accepts URLs with paths, query strings, and fragments", () => {
    const result = validateUrl(
      "https://example.com/very/deep/path?foo=bar&baz=qux#section",
      BASE_URL,
      MAX_LENGTH
    );
    expect(result.ok).toBe(true);
  });

  // ── Length Enforcement ────────────────────────────────────────────────────
  it("rejects URLs exceeding max length", () => {
    const longUrl = "https://example.com/" + "a".repeat(2048);
    const result = validateUrl(longUrl, BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("URL_TOO_LONG");
  });

  it("accepts URLs exactly at max length", () => {
    const exactUrl = "https://example.com/" + "a".repeat(MAX_LENGTH - "https://example.com/".length);
    const result = validateUrl(exactUrl, BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(true);
  });

  // ── Protocol Enforcement ──────────────────────────────────────────────────
  it("rejects ftp:// URLs", () => {
    const result = validateUrl("ftp://example.com", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_URL");
  });

  it("rejects javascript: URLs", () => {
    const result = validateUrl("javascript:alert(1)", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_URL");
  });

  it("rejects data: URLs", () => {
    const result = validateUrl("data:text/html,<h1>xss</h1>", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
  });

  // ── SSRF Protection ───────────────────────────────────────────────────────
  it("blocks 127.0.0.1 (loopback)", () => {
    const result = validateUrl("http://127.0.0.1/", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks 10.0.0.1 (private RFC-1918)", () => {
    const result = validateUrl("http://10.0.0.1/api", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks 172.16.0.1 (private RFC-1918)", () => {
    const result = validateUrl("http://172.16.0.1/secret", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks 192.168.1.1 (private RFC-1918)", () => {
    const result = validateUrl("http://192.168.1.1/", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks 169.254.169.254 (AWS metadata)", () => {
    const result = validateUrl("http://169.254.169.254/latest/meta-data/", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks any bare public IPv4", () => {
    const result = validateUrl("http://8.8.8.8/", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  it("blocks IPv6 loopback ::1", () => {
    const result = validateUrl("http://[::1]/", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SSRF_BLOCKED");
  });

  // ── Self-Referential Detection ────────────────────────────────────────────
  it("rejects URLs pointing to the shortener itself", () => {
    const result = validateUrl("https://mlnk.io/abc123", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SELF_REFERENTIAL");
  });

  // ── Embedded Credentials ──────────────────────────────────────────────────
  it("rejects URLs with embedded credentials (user:pass@host)", () => {
    const result = validateUrl("https://admin:secret@example.com", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_URL");
  });

  // ── Malformed URLs ────────────────────────────────────────────────────────
  it("rejects completely malformed strings", () => {
    const result = validateUrl("not a url at all", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_URL");
  });

  it("rejects URLs with no hostname", () => {
    const result = validateUrl("https://", BASE_URL, MAX_LENGTH);
    expect(result.ok).toBe(false);
  });
});

describe("validateAlias", () => {
  it("accepts valid alphanumeric aliases", () => {
    expect(validateAlias("my-link").ok).toBe(true);
    expect(validateAlias("my_link_123").ok).toBe(true);
    expect(validateAlias("AbCdEf").ok).toBe(true);
  });

  it("accepts aliases at minimum length (3)", () => {
    expect(validateAlias("abc").ok).toBe(true);
  });

  it("accepts aliases at maximum length (32)", () => {
    expect(validateAlias("a".repeat(32)).ok).toBe(true);
  });

  it("rejects aliases that are too short (< 3)", () => {
    const result = validateAlias("ab");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ALIAS_INVALID");
  });

  it("rejects aliases that are too long (> 32)", () => {
    const result = validateAlias("a".repeat(33));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ALIAS_INVALID");
  });

  it("rejects aliases with special characters (XSS attempt)", () => {
    expect(validateAlias("<script>alert(1)</script>").ok).toBe(false);
    expect(validateAlias("../etc/passwd").ok).toBe(false);
    expect(validateAlias("alias with spaces").ok).toBe(false);
  });

  it("rejects reserved system paths", () => {
    for (const reserved of ["api", "health", "admin", "analytics", "login"]) {
      const result = validateAlias(reserved);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("ALIAS_INVALID");
    }
  });

  it("rejects reserved paths case-insensitively", () => {
    expect(validateAlias("API").ok).toBe(false);
    expect(validateAlias("Admin").ok).toBe(false);
  });
});

describe("isSafeUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns safe=true when Safe Browsing is disabled", async () => {
    const result = await isSafeUrl("https://example.com", {
      ENABLE_SAFE_BROWSING: "false",
      SAFE_BROWSING_API_KEY: undefined,
    });
    expect(result.safe).toBe(true);
  });

  it("returns safe=true when API key is missing", async () => {
    const result = await isSafeUrl("https://example.com", {
      ENABLE_SAFE_BROWSING: "true",
      SAFE_BROWSING_API_KEY: undefined,
    });
    expect(result.safe).toBe(true);
  });

  it("returns safe=true on API non-2xx response (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await isSafeUrl("https://example.com", {
      ENABLE_SAFE_BROWSING: "true",
      SAFE_BROWSING_API_KEY: "FAKE_KEY",
    });
    expect(result.safe).toBe(true);
  });

  it("returns safe=true on fetch network error (fail-open)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    const result = await isSafeUrl("https://example.com", {
      ENABLE_SAFE_BROWSING: "true",
      SAFE_BROWSING_API_KEY: "FAKE_KEY",
    });
    expect(result.safe).toBe(true);
  });

  it("returns safe=false when API returns matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          matches: [
            {
              threatType: "MALWARE",
              platformType: "ANY_PLATFORM",
              threatEntryType: "URL",
              threat: { url: "https://malware.example.com" },
            },
          ],
        }),
      })
    );

    const result = await isSafeUrl("https://malware.example.com", {
      ENABLE_SAFE_BROWSING: "true",
      SAFE_BROWSING_API_KEY: "FAKE_KEY",
    });

    expect(result.safe).toBe(false);
    expect(result.threat).toBe("MALWARE");
  });

  it("returns safe=true when API returns empty matches", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ matches: [] }),
      })
    );

    const result = await isSafeUrl("https://clean.example.com", {
      ENABLE_SAFE_BROWSING: "true",
      SAFE_BROWSING_API_KEY: "FAKE_KEY",
    });

    expect(result.safe).toBe(true);
  });
});

describe("sanitizeReferrer", () => {
  it("returns hostname for a valid referrer", () => {
    expect(sanitizeReferrer("https://google.com/search?q=foo")).toBe("google.com");
  });

  it("returns null for null input", () => {
    expect(sanitizeReferrer(null)).toBeNull();
  });

  it("returns null for malformed referrers", () => {
    expect(sanitizeReferrer("not a url")).toBeNull();
  });

  it("strips path and query from referrer", () => {
    expect(sanitizeReferrer("https://evil.com/tracking?uid=123")).toBe("evil.com");
  });

  it("returns null for non-http/https referrers", () => {
    expect(sanitizeReferrer("ftp://files.example.com")).toBeNull();
  });
});

describe("hashIp", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await hashIp("1.2.3.4");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await hashIp("192.168.0.1");
    const b = await hashIp("192.168.0.1");
    expect(a).toBe(b);
  });

  it("produces different hashes for different IPs", async () => {
    const a = await hashIp("1.1.1.1");
    const b = await hashIp("8.8.8.8");
    expect(a).not.toBe(b);
  });

  it("is one-way (hash does not reveal IP)", async () => {
    const hash = await hashIp("192.168.1.100");
    expect(hash).not.toContain("192");
  });
});
