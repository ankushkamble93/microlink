// ─────────────────────────────────────────────────────────────────────────────
// microlink — Shared TypeScript interfaces and branded types
// ─────────────────────────────────────────────────────────────────────────────

// ─── Cloudflare Worker Bindings ───────────────────────────────────────────────
export interface Env {
  // KV Namespaces
  REDIRECT_CACHE: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;

  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;

  // Config
  BASE_URL: string;
  REDIRECT_MODE: "301" | "302";
  DEFAULT_TTL_DAYS: string;
  MAX_URL_LENGTH: string;
  KEY_MIN_LENGTH: string;
  KEY_MAX_LENGTH: string;
  RATE_LIMIT_WINDOW_MS: string;
  RATE_LIMIT_MAX_REQUESTS: string;
  COLLISION_MAX_RETRIES: string;
  ENABLE_SAFE_BROWSING: string;
  ANALYTICS_ENABLED: string;

  // Optional
  SAFE_BROWSING_API_KEY?: string;
  ID_SHUFFLE_SEED?: string;
}

// ─── Domain Models ────────────────────────────────────────────────────────────
export interface UrlRecord {
  id: number;
  short_key: string;
  long_url: string;
  is_custom: boolean;
  expires_at: string | null;
  created_at: string;
  creator_ip_hash: string | null;
}

export interface AnalyticsEvent {
  short_key: string;
  clicked_at: string;
  country_code: string | null;
  referrer_host: string | null;
}

export interface AnalyticsRollup {
  short_key: string;
  date: string;
  total_clicks: number;
  country_breakdown: Record<string, number>;
  top_referrers: string[];
}

// ─── API Request/Response Shapes ──────────────────────────────────────────────
export interface ShortenRequest {
  url: string;
  custom_alias?: string;
  expires_in_days?: number;
}

export interface ShortenResponse {
  short_url: string;
  short_key: string;
  long_url: string;
  expires_at: string | null;
  created_at: string;
}

export interface AnalyticsSummary {
  short_key: string;
  long_url: string;
  total_clicks: number;
  created_at: string;
  expires_at: string | null;
  country_breakdown: Record<string, number>;
  top_referrers: string[];
  daily_clicks: Array<{ date: string; clicks: number }>;
}

// ─── Error Taxonomy ───────────────────────────────────────────────────────────
export const ErrorCode = {
  INVALID_URL: "INVALID_URL",
  URL_TOO_LONG: "URL_TOO_LONG",
  MALICIOUS_URL: "MALICIOUS_URL",
  SELF_REFERENTIAL: "SELF_REFERENTIAL",
  SSRF_BLOCKED: "SSRF_BLOCKED",
  ALIAS_TAKEN: "ALIAS_TAKEN",
  ALIAS_INVALID: "ALIAS_INVALID",
  KEY_NOT_FOUND: "KEY_NOT_FOUND",
  KEY_EXPIRED: "KEY_EXPIRED",
  COLLISION_EXHAUSTED: "COLLISION_EXHAUSTED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  VALIDATION_ERROR: "VALIDATION_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiError {
  error: string;
  code: ErrorCode;
  status: number;
}

// ─── Cache Entry ──────────────────────────────────────────────────────────────
export interface CacheEntry {
  long_url: string;
  expires_at: string | null;
}

// ─── Rate Limit State ─────────────────────────────────────────────────────────
export interface TokenBucketState {
  tokens: number;
  last_refill: number;
}

// ─── Safe Browsing ────────────────────────────────────────────────────────────
export interface SafeBrowsingMatch {
  threatType: string;
  platformType: string;
  threatEntryType: string;
  threat: { url: string };
}

export interface SafeBrowsingResponse {
  matches?: SafeBrowsingMatch[];
}
