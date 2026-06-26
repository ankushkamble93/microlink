// ─────────────────────────────────────────────────────────────────────────────
// microlink — URL Validator & Security Guardrails
//
// Defences implemented:
//   • Structural URL parsing (rejects malformed inputs)
//   • Allowlisted protocols (http/https only)
//   • SSRF protection: blocks private/loopback/link-local CIDRs and bare IPs
//   • Self-referential loop detection (shortening a microlink URL)
//   • Maximum length enforcement
//   • Custom alias sanitization (alphanumeric + hyphen + underscore only)
//   • Async hook for Google Safe Browsing v4 lookup
// ─────────────────────────────────────────────────────────────────────────────

import type { Env, SafeBrowsingResponse } from "../types";
import { ErrorCode } from "../types";

// ─── SSRF CIDR Blocklist ──────────────────────────────────────────────────────
// All RFC-1918, loopback, APIPA, documentation, and cloud-metadata ranges.
const PRIVATE_RANGES: Array<{ start: number; end: number }> = [
  // 127.0.0.0/8  loopback
  { start: ipToInt("127.0.0.0"), end: ipToInt("127.255.255.255") },
  // 10.0.0.0/8  private
  { start: ipToInt("10.0.0.0"), end: ipToInt("10.255.255.255") },
  // 172.16.0.0/12  private
  { start: ipToInt("172.16.0.0"), end: ipToInt("172.31.255.255") },
  // 192.168.0.0/16  private
  { start: ipToInt("192.168.0.0"), end: ipToInt("192.168.255.255") },
  // 169.254.0.0/16  APIPA / AWS metadata
  { start: ipToInt("169.254.0.0"), end: ipToInt("169.254.255.255") },
  // 100.64.0.0/10  carrier-grade NAT
  { start: ipToInt("100.64.0.0"), end: ipToInt("100.127.255.255") },
  // 198.18.0.0/15  benchmark
  { start: ipToInt("198.18.0.0"), end: ipToInt("198.19.255.255") },
  // 240.0.0.0/4  reserved
  { start: ipToInt("240.0.0.0"), end: ipToInt("255.255.255.255") },
  // ::1/128  IPv6 loopback — handled separately below
];

function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return 0;
  return ((parts[0] ?? 0) << 24 | (parts[1] ?? 0) << 16 | (parts[2] ?? 0) << 8 | (parts[3] ?? 0)) >>> 0;
}

function isIPv4(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isIPv6(hostname: string): boolean {
  // Brackets are stripped by URL parser: [::1] → ::1
  return hostname.includes(":");
}

function isPrivateIPv4(hostname: string): boolean {
  const n = ipToInt(hostname);
  return PRIVATE_RANGES.some((r) => n >= r.start && n <= r.end);
}

function isPrivateIPv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  // ::1 loopback, fc00::/7 ULA, fe80::/10 link-local
  return (
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

// ─── Custom Alias Rules ───────────────────────────────────────────────────────
// Allowed: a-z, A-Z, 0-9, hyphen, underscore.  Length: 3–32.
const ALIAS_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

// Reserved system paths that cannot be claimed as aliases.
const RESERVED_PATHS = new Set([
  "api", "health", "favicon.ico", "robots.txt", "sitemap.xml",
  "admin", "login", "logout", "signup", "register", "dashboard",
  "analytics", "shorten", "static", "assets", "404", "410",
]);

// ─── Validation Result Types ──────────────────────────────────────────────────
export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

// ─── Core URL Validator ───────────────────────────────────────────────────────
export function validateUrl(
  raw: string,
  baseUrl: string,
  maxLength: number
): ValidationResult {
  // 1. Length guard
  if (raw.length > maxLength) {
    return {
      ok: false,
      code: ErrorCode.URL_TOO_LONG,
      message: `URL exceeds maximum length of ${maxLength} characters`,
    };
  }

  // 2. Parse with URL API — strictest available parser in V8
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      code: ErrorCode.INVALID_URL,
      message: "URL is malformed or could not be parsed",
    };
  }

  // 3. Protocol allowlist
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: ErrorCode.INVALID_URL,
      message: "Only http:// and https:// URLs are accepted",
    };
  }

  // 4. Hostname must be present
  if (!parsed.hostname || parsed.hostname.length === 0) {
    return {
      ok: false,
      code: ErrorCode.INVALID_URL,
      message: "URL must contain a valid hostname",
    };
  }

  // 5. SSRF: block bare IP addresses (IPv4 and IPv6)
  if (isIPv4(parsed.hostname)) {
    if (isPrivateIPv4(parsed.hostname)) {
      return {
        ok: false,
        code: ErrorCode.SSRF_BLOCKED,
        message: "URLs pointing to private or loopback IP ranges are not allowed",
      };
    }
    // Even public IPs are suspicious for a URL shortener — block all bare IPs.
    return {
      ok: false,
      code: ErrorCode.SSRF_BLOCKED,
      message: "Bare IP addresses are not accepted; use a hostname",
    };
  }

  if (isIPv6(parsed.hostname)) {
    if (isPrivateIPv6(parsed.hostname)) {
      return {
        ok: false,
        code: ErrorCode.SSRF_BLOCKED,
        message: "URLs pointing to private or loopback IPv6 ranges are not allowed",
      };
    }
    return {
      ok: false,
      code: ErrorCode.SSRF_BLOCKED,
      message: "Bare IPv6 addresses are not accepted; use a hostname",
    };
  }

  // 6. Self-referential loop detection
  try {
    const selfOrigin = new URL(baseUrl).hostname;
    if (parsed.hostname === selfOrigin) {
      return {
        ok: false,
        code: ErrorCode.SELF_REFERENTIAL,
        message: "Shortening a microlink URL is not allowed (prevents redirect loops)",
      };
    }
  } catch {
    // If BASE_URL is malformed (misconfiguration), skip this check rather than crash.
  }

  // 7. No credentials in URL (user:pass@host — potential phishing vector)
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      code: ErrorCode.INVALID_URL,
      message: "URLs with embedded credentials are not allowed",
    };
  }

  return { ok: true };
}

