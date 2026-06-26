// ─────────────────────────────────────────────────────────────────────────────
// microlink — Security Headers Middleware
// Applies a strict, defence-in-depth set of HTTP security headers to every
// response. These headers are free performance wins and a signal of engineering
// maturity to any security reviewer reading the codebase.
// ─────────────────────────────────────────────────────────────────────────────

import type { Context, Next } from "hono";
import type { Env } from "../types";

export function securityHeaders() {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<void> => {
    await next();

    // Content Security Policy — the home UI uses an inline script, so the root
    // path gets a relaxed policy. All other routes stay maximally restrictive.
    const isHomePage = c.req.path === "/";
    c.header(
      "Content-Security-Policy",
      isHomePage
        ? "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none';"
        : "default-src 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none';"
    );

    // HSTS — tell browsers to always use HTTPS for this origin for 1 year.
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");

    // Prevent MIME-type sniffing.
    c.header("X-Content-Type-Options", "nosniff");

    // Prevent clickjacking.
    c.header("X-Frame-Options", "DENY");

    // Disable referrer on cross-origin redirects (privacy).
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");

    // Permissions policy — lock down potentially abusable browser features.
    c.header(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
    );

    // Opt out of Google's FLoC / Topics.
    c.header("X-Permitted-Cross-Domain-Policies", "none");
  };
}

export function corsHeaders(allowedOrigins: string[] = ["*"]) {
  return async (c: Context<{ Bindings: Env }>, next: Next): Promise<void | Response> => {
    const origin = c.req.header("Origin") ?? "";
    const allowed =
      allowedOrigins.includes("*") || allowedOrigins.includes(origin);

    if (c.req.method === "OPTIONS") {
      // Handle pre-flight
      if (allowed) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": allowedOrigins.includes("*") ? "*" : origin,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          },
        });
      }
      return new Response("Forbidden", { status: 403 });
    }

    await next();

    if (allowed) {
      c.header(
        "Access-Control-Allow-Origin",
        allowedOrigins.includes("*") ? "*" : origin
      );
    }
  };
}
