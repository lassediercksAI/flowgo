import { visit } from "unist-util-visit";
const DEFAULT_CLASS_NAME = "flowgo-embed";
// Base64-encode the raw .flowgo source so it survives being dropped into
// an HTML attribute untouched by whatever hast-to-html serializer runs
// downstream (rehype-stringify or similar) -- no escaping of quotes,
// newlines, or angle brackets to worry about, and no risk of the source
// text being interpreted as markup.
const toBase64 = (source) => {
    // Buffer is available in every environment this plugin is meant to run
    // in: remark/rehype pipelines execute at build time in plain Node
    // (Next.js MDX compilation, Astro's build, Docusaurus, Gatsby, 11ty
    // all process markdown server-side, never in a browser).
    return Buffer.from(source, "utf8").toString("base64");
};
const toEmbedNode = (source, className) => ({
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
const remarkFlowgo = (options = {}) => {
    const className = options?.className ?? DEFAULT_CLASS_NAME;
    return (tree) => {
        visit(tree, "code", (node, index, parent) => {
            if (node.lang !== "flowgo")
                return;
            if (!parent || index == null)
                return;
            const embed = toEmbedNode(node.value ?? "", className);
            parent.children[index] = embed;
        });
    };
};
export default remarkFlowgo;
