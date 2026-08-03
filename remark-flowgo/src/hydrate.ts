// Client-side hydration for the `.flowgo-embed` placeholders emitted by
// `remark-flowgo`'s remark plugin (see ../src/index.ts). Pure DOM code,
// no build-time/Node dependencies, so it can run either as part of the
// prebuilt `remark-flowgo/client` bundle (which also vendors
// flowgo-inline.js -- see scripts/build-client.mjs) or standalone via
// `remark-flowgo/hydrate`, if you'd rather load the FlowgoInline global
// yourself (e.g. from a CDN, or your own copy of flowgo-inline.js).

export interface FlowgoInlineGlobal {
  renderFlowgo: (
    container: HTMLElement,
    flowgoText: string,
    opts?: Record<string, unknown>,
  ) => unknown;
}

declare global {
  interface Window {
    FlowgoInline?: FlowgoInlineGlobal;
  }
}

const EMBED_SELECTOR = ".flowgo-embed";
const HYDRATED_ATTR = "data-flowgo-hydrated";
const SOURCE_ATTR = "data-flowgo-source";

// atob() gives back a binary string (one UTF-16 code unit per byte); this
// re-decodes it as UTF-8 so non-ASCII flowgo labels (accents, emoji,
// CJK, ...) survive the base64 round trip.
const decodeBase64Utf8 = (b64: string): string => {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
};

/**
 * Find every not-yet-hydrated `.flowgo-embed` placeholder under `root`
 * (defaults to `document`), decode its `data-flowgo-source`, and render
 * it via the global `FlowgoInline.renderFlowgo` (expected to already be
 * loaded on the page -- see README). Returns the number of elements
 * hydrated.
 *
 * Safe to call more than once: already-hydrated elements are skipped, so
 * this can be re-run after client-side navigation in an SPA (Astro
 * view-transitions, Next.js route changes, etc.) that injects new
 * `.flowgo-embed` divs without a full page load.
 */
export const hydrateFlowgoEmbeds = (root: ParentNode = document): number => {
  const renderer = window.FlowgoInline;
  if (!renderer) {
    console.warn(
      "[remark-flowgo] window.FlowgoInline is not defined -- load flowgo-inline.js " +
        "(or the bundled remark-flowgo/client script, which includes it) before " +
        "calling hydrateFlowgoEmbeds().",
    );
    return 0;
  }

  const nodes = root.querySelectorAll<HTMLElement>(`${EMBED_SELECTOR}:not([${HYDRATED_ATTR}])`);
  let hydrated = 0;

  nodes.forEach((el) => {
    const encoded = el.getAttribute(SOURCE_ATTR);
    if (encoded == null) return;

    let source: string;
    try {
      source = decodeBase64Utf8(encoded);
    } catch (err) {
      console.error("[remark-flowgo] failed to decode data-flowgo-source", err);
      return;
    }

    renderer.renderFlowgo(el, source);
    el.setAttribute(HYDRATED_ATTR, "");
    hydrated++;
  });

  return hydrated;
};
