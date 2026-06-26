// ─────────────────────────────────────────────────────────────────────────────
// microlink — Cloudflare Worker Entry Point
//
// Framework: Hono (ultra-lightweight, built for edge runtimes)
// Bundle target: < 100 KB compressed (Cloudflare Workers 1 MB limit)
//
// Route map:
//   POST  /api/shorten            — create a short URL
//   GET   /api/analytics/:key     — fetch click analytics for a key
//   GET   /health                 — liveness + readiness probe
//   GET   /:key                   — redirect to destination URL   ← hot path
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import type { Env } from "./types";
import { securityHeaders, corsHeaders } from "./middleware/security";
import { rateLimiter } from "./middleware/rateLimit";
import { handleShorten } from "./handlers/shorten";
import { handleRedirect } from "./handlers/redirect";
import { handleAnalytics } from "./handlers/analytics";
import { handleHealth } from "./handlers/health";
import { handleHome } from "./handlers/home";

const app = new Hono<{ Bindings: Env }>();

// ─── Global Middleware ─────────────────────────────────────────────────────────
app.use("*", securityHeaders());
app.use("*", corsHeaders(["*"]));

// ─── API Routes ───────────────────────────────────────────────────────────────
// Rate limit only the write-heavy and analytics endpoints.
app.post("/api/shorten", rateLimiter(), handleShorten);
app.get("/api/analytics/:key", rateLimiter(), handleAnalytics);

// ─── Home UI ─────────────────────────────────────────────────────────────────
app.get("/", handleHome);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", handleHealth);

// ─── Redirect — hot path (no rate limit, KV-first) ───────────────────────────
app.get("/:key", handleRedirect);

// ─── 404 Fallback ─────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json({ error: "Route not found", code: "NOT_FOUND" }, 404)
);

// ─── Unhandled Error Boundary ─────────────────────────────────────────────────
app.onError((err, c) => {
  console.error("Unhandled worker error:", err);
  return c.json(
    { error: "An unexpected error occurred", code: "INTERNAL_ERROR" },
    500
  );
});

export default app;
