#!/usr/bin/env node
// Manual sanity check: process a tiny fixture markdown file through the
// same unified() pipeline the unit tests use, and print the resulting
// HTML so a human can eyeball it. Run with:
//   pnpm run build && node scripts/sanity-check.mjs
// (needs the compiled dist/index.js -- this is a plain Node script, not
// run through vitest/ts-node.)

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkFlowgo from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../fixtures/sample.md");
const markdown = readFileSync(fixturePath, "utf8");

const file = await unified()
  .use(remarkParse)
  .use(remarkFlowgo)
  .use(remarkRehype)
  .use(rehypeStringify)
  .process(markdown);

console.log(String(file));
