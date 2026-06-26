import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        // Overall thresholds account for the Supabase DB layer which requires
        // integration tests against a real DB for 100% coverage.
        // Service-layer coverage (encoder, validator, cache, shortener) is ≥93%.
        lines: 85,
        functions: 85,
        branches: 82,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
