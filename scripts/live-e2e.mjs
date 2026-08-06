#!/usr/bin/env node
// End-to-end check for live document events (brain#250).
//
// Unit tests can prove the server broadcasts and that the client's
// apply path makes the right decisions. Only this can prove the thing
// the feature is actually for: with `flowgo <file> --host` running and
// the map open in a browser, an agent's MCP mutation shows up on
// screen, promptly, without a reload.
//
// What it drives, for real:
//   1. a `go run ./cmd/flowgo <tmp>.flowgo --host` process,
//   2. a headless Chromium page on it,
//   3. real JSON-RPC POSTs to /mcp — the same calls an agent makes.
//
// and asserts, in the live DOM:
//   - an agent's add_box / update_box / delete_box appears without a
//     reload (the page's load counter must not move),
//   - the browser's OWN save produces no reload and no rebuild (the
//     self-echo case) — checked by marking a DOM element and proving
//     the same element object survives,
//   - a dirty document is NOT clobbered: a page with unsaved edits
//     keeps them and surfaces the notice instead,
//   - the camera and the current submap survive an apply,
//   - an external edit to the .flowgo (the vim case) also lands,
//   - nothing throws while the map is still loading (brain#24d).
//
// Every page it opens is watched for uncaught errors, WITH STACKS —
// see watchErrors() below for why that matters and how to get frames
// you can actually read.
//
// Requirements: go, a built pkg/flowgo/dist/index.html (`pnpm build`),
// playwright-core resolvable, and a Chromium. Both of the latter are
// looked up leniently — this is a local verification tool, not a CI
// gate, and it skips (exit 0) rather than fails when they're absent.
//
//   node scripts/live-e2e.mjs
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/live-e2e.mjs
//   CHROMIUM=/path/to/chrome node scripts/live-e2e.mjs
//   just live-e2e-debug      # readable stacks (unminified bundle)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

const log = (...a) => console.log(...a);
const skip = (why) => {
  log(`SKIP: ${why}`);
  process.exit(0);
};

// ---------------------------------------------------------------
// Toolchain discovery
// ---------------------------------------------------------------

const loadPlaywright = async () => {
  const candidates = [
    process.env.PLAYWRIGHT_CORE,
    "playwright-core",
    "playwright",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return require(c);
    } catch { /* try the next one */ }
  }
  return null;
};

const findChromium = () => {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const roots = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ];
  const rel = [
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-linux/headless_shell",
    "chrome-linux/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (!/^chromium/.test(dir)) continue;
      for (const r of rel) {
        const p = join(root, dir, r);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------
// Server
// ---------------------------------------------------------------

const SEED = `version dev
node b1 root 0 0
node b2 second 300 0
`;

// Build first, then exec the binary. `go run` builds and then FORKS
// the server as a child, so killing the go-run wrapper orphans a
// process still holding the port — the next run picks the next free
// port and silently talks to the previous, stale binary. (The dev
// loop in the justfile learned this the same way.)
const buildServer = (out) =>
  new Promise((resolve, reject) => {
    const p = spawn("go", ["build", "-o", out, "./cmd/flowgo"], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`go build exited ${c}`))));
  });

const startServer = async (bin, file) => {
  const proc = spawn(bin, [file, "--host"], {
    cwd: repoRoot,
    env: { ...process.env, FLOWGO_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`server did not print a URL in 90s:\n${out}`)),
      90_000,
    );
    const scan = (chunk) => {
      out += chunk;
      const m = out.match(/GUI: (http:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        // --host advertises the LAN IP; drive it over loopback.
        const port = new URL(m[1]).port;
        resolve(`http://127.0.0.1:${port}`);
      }
    };
    proc.stdout.on("data", (d) => scan(String(d)));
    proc.stderr.on("data", (d) => scan(String(d)));
    proc.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`server exited with ${code}:\n${out}`));
    });
  });
  return { proc, url };
};

