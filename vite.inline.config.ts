import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));

// Builds the standalone embeddable renderer (`renderFlowgo`) as one
// dependency-free IIFE script, distinct from the editor's build
// (vite.config.ts, which emits the singlefile app pkg/flowgo embeds).
// Consumers drop the output on a page via <script> and call
// `FlowgoInline.renderFlowgo(container, text)` — no bundler, no
// network requests once the file is loaded.
export default defineConfig({
  build: {
    outDir: resolve(here, "dist-inline"),
    emptyOutDir: true,
    lib: {
      entry: resolve(here, "src/render/inline.ts"),
      name: "FlowgoInline",
      formats: ["iife"],
      fileName: () => "flowgo-inline.js",
    },
  },
});
