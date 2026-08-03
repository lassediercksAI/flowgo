import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

// Bundles src/previewEntry.ts (which just calls bootstrap() from
// previewHydrate.ts) into a single dependency-free script, loaded into
// VS Code's Markdown preview webview via the `markdown.previewScripts`
// contribution point in package.json. Mirrors the root repo's
// vite.inline.config.ts (same "one <script> tag, no bundler at the
// consumption site" approach), just for our own hydration logic instead
// of the renderer itself.
export default defineConfig({
  build: {
    outDir: resolve(here, "media"),
    emptyOutDir: false, // media/flowgo-inline.js (vendored separately) lives here too
    lib: {
      entry: resolve(here, "src/previewEntry.ts"),
      name: "FlowgoPreviewHydrate",
      formats: ["iife"],
      fileName: () => "preview.js",
    },
  },
});
