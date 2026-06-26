// ─────────────────────────────────────────────────────────────────────────────
// microlink — Supabase Client Factory
//
// Cloudflare Workers do not support persistent TCP connections; every worker
// invocation gets a fresh V8 isolate. Supabase's JS client uses the REST API
// (via fetch) by default — no pg connection pool is needed. We use the
// service-role key server-side; it bypasses RLS and must NEVER be exposed to
// the client.
//
// Connection strategy:
//   • Workers re-use HTTP/2 connections within a single isolate lifetime.
//   • We lazily create one client instance per isolate (module-level singleton)
//     keyed by SUPABASE_URL to handle edge-case multi-tenant scenarios.
//   • All DB calls use supabase-js which wraps PostgREST; no raw SQL except
//     for RPC calls to the stored functions in our migrations.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../types";

// Module-level cache: one client per (url, key) pair within a worker isolate.
const clientCache = new Map<string, SupabaseClient>();

export function getSupabaseClient(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_KEY">): SupabaseClient {
  const cacheKey = env.SUPABASE_URL;

  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: {
      // Disable auth persistence — we're running server-side.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Tag requests for observability in Supabase dashboard.
        "x-application-name": "microlink-worker",
      },
    },
    // Use Supabase's built-in connection pooler (PgBouncer on port 6543).
    // Set via SUPABASE_URL pointing to the pooler endpoint when needed.
    db: {
      schema: "public",
    },
  });

  clientCache.set(cacheKey, client);
  return client;
}
