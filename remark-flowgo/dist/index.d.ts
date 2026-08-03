import type { Root } from "mdast";
import type { Plugin } from "unified";
export interface RemarkFlowgoOptions {
    /**
     * Class name applied to the placeholder `<div>` left in place of each
     * ```flowgo code block. Defaults to "flowgo-embed" -- the selector the
     * bundled hydration script (see `remark-flowgo/hydrate` and
     * `remark-flowgo/client`) looks for.
     */
    className?: string;
}
/**
 * remark plugin: finds fenced ```flowgo code blocks and replaces each one
 * with a `<div class="flowgo-embed" data-flowgo-source="...">`
 * placeholder. Read-only, no in-place editing.
 *
 * This plugin does NOT render a flowgo map itself -- remark/rehype
 * pipelines run at build time in plain Node, with no DOM, and the
 * shared flowgo renderer (`src/render/inline.ts` in the main repo) is
 * DOM-based. A small client-side script hydrates the placeholder into a
 * live render on page load; see this package's README for the full
 * build-time/client-time split and its trade-offs, and
 * `remark-flowgo/client` / `remark-flowgo/hydrate` for the two ways to
 * wire that script in.
 *
 * Fenced blocks with any other (or no) language tag are left untouched.
 */
declare const remarkFlowgo: Plugin<[RemarkFlowgoOptions?], Root>;
export default remarkFlowgo;