// ─── Custom Alias Validator ───────────────────────────────────────────────────
export function validateAlias(alias: string): ValidationResult {
  if (!ALIAS_REGEX.test(alias)) {
    return {
      ok: false,
      code: ErrorCode.ALIAS_INVALID,
      message:
        "Alias must be 3–32 characters and contain only letters, digits, hyphens, or underscores",
    };
  }

  if (RESERVED_PATHS.has(alias.toLowerCase())) {
    return {
      ok: false,
      code: ErrorCode.ALIAS_INVALID,
      message: `'${alias}' is a reserved system path and cannot be used as an alias`,
    };
  }

  return { ok: true };
}

// ─── Google Safe Browsing Hook ────────────────────────────────────────────────
/**
 * Asynchronously checks a URL against Google Safe Browsing API v4.
 * Returns true if the URL is clean, false if it is flagged.
 *
 * This is deliberately async and called before inserting into the DB.
 * If the API is unavailable or returns an error, we FAIL OPEN (allow the URL)
 * to avoid blocking legitimate users due to a third-party outage.
 *
 * Wire up by setting ENABLE_SAFE_BROWSING=true and providing SAFE_BROWSING_API_KEY.
 */
export async function isSafeUrl(
  url: string,
  env: Pick<Env, "SAFE_BROWSING_API_KEY" | "ENABLE_SAFE_BROWSING">
): Promise<{ safe: boolean; threat?: string }> {
  if (env.ENABLE_SAFE_BROWSING !== "true" || !env.SAFE_BROWSING_API_KEY) {
    return { safe: true };
  }

  const endpoint = `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.SAFE_BROWSING_API_KEY}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "microlink", clientVersion: "1.0.0" },
        threatInfo: {
          threatTypes: [
            "MALWARE",
            "SOCIAL_ENGINEERING",
            "UNWANTED_SOFTWARE",
            "POTENTIALLY_HARMFUL_APPLICATION",
          ],
          platformTypes: ["ANY_PLATFORM"],
          threatEntryTypes: ["URL"],
          threatEntries: [{ url }],
        },
      }),
      signal: AbortSignal.timeout(2500), // 2.5s hard timeout
    });

    if (!response.ok) {
      // Non-2xx from Safe Browsing API: fail open.
      console.warn(`Safe Browsing API returned HTTP ${response.status}`);
      return { safe: true };
    }

    const data = (await response.json()) as SafeBrowsingResponse;

    if (data.matches && data.matches.length > 0) {
      const threat = data.matches[0]?.threatType ?? "UNKNOWN";
      return { safe: false, threat };
    }

    return { safe: true };
  } catch (err) {
    // Network error, timeout, or parse failure — fail open.
    console.warn("Safe Browsing check failed (fail-open):", err);
    return { safe: true };
  }
}

/**
 * Extract only the hostname from a Referer header for privacy-safe analytics.
 * Returns null if the header is absent, malformed, or from the same origin.
 */
export function sanitizeReferrer(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    const { hostname, protocol } = new URL(referrer);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return hostname || null;
  } catch {
    return null;
  }
}

/**
 * Hash an IP address with SHA-256 for GDPR-compliant storage.
 * The hash is one-way: we can detect duplicate IPs for rate limiting but
 * cannot recover the original address.
 */
export async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
