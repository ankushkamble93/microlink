// ─────────────────────────────────────────────────────────────────────────────
// microlink — GET /health handler
// Returns a machine-readable health summary for uptime monitors.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import type { Env } from "../types";
import { getSupabaseClient } from "../db/client";

interface HealthCheck {
  status: "ok" | "degraded" | "unhealthy";
  version: string;
  timestamp: string;
  checks: {
    database: "ok" | "error";
    cache: "ok" | "error";
  };
}

export async function handleHealth(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;
  const checks: HealthCheck["checks"] = {
    database: "ok",
    cache: "ok",
  };

  // ── DB liveness probe ─────────────────────────────────────────────────────
  try {
    const db = getSupabaseClient(env);
    // Lightweight count query — hits the DB without scanning the table.
    const { error } = await db.from("urls").select("id", { count: "exact", head: true }).limit(1);
    if (error) throw error;
  } catch {
    checks.database = "error";
  }

  // ── KV liveness probe ─────────────────────────────────────────────────────
  // KV is eventually consistent — we only test that the put call itself
  // succeeds (no network/auth error). A read-after-write miss is expected
  // behaviour at edge and is not a health failure.
  try {
    await env.REDIRECT_CACHE.put(`health:probe`, "1", { expirationTtl: 60 });
  } catch {
    checks.cache = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");
  const anyError = Object.values(checks).some((v) => v === "error");

  const status: HealthCheck["status"] = allOk
    ? "ok"
    : anyError
    ? "degraded"
    : "ok";

  const body: HealthCheck = {
    status,
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    checks,
  };

  const httpStatus = status === "unhealthy" ? 503 : 200;
  return c.json(body, httpStatus);
}