let rpcId = 0;
const mcp = async (base, name, args) => {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await r.json();
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  if (body.result?.isError) {
    throw new Error(`${name}: ${JSON.stringify(body.result.content)}`);
  }
  // add_box mints and returns the node id — the caller does not choose it.
  return body.result?.content?.[0]?.text ?? "";
};

// ---------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------

let failures = 0;
const check = (ok, what, detail = "") => {
  log(`${ok ? "  ok  " : "  FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// Uncaught-error capture, for EVERY page this script opens.
//
// brain#24d cost thirty hunting runs because this used to be
// `page.on("pageerror", e => errors.push(String(e)))` on the first
// page only: String(err) is "TypeError: <message>" and throws the
// stack away, and the second tab was not watched at all. A bug that
// shows up in 2 runs of 45 has to be diagnosable from the run that
// caught it — there may not be another.
//
// So: the full Error object (`.stack` carries the frames), console
// errors with their source location, and failed page loads. Frames
// point into the single-file bundle, which `pnpm build` minifies —
// `just live-e2e-debug` builds it unminified so they read as
// `updateCulling (…:3659:25)` instead of `yi (…:1123:37645)`.
const watchErrors = (page, label) => {
  const errors = [];
  const at = (l) =>
    l && l.url ? ` (${l.url}:${l.lineNumber}:${l.columnNumber})` : "";
  page.on("pageerror", (e) => {
    errors.push(
      `[${label}] uncaught ${e && e.stack ? e.stack : String(e)}`,
    );
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    errors.push(`[${label}] console.error: ${m.text()}${at(m.location())}`);
  });
  page.on("crash", () => errors.push(`[${label}] page crashed`));
  return errors;
};

const waitFor = async (fn, what, timeout = 6_000) => {
  const started = Date.now();
  for (;;) {
    if (await fn()) return Date.now() - started;
    if (Date.now() - started > timeout) return -1;
    await new Promise((r) => setTimeout(r, 50));
  }
};

// ---------------------------------------------------------------

const main = async () => {
  const dist = join(repoRoot, "pkg/flowgo/dist/index.html");
  if (!existsSync(dist)) skip("pkg/flowgo/dist/index.html missing — run `pnpm build`");
  if (!readFileSync(dist, "utf8").includes("live-notice")) {
    skip("dist/index.html predates the live-notice banner — run `pnpm build`");
  }
  const pw = await loadPlaywright();
  if (!pw) skip("playwright-core not resolvable (npm i -g playwright-core, or set PLAYWRIGHT_CORE)");
  const exe = findChromium();
  if (!exe) skip("no chromium found (set CHROMIUM=/path/to/chrome)");

  const dir = mkdtempSync(join(tmpdir(), "flowgo-live-e2e-"));
  const file = join(dir, "map.flowgo");
  writeFileSync(file, SEED);

  const bin = join(dir, "flowgo");
  log("building ./cmd/flowgo …");
  await buildServer(bin);
  log(`server: ${bin} ${file} --host`);
  const { proc, url } = await startServer(bin, file);
  log(`server: ${url}`);

  // Sanity: prove we're talking to the server we just started.
  // --host binds 0.0.0.0, and macOS/BSD with SO_REUSEADDR happily lets
  // that coexist with an earlier 127.0.0.1 bind on the same port — the
  // more specific bind wins the connection. A stale flowgo left over
  // from a previous run therefore answers on the port this one
  // reported, serving a different file AND an older editor bundle.
  // Every assertion below would then be measuring the wrong process.
  const probe = await (await fetch(url + "/state")).json();
  const ids = (probe.maps?.[0]?.boxes ?? []).map((b) => b.id).join(",");
  if (ids !== "b1,b2") {
    proc.kill("SIGKILL");
    throw new Error(
      `${url} is not the server we started (found nodes ${ids || "<none>"}, ` +
        `expected b1,b2). Kill leftover flowgo processes and retry.`,
    );
  }

  const browser = await pw.chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox"],
  });
  let errors = [];
  try {
    // -----------------------------------------------------------
    log("0. nothing throws while the map is still loading");
    // -----------------------------------------------------------
    // Until /state answers, the renderer is drawing main.ts's
    // placeholder map — the one map that never went through
    // ensureMap. Any pan, zoom or window resize in that window
    // schedules a cull pass against it (brain#23a's rAF hook), so the
    // placeholder has to carry every container the renderer reads
    // without a nil check. It did not carry `texts`, and a wheel tick
    // during a slow load threw an uncaught TypeError (brain#24d).
    //
    // In the wild the window is one /state round trip wide, which is
    // why it showed up in 2 of ~45 smoke runs and never twice in a
    // row. Holding /state open makes it deterministic.
    const slow = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const slowErrors = watchErrors(slow, "loading");
    await slow.route("**/state", async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
    await slow.goto(url, { waitUntil: "commit" });
    await new Promise((r) => setTimeout(r, 250));
    await slow.mouse.move(640, 450);
    await slow.mouse.wheel(0, 120);   // wheel is pan, not zoom
    await slow.evaluate(() => window.dispatchEvent(new Event("resize")));
    await new Promise((r) => setTimeout(r, 2_500));
    await slow.waitForSelector('.box[data-id="b1"]');
    check(
      slowErrors.length === 0,
      "viewport moved mid-load, nothing thrown",
      slowErrors.join("\n"),
    );
    check(
      (await slow.$('.box[data-id="b2"]')) !== null,
      "…and the map still rendered once /state answered",
    );
    await slow.close();

    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    errors = watchErrors(page, "tab1");

    // A counter that only survives while the document does. Any full
    // page load resets it to 1 — that is how every "without a reload"
    // assertion below is actually enforced.
    await page.addInitScript(() => {
      window.__loads = (window.__loads || 0) + 1;
    });
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('.box[data-id="b1"]');
    const loadsAtStart = await page.evaluate(() => window.__loads);
    check(loadsAtStart === 1, "page loaded once", `__loads=${loadsAtStart}`);

    // Deterministic camera. The editor culls anything outside the
    // viewport + a 256px apron (#23a), so "did that node appear?" is
    // only a meaningful question once we know where the camera is.
    // Driving it through the URL hash exercises the real navigation
    // path (hashchange → applyURLView → applyViewport) and matches
    // buildViewQuery's own format exactly, so the debounced URL sync
    // writes back an identical hash and nothing oscillates.
    const setView = async (p, x, y) => {
      await p.evaluate(([x, y]) => { location.hash = `#/?x=${x}&y=${y}`; }, [x, y]);
      await new Promise((r) => setTimeout(r, 400));
    };
    // With the camera at (200,200) the visible data rect is roughly
    // x ∈ [-200, 1080], y ∈ [-200, 700]; every node placed below sits
    // well inside it.
    const HOME = [200, 200];
    await setView(page, ...HOME);

    const seen = (p, id) => p.$(`.box[data-id="${id}"]`);
    const notice = (p) =>
      p.evaluate(() => {
        const el = document.getElementById("live-notice");
        return el && !el.classList.contains("hidden")
          ? document.getElementById("live-notice-text").textContent
          : null;
      });

    // -----------------------------------------------------------
    log("\n1. agent adds a node over MCP");
    // -----------------------------------------------------------
    const agent1 = await mcp(url, "add_box", { label: "drawn by the agent", x: 400, y: 400 });
    const t1 = await waitFor(() => seen(page, agent1), "agent1");
    check(t1 >= 0, "agent's node appears with no refresh", t1 >= 0 ? `${t1}ms` : "timed out");
    check((await page.evaluate(() => window.__loads)) === 1, "…and the page did not reload");
    check(
      (await page.textContent(`.box[data-id="${agent1}"]`))?.includes("drawn by the agent"),
      "…with the right label",
    );

    // -----------------------------------------------------------
    log("\n2. agent updates and deletes");
    // -----------------------------------------------------------
    await mcp(url, "update_box", { id: agent1, label: "relabelled" });
    const t2 = await waitFor(
      async () => (await page.textContent(`.box[data-id="${agent1}"]`))?.includes("relabelled"),
      "relabel",
    );
    check(t2 >= 0, "update_box lands", t2 >= 0 ? `${t2}ms` : "timed out");

    await mcp(url, "delete_box", { id: agent1 });
    const t3 = await waitFor(async () => (await seen(page, agent1)) === null, "delete");
    check(t3 >= 0, "delete_box lands", t3 >= 0 ? `${t3}ms` : "timed out");

    // -----------------------------------------------------------
    log("\n3. camera and submap survive an apply");
    // -----------------------------------------------------------
    await setView(page, 320, 260);
    const viewBefore = await page.evaluate(
      () => document.getElementById("canvas").style.transform,
    );
    const hashBefore = await page.evaluate(() => location.hash);
    const agent2 = await mcp(url, "add_box", { label: "second wave", x: 500, y: 300 });
    const t4 = await waitFor(() => seen(page, agent2), "agent2");
    check(t4 >= 0, "second agent edit lands", t4 >= 0 ? `${t4}ms` : "timed out");
    const viewAfter = await page.evaluate(
      () => document.getElementById("canvas").style.transform,
    );
    check(viewAfter === viewBefore, "camera unchanged across the apply",
      viewAfter === viewBefore ? "" : `${viewBefore} → ${viewAfter}`);
    check(
      (await page.evaluate(() => location.hash)) === hashBefore,
      "current path unchanged across the apply",
      `${hashBefore} → ${await page.evaluate(() => location.hash)}`,
    );
    await setView(page, ...HOME);

    // -----------------------------------------------------------
    log("\n4. self-echo: the browser's own save must not rebuild it");
    // -----------------------------------------------------------
    // Mark a live element; a full rebuild replaces the object and the
    // marker goes with it (the #238 trick).
    await page.evaluate(() => {
      document.querySelector('.box[data-id="b2"]').__e2eMarker = "survivor";
    });
    const b1el = await page.$('.box[data-id="b1"]');
    const bb = await b1el.boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + 90, bb.y + bb.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    // Well past the 200ms save debounce plus a round trip, and past
    // the external-file poller's 1s tick, so a wrongly-attributed
    // event would have had every chance to arrive.
    await new Promise((r) => setTimeout(r, 2_500));
    const survived = await page.evaluate(
      () => document.querySelector('.box[data-id="b2"]').__e2eMarker === "survivor",
    );
    check(survived, "own save caused no rebuild (no self-echo, no flicker)");
    check((await page.evaluate(() => window.__loads)) === 1, "…and no reload");
    check(!/node b1 root 0 0/.test(readFileSync(file, "utf8")), "…and the drag actually persisted");
    check((await notice(page)) === null, "…and no notice was raised");

    // -----------------------------------------------------------
    log("\n5. dirty document: an incoming change must not clobber it");
    // -----------------------------------------------------------
    // An open inline label edit holds text that isn't in the graph at
    // all — the hardest version of "unsaved work".
    await page.dblclick('.box[data-id="b2"]');
    await page.keyboard.type("MID-EDIT");
    const agent3 = await mcp(url, "add_box", { label: "arrived mid-edit", x: 700, y: 500 });
    await new Promise((r) => setTimeout(r, 2_500));
    const stillEditing = await page.textContent('.box[data-id="b2"]');
    check(stillEditing?.includes("MID-EDIT"), "unsaved typing survived the incoming change",
      JSON.stringify(stillEditing));
    check((await seen(page, agent3)) === null,
      "…and the incoming change was held back rather than applied");
    check((await notice(page)) !== null, "…and the user was told, non-modally");

    // -----------------------------------------------------------
    log("\n6. …and it lands as soon as the document is clean again");
    // -----------------------------------------------------------
    await page.keyboard.press("Escape");
    await page.mouse.click(1150, 820);
    const t6 = await waitFor(() => seen(page, agent3), "agent3", 10_000);
    check(t6 >= 0, "held-back change applies once clean", t6 >= 0 ? `${t6}ms` : "timed out");
    check((await notice(page)) === null, "…and the notice cleared itself");
    check((await page.evaluate(() => window.__loads)) === 1, "…still no reload");

    // -----------------------------------------------------------
    log("\n7. external edit (the vim case)");
    // -----------------------------------------------------------
    writeFileSync(file, readFileSync(file, "utf8") + 'node vim1 "edited in vim" 800 300\n');
    const t7 = await waitFor(() => seen(page, "vim1"), "vim1", 10_000);
    check(t7 >= 0, "external file edit appears", t7 >= 0 ? `${t7}ms` : "timed out");

    // -----------------------------------------------------------
    log("\n8. a remote apply re-culls against the live camera");
    // -----------------------------------------------------------
    // The apply is a full rebuild, and the renderer only materialises
    // what's inside the viewport + apron (#23a). A node that lands far
    // off-screen must therefore NOT be in the DOM — and must appear
    // the moment the camera reaches it, which is what proves the apply
    // actually happened and that culling rides applyViewport.
    const far = await mcp(url, "add_box", { label: "way over there", x: 3000, y: 300 });
    await new Promise((r) => setTimeout(r, 1_500));
    check((await seen(page, far)) === null, "far-off node is culled, not materialised");
    await setView(page, -2600, 200);
    const t8 = await waitFor(() => seen(page, far), "far", 6_000);
    check(t8 >= 0, "…and appears once the camera reaches it", t8 >= 0 ? `${t8}ms` : "timed out");
    await setView(page, ...HOME);

    // -----------------------------------------------------------
    log("\n9. two tabs stay in sync");
    // -----------------------------------------------------------
    const page2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors2 = watchErrors(page2, "tab2");
    await page2.goto(url, { waitUntil: "networkidle" });
    await page2.waitForSelector('.box[data-id="b1"]');
    await setView(page2, ...HOME);
    const agent4 = await mcp(url, "add_box", { label: "for both tabs", x: 300, y: 550 });
    const a = await waitFor(() => seen(page, agent4), "tab1", 8_000);
    const b = await waitFor(() => seen(page2, agent4), "tab2", 8_000);
    check(a >= 0 && b >= 0, "both tabs saw the agent's change", `${a}ms / ${b}ms`);

    // And a save in one tab reaches the other without echoing to itself.
    await page2.evaluate(() => {
      document.querySelector('.box[data-id="b2"]').__e2eMarker = "tab2-survivor";
    });
    const t2b = await page.$('.box[data-id="b1"]');
    const bb2 = await t2b.boundingBox();
    await page.mouse.move(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb2.x + bb2.width / 2 - 60, bb2.y + bb2.height / 2 + 70, { steps: 8 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 2_500));
    check(
      (await page2.evaluate(
        () => document.querySelector('.box[data-id="b2"]').__e2eMarker !== "tab2-survivor",
      )),
      "tab2 rebuilt to pick up tab1's edit",
    );
    errors.push(...errors2);
    await page2.close();

    // -----------------------------------------------------------
    log("\n10. the stream is genuinely long-lived");
    // -----------------------------------------------------------
    // The CLI arms a 120s WriteTimeout; sitting through that here
    // would make this script useless, and pkg/flowgo's
    // TestEventsSurvivesServerWriteTimeout pins the real thing against
    // a real server with a short one. What this adds is the milder,
    // still-worth-having version: the stream is still delivering after
    // a substantial idle gap in a real browser.
    await new Promise((r) => setTimeout(r, 12_000));
    const agent5 = await mcp(url, "add_box", { label: "after an idle gap", x: 600, y: 150 });
    const t10 = await waitFor(() => seen(page, agent5), "agent5", 8_000);
    check(t10 >= 0, "stream still live after a 12s idle gap", t10 >= 0 ? `${t10}ms` : "timed out");

    check(errors.length === 0, "no uncaught errors in any tab");
    for (const e of errors) log(`\n${e}`);
    if (errors.length > 0) {
      log(
        "\n(minified frames? rebuild readable ones with `just live-e2e-debug`)",
      );
    }
  } finally {
    await browser.close();
    proc.kill("SIGKILL");
  }

  log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
