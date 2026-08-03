// Actual entry point bundled to media/preview.js (see
// vite.preview.config.ts) and loaded into the Markdown preview webview via
// the `markdown.previewScripts` contribution in package.json. Kept as a
// one-line side-effecting wrapper around previewHydrate.ts so that module
// stays free of top-level side effects and importable from tests.
import { bootstrap } from "./previewHydrate";

bootstrap();
