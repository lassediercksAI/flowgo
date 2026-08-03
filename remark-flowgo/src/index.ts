import type { Code, Root } from "mdast";
import type { Node, Parent } from "unist";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

export interface RemarkFlowgoOptions {
  /**
   * Class name applied to the placeholder `<div>` left in place of each
   * ```flowgo code block. Defaults to "flowgo-embed" -- the selector the
   * bundled hydration script (see `remark-flowgo/hydrate` and
   * `remark-flowgo/client`) looks for.
   */
  className?: string;
}

const DEFAULT_CLASS_NAME = "flowgo-embed";

// Base64-encode the raw .flowgo source so it survives being dropped into
// an HTML attribute untouched by whatever hast-to-html serializer runs
// downstream (rehype-stringify or similar) -- no escaping of quotes,
// newlines, or angle brackets to worry about, and no risk of the source
// text being interpreted as markup.
const toBase64 = (source: string): string => {
  // Buffer is available in every environment this plugin is meant to run
  // in: remark/rehype pipelines execute at build time in plain Node
  // (Next.js MDX compilation, Astro's build, Docusaurus, Gatsby, 11ty
  // all process markdown server-side, never in a browser).
  return Buffer.from(source, "utf8").toString("base64");
};

/**
 * A minimal hast-shaped node: mdast-util-to-hast turns any node carrying
 * `data.hName` (+ optional `hProperties`/`hChildren`) into that hast
 * element directly, regardless of the node's own `type`. That means we
 * don't need `remark-rehype`'s `allowDangerousHtml` or `rehype-raw` at
 * all -- there is no raw HTML string in this pipeline, just a plain
 * element description.
 */
interface FlowgoEmbedNode extends Node {
  type: "flowgoEmbed";
  data: {
    hName: "div";
    hProperties: {
      className: string[];
      "data-flowgo-source": string;
    };
  };
  children: [];
}

const toEmbedNode = (source: string, className: string): FlowgoEmbedNode => ({
  type: "flowgoEmbed",
  data: {
    hName: "div",
    hProperties: {
      className: [className],
      "data-flowgo-source": toBase64(source),
    },
  },
  children: [],
});

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
const remarkFlowgo: Plugin<[RemarkFlowgoOptions?], Root> = (options = {}) => {
  const className = options?.className ?? DEFAULT_CLASS_NAME;

  return (tree: Root): void => {
    visit(tree, "code", (node: Code, index, parent: Parent | undefined) => {
      if (node.lang !== "flowgo") return;
      if (!parent || index == null) return;

      const embed = toEmbedNode(node.value ?? "", className);
      parent.children[index] = embed as unknown as (typeof parent.children)[number];
    });
  };
};

export default remarkFlowgo;
