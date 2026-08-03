export interface FlowgoInlineGlobal {
    renderFlowgo: (container: HTMLElement, flowgoText: string, opts?: Record<string, unknown>) => unknown;
}
declare global {
    interface Window {
        FlowgoInline?: FlowgoInlineGlobal;
    }
}
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
export declare const hydrateFlowgoEmbeds: (root?: ParentNode) => number;
