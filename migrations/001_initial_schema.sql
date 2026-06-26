-- ─────────────────────────────────────────────────────────────────────────────
-- microlink — Initial Schema
-- Run against your Supabase project via the SQL editor or `psql`.
-- ─────────────────────────────────────────────────────────────────────────────

-- Enable pgcrypto for gen_random_uuid() and digest()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── urls ─────────────────────────────────────────────────────────────────────
-- Central store for every shortened URL.
-- short_key has a UNIQUE constraint to enforce atomic alias uniqueness at the
-- DB level — this is the last line of defence against race conditions even if
-- application-level checks race past each other.
CREATE TABLE IF NOT EXISTS urls (
  id            BIGSERIAL       PRIMARY KEY,
  short_key     VARCHAR(16)     NOT NULL,
  long_url      TEXT            NOT NULL            CHECK (length(long_url) <= 2048),
  is_custom     BOOLEAN         NOT NULL DEFAULT FALSE,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  -- Store only a SHA-256 hash of the IP, never the raw IP — GDPR compliant.
  creator_ip_hash CHAR(64),

  CONSTRAINT urls_short_key_unique UNIQUE (short_key)
);

-- Covering index: most reads are key → url lookups.
CREATE INDEX IF NOT EXISTS idx_urls_short_key
  ON urls (short_key)
  INCLUDE (long_url, expires_at);

-- Partial index: fast sweep of expired rows for background cleanup jobs.
CREATE INDEX IF NOT EXISTS idx_urls_expires_at
  ON urls (expires_at)
  WHERE expires_at IS NOT NULL;

-- Partial index: locate custom aliases quickly (useful for admin tooling).
CREATE INDEX IF NOT EXISTS idx_urls_custom
  ON urls (short_key)
  WHERE is_custom = TRUE;

-- ─── analytics_events ────────────────────────────────────────────────────────
-- Append-only click log. No PII: country derived from CF-IPCountry header,
-- referrer stripped to origin only, no IP stored.
CREATE TABLE IF NOT EXISTS analytics_events (
  id            BIGSERIAL       PRIMARY KEY,
  short_key     VARCHAR(16)     NOT NULL,
  clicked_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  -- ISO 3166-1 alpha-2 country code from Cloudflare's cf-ipcountry header.
  country_code  CHAR(2),
  -- Only the origin (scheme + host) of the Referer header, never full path.
  referrer_host TEXT,

  CONSTRAINT fk_analytics_short_key
    FOREIGN KEY (short_key) REFERENCES urls (short_key)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analytics_short_key
  ON analytics_events (short_key);

CREATE INDEX IF NOT EXISTS idx_analytics_clicked_at
  ON analytics_events (clicked_at DESC);

-- Composite index for per-key time-series queries (dashboard charts).
CREATE INDEX IF NOT EXISTS idx_analytics_key_time
  ON analytics_events (short_key, clicked_at DESC);

-- ─── analytics_rollups ───────────────────────────────────────────────────────
-- Pre-aggregated daily stats per key. A cron job (or Supabase pg_cron)
-- populates this table to keep dashboard queries O(1) regardless of event volume.
CREATE TABLE IF NOT EXISTS analytics_rollups (
  short_key     VARCHAR(16)     NOT NULL,
  date          DATE            NOT NULL,
  total_clicks  BIGINT          NOT NULL DEFAULT 0,
  country_breakdown JSONB       NOT NULL DEFAULT '{}',
  top_referrers JSONB           NOT NULL DEFAULT '[]',

  PRIMARY KEY (short_key, date),

  CONSTRAINT fk_rollup_short_key
    FOREIGN KEY (short_key) REFERENCES urls (short_key)
    ON DELETE CASCADE
);

-- ─── Row Level Security ───────────────────────────────────────────────────────
-- The worker uses the service-role key (bypasses RLS) but RLS is enabled as a
-- defence-in-depth measure against leaked anon keys.
ALTER TABLE urls               ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_rollups  ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS; no anon policies needed.
-- If you later add auth, create per-user policies here.

-- ─── Rollup Upsert Function ───────────────────────────────────────────────────
-- Called by a Supabase pg_cron job daily at 01:00 UTC.
CREATE OR REPLACE FUNCTION rollup_analytics_daily()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO analytics_rollups (short_key, date, total_clicks, country_breakdown)
  SELECT
    short_key,
    DATE(clicked_at AT TIME ZONE 'UTC') AS date,
    COUNT(*)                             AS total_clicks,
    JSONB_OBJECT_AGG(
      COALESCE(country_code, 'XX'),
      cnt
    )                                    AS country_breakdown
  FROM (
    SELECT short_key, country_code, clicked_at,
           COUNT(*) OVER (PARTITION BY short_key, country_code,
                          DATE(clicked_at AT TIME ZONE 'UTC')) AS cnt
    FROM analytics_events
    WHERE clicked_at >= NOW() - INTERVAL '2 days'
  ) sub
  GROUP BY short_key, DATE(clicked_at AT TIME ZONE 'UTC')
  ON CONFLICT (short_key, date) DO UPDATE
    SET total_clicks       = EXCLUDED.total_clicks,
        country_breakdown  = EXCLUDED.country_breakdown;
END;
$$;

-- ─── Scheduled Cleanup ────────────────────────────────────────────────────────
-- Optional: set up via Supabase Dashboard → Database → Extensions → pg_cron
-- SELECT cron.schedule('rollup-analytics', '0 1 * * *', 'SELECT rollup_analytics_daily()');
-- SELECT cron.schedule('prune-expired-urls', '0 3 * * *',
--   $$DELETE FROM urls WHERE expires_at < NOW() - INTERVAL '7 days'$$);
