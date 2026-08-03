// Entry point bundled (via esbuild, see scripts/build-client.mjs) into
// dist/_browser-entry.js and then concatenated after the vendored
// flowgo-inline.js to produce dist/flowgo-remark-client.js -- the single
// <script> tag consumers include once per page. Not published as its
// own export; see src/hydrate.ts for the reusable, independently
// testable logic.

import { hydrateFlowgoEmbeds } from "./hydrate.js";

const run = (): void => {
  hydrateFlowgoEmbeds(document);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", run);
} else {
  run();
}

// Exposed so an SPA-style site (client-side route changes that inject
// new markup without a full page load) can re-hydrate on demand:
//   window.flowgoRemark.hydrate();
(window as unknown as { flowgoRemark?: { hydrate: typeof hydrateFlowgoEmbeds } }).flowgoRemark = {
  hydrate: hydrateFlowgoEmbeds,
};
