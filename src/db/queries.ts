// ─────────────────────────────────────────────────────────────────────────────
// microlink — Typed Database Query Layer
//
// All DB access is funnelled through this module. Using explicit, narrow
// functions (instead of sprinkling supabase client calls throughout) enables:
//   • Full TypeScript coverage over query results
//   • Centralised error handling and logging
//   • Easy substitution of the DB layer in tests (mock this module)
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  UrlRecord,
  AnalyticsEvent,
  AnalyticsSummary,
} from "../types";

// ─── URL Queries ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL record by its short key.
 * Returns null if the key does not exist.
 */
export async function getUrlByKey(
  db: SupabaseClient,
  shortKey: string
): Promise<UrlRecord | null> {
  const { data, error } = await db
    .from("urls")
    .select("id, short_key, long_url, is_custom, expires_at, created_at, creator_ip_hash")
    .eq("short_key", shortKey)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null; // PostgREST "no rows" code
    throw new DatabaseError(`getUrlByKey failed: ${error.message}`, error.code);
  }

  return data as UrlRecord;
}

/**
 * Check if a short key already exists (lightweight, no full row fetch).
 */
export async function keyExists(
  db: SupabaseClient,
  shortKey: string
): Promise<boolean> {
  const { count, error } = await db
    .from("urls")
    .select("id", { count: "exact", head: true })
    .eq("short_key", shortKey);

  if (error) {
    throw new DatabaseError(`keyExists failed: ${error.message}`, error.code);
  }

  return (count ?? 0) > 0;
}

export interface InsertUrlParams {
  short_key: string;
  long_url: string;
  is_custom: boolean;
  expires_at: string | null;
  creator_ip_hash: string | null;
}

/**
 * Insert a new URL record.
 *
 * The `UNIQUE` constraint on `short_key` guarantees that two concurrent
 * requests racing to claim the same alias will result in exactly one
 * PostgreSQL error (code 23505 = unique_violation). We surface that as a
 * `ConflictError` so callers can react appropriately.
 */
export async function insertUrl(
  db: SupabaseClient,
  params: InsertUrlParams
): Promise<UrlRecord> {
  const { data, error } = await db
    .from("urls")
    .insert(params)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      throw new ConflictError(`Short key '${params.short_key}' is already taken`);
    }
    throw new DatabaseError(`insertUrl failed: ${error.message}`, error.code);
  }

  return data as UrlRecord;
}

/**
 * Hard-delete an expired URL (used by background cleanup jobs).
 */
export async function deleteUrl(
  db: SupabaseClient,
  shortKey: string
): Promise<void> {
  const { error } = await db.from("urls").delete().eq("short_key", shortKey);

  if (error) {
    throw new DatabaseError(`deleteUrl failed: ${error.message}`, error.code);
  }
}

// ─── Analytics Queries ────────────────────────────────────────────────────────

/**
 * Insert a single analytics event.
 * Called inside `ctx.waitUntil` so it never blocks the redirect critical path.
 */
export async function insertAnalyticsEvent(
  db: SupabaseClient,
  event: Omit<AnalyticsEvent, "id">
): Promise<void> {
  const { error } = await db.from("analytics_events").insert(event);

  if (error) {
    // Analytics failures are non-fatal; log and continue.
    console.warn("Failed to insert analytics event:", error.message);
  }
}

/**
 * Fetch a full analytics summary for a given short key.
 * Combines the urls table with rollup aggregates and raw event data.
 */
export async function getAnalyticsSummary(
  db: SupabaseClient,
  shortKey: string
): Promise<AnalyticsSummary | null> {
  // 1. Base URL record
  const urlRecord = await getUrlByKey(db, shortKey);
  if (!urlRecord) return null;

  // 2. Rollup totals (fast path from pre-aggregated table)
  const { data: rollups } = await db
    .from("analytics_rollups")
    .select("date, total_clicks, country_breakdown, top_referrers")
    .eq("short_key", shortKey)
    .order("date", { ascending: false })
    .limit(30);

  const dailyClicks =
    (rollups ?? []).map((r: { date: string; total_clicks: number }) => ({
      date: r.date as string,
      clicks: r.total_clicks as number,
    }));

  const totalClicks = dailyClicks.reduce((sum, d) => sum + d.clicks, 0);

  // Merge country breakdown across all rollup rows
  const countryBreakdown: Record<string, number> = {};
  for (const rollup of rollups ?? []) {
    const breakdown = (rollup.country_breakdown ?? {}) as Record<string, number>;
    for (const [country, count] of Object.entries(breakdown)) {
      countryBreakdown[country] = (countryBreakdown[country] ?? 0) + count;
    }
  }

  // Top referrers from most recent rollup
  const topReferrers: string[] =
    (rollups?.[0]?.top_referrers as string[] | undefined) ?? [];

  return {
    short_key: shortKey,
    long_url: urlRecord.long_url,
    total_clicks: totalClicks,
    created_at: urlRecord.created_at,
    expires_at: urlRecord.expires_at,
    country_breakdown: countryBreakdown,
    top_referrers: topReferrers,
    daily_clicks: dailyClicks,
  };
}

// ─── Error Classes ────────────────────────────────────────────────────────────

export class DatabaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
