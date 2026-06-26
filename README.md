# microlink

**Production-grade URL shortener running entirely on free-tier infrastructure.**

Built to be a premier engineering showcase: pristine architecture, rigorous edge-case handling, comprehensive tests, and zero AWS costs.

---

## Live Stack — Zero AWS, Zero Cost

| Layer | Service | Free-Tier Limit |
|---|---|---|
| Compute | Cloudflare Workers | 100k req/day |
| Key-Value Cache | Cloudflare KV | 100k reads/day |
| Rate Limit State | Cloudflare KV | 1k writes/day |
| Database | Supabase (PostgreSQL) | 500 MB, unlimited API calls |
| Analytics Aggregation | Supabase pg_cron | built-in |

---

## Architecture

```
                         ┌───────────────────────────────┐
  Browser / Client  ───► │   Cloudflare Workers (Edge)   │
                         │   Hono.js Router               │
                         └──────────┬────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              │                     │                       │
              ▼                     ▼                       ▼
       POST /api/shorten       GET /:key              GET /api/analytics/:key
              │                     │
              │             ┌───────┴──────────┐
              │             │  Cloudflare KV   │  ◄── Hot path (sub-ms)
              │             │  (REDIRECT_CACHE)│
              │             └───────┬──────────┘
              │                     │ miss
              │                     ▼
              └──────────► Supabase PostgreSQL  ◄── Fallback + writes
                                    │
                                    │ ctx.waitUntil (async)
                                    ▼
                           analytics_events table
                           (never blocks redirect)
```

### Redirect Critical Path

```
Request → KV lookup (< 1ms P99)
        → [on HIT]  expiry check → 302 Location + fire analytics via waitUntil
        → [on MISS] Supabase REST → expiry check → 302 + warm KV + fire analytics
```

Target: **< 50ms** end-to-end redirect latency (typically 2–15ms on Cloudflare edge).

---

## Key Engineering Decisions

### 1. Base62 + Knuth Multiplicative Hash (ID Obfuscation)

Sequential database IDs would allow trivial URL enumeration attacks. We apply **Knuth's multiplicative bijection** over 32-bit integers before encoding to Base62. This:
- Scatters adjacent IDs across the full keyspace
- Is O(1), requires zero dependencies
- Is reversible (no information loss, no state)

```
ID 1   → shuffled: 2654435761 → Base62: "dQL82P"
ID 2   → shuffled: 1013904422 → Base62: "1R6GOu"
ID 3   → shuffled: 3963340183 → Base62: "4Vdh8t"
```

### 2. Collision Resolution Strategy

For hash-derived keys (SHA-256 of URL, truncated to 7 chars):

```
attempt 0:  key = SHA256(url + "")[:7]       → try insert
attempt 1:  key = SHA256(url + "1")[:7]      → retry on collision
attempt 2:  key = SHA256(url + "2")[:7]      → retry on collision
attempt 3:  key = random(8 chars)            → cryptographic random fallback
```

The Supabase `UNIQUE` constraint on `short_key` is the authoritative race-condition guard — the application retry loop is a log-noise optimization only.

### 3. Custom Alias Race Condition Prevention

```sql
CONSTRAINT urls_short_key_unique UNIQUE (short_key)
```

Two concurrent requests for `POST /api/shorten { custom_alias: "launch" }` will both pass the application-level existence check. The database-level unique constraint guarantees exactly one INSERT succeeds; the other receives PostgreSQL error `23505` (unique_violation), which we map to HTTP 409 Conflict.

### 4. SSRF Protection

All incoming URLs are parsed with the WHATWG `URL` API, then screened against:
- RFC-1918 private ranges (10/8, 172.16/12, 192.168/16)
- Loopback (127/8, ::1)
- AWS/GCP metadata endpoint (169.254.169.254)
- APIPA, carrier-grade NAT, reserved ranges
- Bare IPv4 and IPv6 addresses (any)
- Same-origin self-referential URLs (redirect loops)

### 5. Analytics Non-Blocking Architecture

```typescript
// Redirect fires immediately — analytics is a background task
ctx.waitUntil(insertAnalyticsEvent(db, { short_key, country_code, referrer_host }));
return new Response(null, { status: 302, headers: { Location: longUrl } });
```

Cloudflare's `waitUntil` keeps the worker alive to complete the analytics write after the response is sent, adding exactly **0ms** to redirect latency.

### 6. Token Bucket Rate Limiter

Each IP gets a bucket of `MAX_REQUESTS` tokens that refill linearly at `MAX_REQUESTS / WINDOW_MS` tokens per millisecond. Bucket state is persisted in Cloudflare KV with a `2 * WINDOW_MS` TTL for auto-cleanup.

