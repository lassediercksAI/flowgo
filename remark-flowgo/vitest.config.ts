import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    environmentMatchGlobs: [["test/hydrate.test.ts", "jsdom"]],
  },
});
