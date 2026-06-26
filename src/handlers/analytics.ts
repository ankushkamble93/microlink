// ─────────────────────────────────────────────────────────────────────────────
// microlink — GET /api/analytics/:key handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import type { Env } from "../types";
import { ErrorCode } from "../types";
import { getSupabaseClient } from "../db/client";
import { getAnalyticsSummary } from "../db/queries";
import { DatabaseError } from "../db/queries";

export async function handleAnalytics(c: Context<{ Bindings: Env }>): Promise<Response> {
  const shortKey = c.req.param("key");
  const env = c.env;

  if (!shortKey || shortKey.length === 0 || shortKey.length > 32) {
    return c.json(
      { error: "Invalid short key", code: ErrorCode.VALIDATION_ERROR },
      400
    );
  }

  const db = getSupabaseClient(env);

  try {
    const summary = await getAnalyticsSummary(db, shortKey);

    if (!summary) {
      return c.json(
        { error: "Short URL not found", code: ErrorCode.KEY_NOT_FOUND },
        404
      );
    }

    return c.json(summary, 200);
  } catch (err) {
    if (err instanceof DatabaseError) {
      console.error("DB error in handleAnalytics:", err);
      return c.json(
        { error: "A database error occurred", code: ErrorCode.INTERNAL_ERROR },
        503
      );
    }

    console.error("Unexpected error in handleAnalytics:", err);
    return c.json(
      { error: "An unexpected error occurred", code: ErrorCode.INTERNAL_ERROR },
      500
    );
  }
}
