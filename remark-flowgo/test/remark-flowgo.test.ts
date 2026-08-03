import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkFlowgo from "../src/index.js";

const process = async (markdown: string, options?: Parameters<typeof remarkFlowgo>[0]): Promise<string> => {
  const file = await unified()
    .use(remarkParse)
    .use(remarkFlowgo, options)
    .use(remarkRehype)
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
};

const decodeAttr = (html: string, attr: string): string => {
  const match = new RegExp(`${attr}="([^"]*)"`).exec(html);
  if (!match) throw new Error(`attribute ${attr} not found in: ${html}`);
  return Buffer.from(match[1], "base64").toString("utf8");
};

describe("remarkFlowgo", () => {
  it("replaces a ```flowgo block with a flowgo-embed placeholder div", async () => {
    const md = ["```flowgo", "box a 0 0 Hello", "box b 200 0 World", "edge a b", "```"].join("\n");
    const html = await process(md);

    expect(html).toContain('class="flowgo-embed"');
    expect(html).toMatch(/<div class="flowgo-embed" data-flowgo-source="[^"]+"><\/div>/);
    expect(decodeAttr(html, "data-flowgo-source")).toBe("box a 0 0 Hello\nbox b 200 0 World\nedge a b");
  });

  it("handles an empty ```flowgo block without throwing", async () => {
    const md = ["```flowgo", "```"].join("\n");
    const html = await process(md);

    expect(html).toContain('class="flowgo-embed"');
    expect(decodeAttr(html, "data-flowgo-source")).toBe("");
  });

  it("leaves other fenced code blocks (e.g. ```js) completely untouched", async () => {
    const md = ["```js", "console.log('hi');", "```"].join("\n");
    const html = await process(md);

    expect(html).not.toContain("flowgo-embed");
    expect(html).toContain('<code class="language-js">');
    expect(html).toContain("console.log('hi');");
  });

  it("leaves fenced blocks with no language tag untouched", async () => {
    const md = ["```", "plain text", "```"].join("\n");
    const html = await process(md);

    expect(html).not.toContain("flowgo-embed");
    expect(html).toContain("<pre><code>plain text");
  });

  it("only replaces flowgo blocks, leaving surrounding content and other blocks intact", async () => {
    const md = [
      "# Title",
      "",
      "Some intro text.",
      "",
      "```flowgo",
      "box a 0 0 A",
      "```",
      "",
      "```js",
      "1 + 1;",
      "```",
      "",
      "More text after.",
    ].join("\n");
    const html = await process(md);

    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some intro text.</p>");
    expect(html).toContain('class="flowgo-embed"');
    expect(decodeAttr(html, "data-flowgo-source")).toBe("box a 0 0 A");
    expect(html).toContain('<code class="language-js">1 + 1;');
    expect(html).toContain("<p>More text after.</p>");
  });

  it("supports a custom className option", async () => {
    const md = ["```flowgo", "box a 0 0 A", "```"].join("\n");
    const html = await process(md, { className: "my-flowgo" });

    expect(html).toContain('class="my-flowgo"');
    expect(html).not.toContain("flowgo-embed");
  });

  it("supports multiple flowgo blocks in one document", async () => {
    const md = ["```flowgo", "box a 0 0 First", "```", "", "```flowgo", "box b 0 0 Second", "```"].join("\n");
    const html = await process(md);

    const matches = [...html.matchAll(/data-flowgo-source="([^"]+)"/g)];
    expect(matches).toHaveLength(2);
    expect(Buffer.from(matches[0]![1], "base64").toString("utf8")).toBe("box a 0 0 First");
    expect(Buffer.from(matches[1]![1], "base64").toString("utf8")).toBe("box b 0 0 Second");
  });

  it("round-trips non-ASCII flowgo source (accents, emoji, CJK) through base64", async () => {
    const md = ["```flowgo", "box a 0 0 Café 🎉 日本語", "```"].join("\n");
    const html = await process(md);

    expect(decodeAttr(html, "data-flowgo-source")).toBe("box a 0 0 Café 🎉 日本語");
  });
});
