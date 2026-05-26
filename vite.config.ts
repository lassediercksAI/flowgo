import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = fileURLToPath(new URL(".", import.meta.url));

// Vite root is src/editor (the source HTML lives there). The build
// emits a single self-contained index.html into pkg/flowgo/dist/,
// which the Go library embeds via //go:embed dist/index.html in
// pkg/flowgo/state.go. Devs run `pnpm dev` for an HMR server and
// `pnpm build` before `go build ./cmd/flowgo`.
export default defineConfig({
  root: resolve(here, "src/editor"),
  publicDir: false,
  server: { port: 54041, strictPort: true },
  preview: { port: 54041, strictPort: true },
  build: {
    outDir: resolve(here, "pkg/flowgo/dist"),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  plugins: [viteSingleFile()],
});