Applied to `/api/shorten` and `/api/analytics/:key`. The redirect hot path is intentionally unthrottled (Cloudflare's own DDoS protection covers it at the network layer).

---

## API Reference

### `POST /api/shorten`

Create a short URL.

**Request**
```json
{
  "url": "https://very-long-url.com/path?query=value",
  "custom_alias": "my-promo",       // optional, 3–32 chars, [a-zA-Z0-9_-]
  "expires_in_days": 30             // optional, 1–3650 (default: 365)
}
```

**Response 201**
```json
{
  "short_url": "https://mlnk.io/my-promo",
  "short_key": "my-promo",
  "long_url": "https://very-long-url.com/path?query=value",
  "expires_at": "2025-07-26T00:00:00.000Z",
  "created_at": "2024-07-26T12:34:56.789Z"
}
```

**Error Codes**

| Code | HTTP | Description |
|---|---|---|
| `INVALID_URL` | 422 | Malformed or disallowed URL |
| `URL_TOO_LONG` | 422 | URL > 2048 characters |
| `SSRF_BLOCKED` | 422 | Private/loopback IP range |
| `SELF_REFERENTIAL` | 422 | URL points to this service |
| `MALICIOUS_URL` | 422 | Flagged by Safe Browsing |
| `ALIAS_INVALID` | 422 | Bad alias format or reserved path |
| `ALIAS_TAKEN` | 409 | Custom alias already claimed |
| `RATE_LIMITED` | 429 | Token bucket exhausted |

### `GET /:key`

Redirect to the destination URL.

- **302** (or 301 if configured) on success
- **404** if the key does not exist
- **410 Gone** if the URL has expired

### `GET /api/analytics/:key`

Fetch click analytics for a short key.

**Response 200**
```json
{
  "short_key": "my-promo",
  "long_url": "https://very-long-url.com/...",
  "total_clicks": 1234,
  "created_at": "2024-07-26T12:34:56Z",
  "expires_at": null,
  "country_breakdown": { "US": 800, "GB": 234, "DE": 200 },
  "top_referrers": ["google.com", "twitter.com"],
  "daily_clicks": [
    { "date": "2024-07-26", "clicks": 42 }
  ]
}
```

### `GET /health`

Liveness + readiness probe. Returns `200 OK` when both DB and KV are healthy.

---

## Deployment Guide

### Prerequisites

1. [Cloudflare account](https://dash.cloudflare.com) (free)
2. [Supabase project](https://supabase.com) (free tier)
3. Node.js 20+
4. Wrangler CLI: `npm install -g wrangler`

### Step 1: Database Setup

In Supabase SQL editor, run:
```sql
-- Paste the full contents of migrations/001_initial_schema.sql
```

### Step 2: Create Cloudflare KV Namespaces

```bash
wrangler kv namespace create REDIRECT_CACHE
wrangler kv namespace create REDIRECT_CACHE --preview
wrangler kv namespace create RATE_LIMIT_KV
wrangler kv namespace create RATE_LIMIT_KV --preview
```

Copy the IDs into `wrangler.toml`.

### Step 3: Set Secrets

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put ID_SHUFFLE_SEED   # Any large odd integer, e.g. 6364136223846793005
# Optional:
wrangler secret put SAFE_BROWSING_API_KEY
```

### Step 4: Deploy

```bash
npm run deploy
```

### Step 5: Configure Custom Domain (Optional)

In Cloudflare dashboard → Workers → your worker → Custom Domains → add `mlnk.io` (or your domain).

---

## Local Development

```bash
# Copy and fill in secrets
cp .dev.vars.example .dev.vars

# Start local worker
npm run dev
```

The worker runs at `http://localhost:8787`.

---

## Testing

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report (target: ≥90%)
npm run test:coverage
```

### Test Coverage Breakdown

| Suite | Focus |
|---|---|
| `encoder.test.ts` | Base62 encode/decode, shuffleId bijection, random key uniqueness |
| `validator.test.ts` | SSRF CIDRs, XSS/path-traversal in aliases, Safe Browsing fail-open |
| `rateLimit.test.ts` | Token bucket drain/refill, per-IP isolation, corrupted state recovery |
| `cache.test.ts` | KV hit/miss/negative, TTL computation, expiry guard |
| `shorten.test.ts` | Full orchestration: collision retry loop, race condition (ConflictError), expiry |
| `redirect.test.ts` | KV-first routing, DB fallback, analytics waitUntil, expired 410 |

---

## Security Checklist

- [x] SSRF: all private, loopback, metadata CIDRs blocked
- [x] XSS: custom aliases restricted to `[a-zA-Z0-9_-]` only
- [x] SQL Injection: all DB access via parameterized Supabase client (no raw SQL)
- [x] Path Traversal: reserved system paths blocked from aliasing
- [x] Redirect Loop: self-referential URLs rejected
- [x] Credential Leakage: `user:password@host` URLs rejected
- [x] GDPR/CCPA: IPs SHA-256 hashed; referrers stripped to hostname only; no PII stored
- [x] Rate Limiting: token bucket on all write endpoints
- [x] Security Headers: CSP, HSTS, X-Frame-Options, Permissions-Policy on every response
- [x] Service Key: Supabase service-role key only accessible in Worker environment secrets

---

## Project Structure

```
microlink/
├── src/
│   ├── index.ts                  # Worker entry point (Hono router)
│   ├── types.ts                  # Shared interfaces, branded types, error taxonomy
│   ├── handlers/
│   │   ├── shorten.ts            # POST /api/shorten
│   │   ├── redirect.ts           # GET /:key  ← hot path
│   │   ├── analytics.ts          # GET /api/analytics/:key
│   │   └── health.ts             # GET /health
│   ├── services/
│   │   ├── encoder.ts            # Base62 + Knuth shuffle + SHA-256 key derivation
│   │   ├── validator.ts          # URL/alias validation, SSRF guards, Safe Browsing
│   │   ├── shortener.ts          # Collision retry orchestration
│   │   └── cache.ts              # KV read/write/invalidate abstraction
│   ├── middleware/
│   │   ├── rateLimit.ts          # Token bucket rate limiter
│   │   └── security.ts           # Security + CORS headers
│   └── db/
│       ├── client.ts             # Supabase client factory (singleton per isolate)
│       └── queries.ts            # Typed query functions + error classes
├── migrations/
│   └── 001_initial_schema.sql    # Tables, indexes, RLS, rollup function
├── tests/
│   ├── unit/                     # Pure function tests (no I/O)
│   └── integration/              # Service orchestration tests (mocked I/O)
├── wrangler.toml
├── vitest.config.ts
└── package.json
```
