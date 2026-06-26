// ─────────────────────────────────────────────────────────────────────────────
// microlink — POST /api/shorten handler
// ─────────────────────────────────────────────────────────────────────────────

import type { Context } from "hono";
import type { Env, ShortenRequest } from "../types";
import { ErrorCode } from "../types";
import { shortenUrl, ShortenError } from "../services/shortener";
import { getSupabaseClient } from "../db/client";
import { DatabaseError } from "../db/queries";

export async function handleShorten(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env;

  // ── Parse and type-check body ─────────────────────────────────────────────
  let body: ShortenRequest;
  try {
    body = await c.req.json<ShortenRequest>();
  } catch {
    return c.json(
      { error: "Request body must be valid JSON", code: ErrorCode.VALIDATION_ERROR },
      400
    );
  }

  if (!body.url || typeof body.url !== "string") {
    return c.json(
      { error: "Field 'url' is required and must be a string", code: ErrorCode.VALIDATION_ERROR },
      400
    );
  }

  // Optional fields validation
  if (
    body.expires_in_days !== undefined &&
    (typeof body.expires_in_days !== "number" ||
      !Number.isInteger(body.expires_in_days) ||
      body.expires_in_days < 1 ||
      body.expires_in_days > 3650)
  ) {
    return c.json(
      {
        error: "Field 'expires_in_days' must be an integer between 1 and 3650",
        code: ErrorCode.VALIDATION_ERROR,
      },
      400
    );
  }

  if (
    body.custom_alias !== undefined &&
    typeof body.custom_alias !== "string"
  ) {
    return c.json(
      { error: "Field 'custom_alias' must be a string", code: ErrorCode.VALIDATION_ERROR },
      400
    );
  }

  // ── Resolve creator IP ────────────────────────────────────────────────────
  const creatorIp =
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim();

  // ── Execute shortening logic ──────────────────────────────────────────────
  const db = getSupabaseClient(env);

  try {
    const result = await shortenUrl(
      {
        url: body.url.trim(),
        customAlias: body.custom_alias?.trim(),
        expiresInDays: body.expires_in_days,
        creatorIp,
      },
      db,
      env.REDIRECT_CACHE,
      env
    );

    return c.json(result, 201);
  } catch (err) {
    if (err instanceof ShortenError) {
      // Map domain error codes to appropriate HTTP status codes.
      const status = getStatusForCode(err.code);
      return c.json({ error: err.message, code: err.code }, status);
    }

    if (err instanceof DatabaseError) {
      console.error("DB error in handleShorten:", err);
      return c.json(
        { error: "A database error occurred. Please try again.", code: ErrorCode.INTERNAL_ERROR },
        503
      );
    }

    console.error("Unexpected error in handleShorten:", err);
    return c.json(
      { error: "An unexpected error occurred", code: ErrorCode.INTERNAL_ERROR },
      500
    );
  }
}

function getStatusForCode(code: string): 400 | 409 | 422 | 500 {
  switch (code) {
    case ErrorCode.ALIAS_TAKEN:
      return 409;
    case ErrorCode.INVALID_URL:
    case ErrorCode.URL_TOO_LONG:
    case ErrorCode.ALIAS_INVALID:
    case ErrorCode.VALIDATION_ERROR:
    case ErrorCode.SSRF_BLOCKED:
    case ErrorCode.SELF_REFERENTIAL:
      return 422;
    case ErrorCode.MALICIOUS_URL:
      return 422;
    default:
      return 500;
  }
}
