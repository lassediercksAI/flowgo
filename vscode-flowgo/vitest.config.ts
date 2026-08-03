import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    // previewHydrate.ts manipulates a DOM (document.querySelectorAll,
    // element replacement, etc.) so tests need a browser-like environment
    // — the real target (a VS Code webview) can't run in CI, jsdom is the
    // closest stand-in.
    environment: "jsdom",
  },
});
