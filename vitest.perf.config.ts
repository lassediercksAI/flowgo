// Config for the perf smoke benchmark (src/editor/perf/*.perf.ts).
// Separate from vitest.config.ts so `pnpm test` stays fast for the
// edit-test loop — the perf suite renders thousand-box maps in jsdom
// and takes tens of seconds. Run via `pnpm perf` / `just perf`; CI
// runs it as its own step in .github/workflows/ci.yml.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.perf.ts"],
    environment: "node",
    // Big-map jsdom renders are slow on cold CI runners; the numbers
    // that matter are op counts, so generous timeouts cost nothing.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
