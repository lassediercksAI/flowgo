#!/usr/bin/env node
// Regenerates:
//   1. vendor/flowgo-inline.js       -- a copy of the root repo's
//      dist-inline/flowgo-inline.js (built by `pnpm build:inline` at the
//      repo root from src/render/inline.ts).
//   2. dist/flowgo-remark-client.js  -- (1) concatenated with this
//      package's compiled hydration bootstrap (src/browser-entry.ts,
//      bundled standalone via esbuild). Script order matters: the
//      vendored IIFE runs first and defines `window.FlowgoInline`, then
//      the bootstrap runs and hydrates every `.flowgo-embed` div.
//
// Run via `pnpm run build:vendor` (or as part of `pnpm run build`)
// whenever src/render/inline.ts changes upstream, to keep the vendored
// copy in remark-flowgo in sync. Both generated files are committed to
// git (this package isn't published anywhere that could run this build
// step for you, so a consumer installing from git needs working
// artifacts already in place).
//
// Set SKIP_VENDOR_BUILD=1 to skip re-running the root `build:inline`
// step and just re-copy+re-bundle from whatever's already in
// ../dist-inline/flowgo-inline.js (useful if you already ran it, or
// don't have the root devDependencies installed).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..");

const vendorDir = resolve(pkgRoot, "vendor");
const distDir = resolve(pkgRoot, "dist");
mkdirSync(vendorDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

const runRootBuildInline = () => {
  const attempts = [
    ["pnpm", ["run", "build:inline"]],
    ["corepack", ["pnpm", "run", "build:inline"]],
  ];
  let lastErr;
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { cwd: repoRoot, stdio: "inherit" });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Could not run "pnpm run build:inline" at the repo root (${repoRoot}) via pnpm or corepack pnpm. ` +
      `Install pnpm (or enable corepack: "corepack enable"), or set SKIP_VENDOR_BUILD=1 if ` +
      `dist-inline/flowgo-inline.js is already built. Last error: ${lastErr?.message ?? lastErr}`,
  );
};

if (process.env.SKIP_VENDOR_BUILD !== "1") {
  console.log("[remark-flowgo] building dist-inline/flowgo-inline.js from the repo root...");
  runRootBuildInline();
} else {
  console.log("[remark-flowgo] SKIP_VENDOR_BUILD=1 set, skipping root build:inline");
}

const vendorSrc = resolve(repoRoot, "dist-inline/flowgo-inline.js");
if (!existsSync(vendorSrc)) {
  throw new Error(
    `Expected ${vendorSrc} to exist. Run "pnpm run build:inline" from the repo root first, ` +
      `or unset SKIP_VENDOR_BUILD.`,
  );
}
copyFileSync(vendorSrc, resolve(vendorDir, "flowgo-inline.js"));
console.log(`[remark-flowgo] vendored ${vendorSrc} -> vendor/flowgo-inline.js`);

const bundleEntryOut = resolve(distDir, "_browser-entry.js");
await esbuild.build({
  entryPoints: [resolve(pkgRoot, "src/browser-entry.ts")],
  bundle: true,
  format: "iife",
  target: "es2019",
  outfile: bundleEntryOut,
});

const vendorJs = readFileSync(resolve(vendorDir, "flowgo-inline.js"), "utf8");
const entryJs = readFileSync(bundleEntryOut, "utf8");
rmSync(bundleEntryOut);

const banner = `/*!
 * remark-flowgo client bundle -- GENERATED, do not edit by hand.
 * Regenerate with: pnpm run build:vendor (from remark-flowgo/), or
 * pnpm run build (which also does this as part of a full build).
 *
 * Two parts concatenated in order:
 *   1. the vendored flowgo-inline.js IIFE (defines window.FlowgoInline;
 *      built from ../src/render/inline.ts at the repo root)
 *   2. this package's hydration bootstrap (src/browser-entry.ts)
 */
`;

const outPath = resolve(distDir, "flowgo-remark-client.js");
writeFileSync(outPath, banner + vendorJs + "\n" + entryJs + "\n");
console.log(`[remark-flowgo] wrote ${outPath}`);
