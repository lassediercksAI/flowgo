// Finds fenced-code-block elements on an arbitrary page that are (or
// look like) ```flowgo blocks — the DOM equivalent of the ` ``` ```
// info string, since a browser extension has no access to the
// original Markdown source, only whatever HTML the host page's own
// renderer produced.
//
// Primary signal: a standard `language-flowgo` (or `lang-flowgo`)
// class on the <code> element, which is what any GFM-conventional
// Markdown pipeline (remark/rehype, markdown-it, ChatGPT's and
// Claude's own renderers) emits from a ` ```flowgo ` fence, even
// though no syntax highlighter actually knows the "flowgo" language.
//
// Fallback signal: content-sniffing against the real .flowgo
// directive grammar (see pkg/graph/graph.go's Parse — kept in sync
// with DIRECTIVE_RE below) for sites whose renderer drops or
// sanitizes unrecognized language classes. Deliberately strict (every
// non-blank line must look like a directive, and at least one must be
// an actual content directive) so it doesn't false-positive on
// ordinary code that happens to start a line with a common word.

export const PROCESSED_ATTR = "data-flowgo-ext-processed";

const CLASS_RE = /^(language|lang)[-_]flowgo$/i;

const DIRECTIVE_RE =
  /^(version|hexagons|defaultshape|map|node|box|edge|text|line|linestyle|nodesize|boxsize|nodeshape|boxshape|anchor|stroke|image)\b/i;
const CONTENT_DIRECTIVE_RE = /^(node|box|edge|text|line|stroke|image)\b/i;
const ANY_LANGUAGE_CLASS_RE = /^(language|lang)[-_]/i;

export function looksLikeFlowgoSource(source: string): boolean {
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((l) => DIRECTIVE_RE.test(l)) && lines.some((l) => CONTENT_DIRECTIVE_RE.test(l));
}

function hasFlowgoClass(codeEl: Element): boolean {
  return codeEl.className.split(/\s+/).some((c) => CLASS_RE.test(c));
}

function hasAnyLanguageClass(codeEl: Element): boolean {
  return codeEl.className.split(/\s+/).some((c) => ANY_LANGUAGE_CLASS_RE.test(c));
}

// Returns the <pre> (or <code>, if unwrapped) container for every
// not-yet-processed fenced code block on the page that is (or looks
// like) flowgo source. Block-level only — a `code` element must be
// inside a `pre` to count, so inline code spans in prose are never
// matched.
export function detectFlowgoBlocks(root: ParentNode): HTMLElement[] {
  const codeEls: Element[] = [];
  if (root instanceof Element && root.matches("code")) codeEls.push(root);
  codeEls.push(...Array.from(root.querySelectorAll("code")));

  const found: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  for (const codeEl of codeEls) {
    const pre = codeEl.closest("pre");
    if (!pre) continue; // inline code span, not a fenced block
    const container = pre as HTMLElement;
    if (container.hasAttribute(PROCESSED_ATTR) || seen.has(container)) continue;

    const text = codeEl.textContent ?? "";
    const matches = hasFlowgoClass(codeEl) || (!hasAnyLanguageClass(codeEl) && looksLikeFlowgoSource(text));
    if (matches) {
      found.push(container);
      seen.add(container);
    }
  }
  return found;
}
