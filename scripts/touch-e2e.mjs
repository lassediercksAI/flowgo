#!/usr/bin/env node
// End-to-end check for the TOUCH LINK-DRAG: pull a connection from a
// box's handle dot to another box with one finger.
//
// The jsdom suite (src/editor/touch-link.test.ts) proves the gesture
// LOGIC — which branch claims the touch, what lands in map.edges. It
// cannot prove the parts jsdom has to stub: real hit testing under a
// CSS transform, `touch-action`, the coarse-pointer media query that
// makes the handles visible and finger-sized, and whether the browser
// hands us the touch sequence at all. That is what this drives, for
// real:
//
//   1. a `flowgo <tmp>.flowgo` server process,
//   2. a headless Chromium page at a phone viewport with hasTouch +
//      isMobile, so `(pointer: coarse)` matches and body.touch-input is
//      live,
//   3. genuine touchstart / touchmove / touchend sequences via CDP
//      Input.dispatchTouchEvent — including two-finger pinches.
//
// and asserts, against the .flowgo the server WROTE BACK (graph state,
// not pixels):
//
//   - a tap selects a box and materializes its handles (brain#239's
//     lazy chrome has no hover to lean on here — selection is the
//     entitlement),
//   - dragging a handle onto another box creates the edge,
//   - the near-target glow and the receiving handle light up en route,
//   - a drop on empty canvas spawns a box and connects it,
//   - the same for hexagon / circle / triangle sources and targets,
//     whose handle anchors differ,
//   - it still works after a pinch and a pan, at scale != 1,
//   - the drag survives a path that wanders over the chrome,
//   - re-routing an existing edge works,
//   - brush / line mode hide the handles instead of half-claiming them,
//   - a dot the user can SEE is a dot that works: a chrome tap still
//     entitles a nearby unselected box's chrome, but the proximity
//     reveal is fine-pointer-only, so nothing visible is inert
//     (brain#278 — needs a real engine for both the synthesized
//     mousemove and the media query).
//
// SCOPE, honestly: Chromium reproduces the touch SEQUENCE, so the drag
// is meaningfully tested. It does NOT reproduce iOS Safari's click
// synthesis (the brain#256 failure mode) or its gesture* events. Those
// still need a real iPhone.
//
// Requirements: go, a built pkg/flowgo/dist/index.html (`pnpm build`),
// playwright-core resolvable, and a Chromium. The latter two are looked
// up leniently — this is a local verification tool, not a CI gate, and
// it skips (exit 0) rather than fails when they're absent.
//
//   node scripts/touch-e2e.mjs
//   PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/touch-e2e.mjs
//   CHROMIUM=/path/to/chrome node scripts/touch-e2e.mjs

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

let failures = 0;
const ok = (m) => log(`  ok   ${m}`);
const fail = (m, d) => {
  log(`  FAIL ${m}${d ? ` — ${d}` : ""}`);
  failures++;
};
const check = (c, m, d) => (c ? ok(m) : fail(m, d));
const section = (s) => log(`\n── ${s} ${"─".repeat(Math.max(0, 58 - s.length))}`);

// ---------------------------------------------------------------
// Toolchain discovery (same leniency as live-e2e.mjs)
// ---------------------------------------------------------------

const loadPlaywright = async () => {
  for (const c of [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean)) {
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

// Build first, then exec the binary: `go run` forks the server as a
// child, so killing the wrapper orphans a process still holding the
// port (see live-e2e.mjs for the full story).
const buildServer = (out) =>
  new Promise((resolve, reject) => {
    const p = spawn("go", ["build", "-o", out, "./cmd/flowgo"], {
      cwd: repoRoot,
      stdio: ["ignore", "inherit", "inherit"],
    });
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`go build exited ${c}`))));
  });

const startServer = async (bin, file) => {
  const proc = spawn(bin, [file], {
    cwd: repoRoot,
    env: { ...process.env, FLOWGO_NO_OPEN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const url = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not print a URL in 90s:\n${out}`)), 90_000);
    const scan = (chunk) => {
      out += chunk;
      const m = out.match(/GUI: (http:\/\/\S+)/);
      if (m) {
        clearTimeout(t);
        resolve(`http://127.0.0.1:${new URL(m[1]).port}`);
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

// Every scenario gets a VIRGIN fixture and its own server. These checks
// mutate the map (that's the point), and re-running a destructive smoke
// against a file a previous run already moved boxes around in is a
// documented source of flake (brain#24c).
const seedFixture = (seed) => {
  const dir = mkdtempSync(join(tmpdir(), "flowgo-touch-e2e-"));
  const file = join(dir, "map.flowgo");
  writeFileSync(file, seed);
  return file;
};

// Ground truth. The editor debounces saves 200ms; callers wait longer.
const edgesOf = (file) =>
  readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("edge ")).map((l) => l.trim());
const nodesOf = (file) =>
  readFileSync(file, "utf8").split("\n").filter((l) => /^(box|node) /.test(l)).map((l) => l.trim());

// ---------------------------------------------------------------
// Page + touch driver
// ---------------------------------------------------------------

const watchErrors = (page, out) => {
  page.on("pageerror", (e) => out.push(`uncaught ${e && e.stack ? e.stack : String(e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") out.push(`console.error: ${m.text()}`);
  });
  page.on("crash", () => out.push("page crashed"));
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const openPhone = async (browser, url, errors, viewport) => {
  // hasTouch + isMobile is what makes `(pointer: coarse)` match, which
  // is what makes body.touch-input — and therefore the always-visible,
  // 22px handles — live. Without it this would be testing the desktop
  // stylesheet with touch events sprayed at it.
  const context = await browser.newContext({
    viewport: viewport ?? { width: 390, height: 780 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  });
  const page = await context.newPage();
  watchErrors(page, errors);
  await page.goto(url, { waitUntil: "domcontentloaded" }); // NOT networkidle: the SSE stream never closes
  await page.waitForSelector(".box", { timeout: 20_000 });
  await wait(300);
  const cdp = await context.newCDPSession(page);
  const touch = (type, pts) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: i })),
    });

  const rectOf = (sel) =>
    page.evaluate((q) => {
      const el = document.querySelector(q);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    }, sel);

  // A point a finger could actually land on: inside the box AND topmost
  // there. The toolbar and the bottom context bar overlap the canvas, so
  // a box centre is not automatically touchable — and a fixture that
  // parks a box under the chrome must fail loudly as a FIXTURE problem,
  // not silently as a product one.
  const reachable = (id) =>
    page.evaluate((bid) => {
      const el = document.querySelector(`.box[data-id="${bid}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.5, 0.7], [0.35, 0.5], [0.65, 0.5]]) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (document.elementFromPoint(x, y)?.closest(`.box[data-id="${bid}"]`)) return { x, y };
      }
      return null;
    }, id);

  const mustReach = async (id) => {
    const p = await reachable(id);
    if (!p) throw new Error(`fixture: box ${id} has no chrome-free, on-screen point`);
    return p;
  };

  const tap = async (x, y) => {
    await touch("touchStart", [[x, y]]);
    await wait(40);
    await touch("touchEnd", []);
    await wait(200);
  };

  const lerp = (a, b, n) =>
    Array.from({ length: n }, (_, i) => ({
      x: a.x + ((b.x - a.x) * (i + 1)) / n,
      y: a.y + ((b.y - a.y) * (i + 1)) / n,
    }));

  // The gesture under test. `onMove` samples mid-drag state so the
  // visual cues can be asserted without a screenshot.
  const linkDrag = async (fromId, code, to, onMove) => {
    const h = await rectOf(`.box[data-id="${fromId}"] .handle[data-handle="${code}"]`);
    if (!h) throw new Error(`no ${code} handle on ${fromId} — chrome missing at touchstart`);
    await touch("touchStart", [[h.x, h.y]]);
    await wait(30);
    for (const p of lerp(h, to, 10)) {
      await touch("touchMove", [[p.x, p.y]]);
      await wait(16);
      if (onMove) await onMove();
    }
    await touch("touchEnd", []);
    await wait(500); // > the 200ms save debounce + the server write
  };

  const pinch = async (cx, cy, from, to) => {
    await touch("touchStart", [[cx - from, cy], [cx + from, cy]]);
    for (let i = 1; i <= 8; i++) {
      const d = from + ((to - from) * i) / 8;
      await touch("touchMove", [[cx - d, cy], [cx + d, cy]]);
      await wait(16);
    }
    await touch("touchEnd", [[cx + to, cy]]);
    await touch("touchEnd", []);
    await wait(250);
  };

  const scale = () =>
    page.evaluate(() => {
      const m = /scale\(([-0-9.]+)\)/.exec(document.getElementById("canvas").style.transform || "");
      return m ? parseFloat(m[1]) : null;
    });

  const chromeOf = (id) =>
    page.evaluate((bid) => {
      const el = document.querySelector(`.box[data-id="${bid}"]`);
      if (!el) return null;
      return {
        cls: [...el.classList],
        handles: el.querySelectorAll(".handle").length,
        grips: el.querySelectorAll(".resize-grip").length,
      };
    }, id);

  return { context, page, touch, rectOf, mustReach, tap, lerp, linkDrag, pinch, scale, chromeOf };
};

// ---------------------------------------------------------------

const main = async () => {
  const dist = join(repoRoot, "pkg/flowgo/dist/index.html");
  if (!existsSync(dist)) skip("pkg/flowgo/dist/index.html missing — run `pnpm build`");
  const pw = await loadPlaywright();
  if (!pw) skip("playwright-core not resolvable (npm i -g playwright-core, or set PLAYWRIGHT_CORE)");
  const exe = findChromium();
  if (!exe) skip("no chromium found (set CHROMIUM=/path/to/chrome)");

  const bin = join(mkdtempSync(join(tmpdir(), "flowgo-touch-bin-")), "flowgo");
  log("building ./cmd/flowgo …");
  await buildServer(bin);

  const browser = await pw.chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const errors = [];

  // One scenario = one fresh file + one fresh server + one fresh page.
  const scenario = async (seed, fn, viewport) => {
    const file = seedFixture(seed);
    const { proc, url } = await startServer(bin, file);
    const s = await openPhone(browser, url, errors, viewport);
    try {
      await fn({ ...s, file });
    } finally {
      await s.context.close();
      proc.kill("SIGKILL");
    }
  };

  try {
    // ---------------------------------------------------------
    section("1-3. select → handles → drag → edge");
    // ---------------------------------------------------------
    await scenario("box a A 0 0\nbox b B 0 170\n", async (s) => {
      check(
        await s.page.evaluate(() => document.body.classList.contains("touch-input")),
        "coarse pointer detected (body.touch-input)",
      );
      check(
        (await s.page.evaluate(() => getComputedStyle(document.body).touchAction)) === "none",
        "canvas keeps touch-action: none (brain#24c intact)",
      );

      const cold = await s.chromeOf("a");
      check(cold.handles === 0 && cold.grips === 0, "idle box carries no chrome (brain#239)", JSON.stringify(cold));

      // 1. Tap is the entitlement — a touchscreen cannot hover.
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      const hot = await s.chromeOf("a");
      check(hot.cls.includes("selected"), "a tap selects the box", JSON.stringify(hot.cls));
      check(hot.handles === 8, "…and materializes its 8 handles", JSON.stringify(hot));
      const opacity = await s.page.evaluate(() =>
        getComputedStyle(document.querySelector('.box[data-id="a"] .handle[data-handle="b"]')).opacity);
      check(opacity === "1", "the dots are actually visible without hover", `opacity=${opacity}`);

      // 3. Cues, sampled during the drag (2).
      const seen = { near: false, drop: false, target: false, ghost: false, active: false };
      const target = await s.mustReach("b");
      await s.linkDrag("a", "b", target, async () => {
        const st = await s.page.evaluate(() => ({
          b: [...document.querySelector('.box[data-id="b"]').classList],
          ghost: getComputedStyle(document.getElementById("ghost-line")).display,
          targets: document.querySelectorAll(".handle.target").length,
          active: document.querySelectorAll(".handle.active").length,
        }));
        if (st.b.includes("proximity-target")) seen.near = true;
        if (st.b.includes("drop-target")) seen.drop = true;
        if (st.targets > 0) seen.target = true;
        if (st.active > 0) seen.active = true;
        if (st.ghost !== "none") seen.ghost = true;
      });
      check(seen.active, "the link drag is live (source handle .active)");
      check(seen.ghost, "the ghost line follows the finger");
      check(seen.near, "the near-target glow appears (brain#236)");
      check(seen.drop, "the box under the finger rings green");
      check(seen.target, "the receiving handle lights up");

      // 2. GRAPH STATE.
      const edges = edgesOf(s.file);
      check(
        edges.length === 1 && /^edge a(:\w+)? b(:\w+)?$/.test(edges[0] ?? ""),
        "GRAPH STATE: the .flowgo now carries edge a→b",
        JSON.stringify(edges),
      );
    });

    // ---------------------------------------------------------
    section("4. drop on empty canvas spawns and connects");
    // ---------------------------------------------------------
    await scenario("box a A 0 0\n", async (s) => {
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      const before = nodesOf(s.file).length;
      // Straight down into empty space, well clear of findBoxAt's
      // nearest-box fallback radius.
      await s.linkDrag("a", "b", { x: ac.x, y: ac.y + 240 });
      const nodes = nodesOf(s.file);
      const edges = edgesOf(s.file);
      check(nodes.length === before + 1, "GRAPH STATE: a box was spawned at the drop point", JSON.stringify(nodes));
      check(edges.length === 1 && /^edge a(:\w+)? /.test(edges[0] ?? ""), "GRAPH STATE: and it is connected to a", JSON.stringify(edges));
      check(
        await s.page.evaluate(() => !!document.querySelector('[contenteditable="true"]')),
        "…and opens for labelling, like the desktop link-drop",
      );
    });

    // ---------------------------------------------------------
    section("5. shaped boxes (hexagon / circle / triangle)");
    // ---------------------------------------------------------
    for (const [name, id, shape] of [["hexagon", "h", 1], ["circle", "o", 2], ["triangle", "t", 3]]) {
      // The shapes are 208–240px, so they sit ABOVE the rectangle here:
      // centred lower they would land under the bottom context bar and
      // no finger could reach them.
      const seed = `box a A 0 0\nbox ${id} S -80 -300\nboxshape ${id} ${shape}\n`;
      const vp = { width: 390, height: 844 };
      await scenario(seed, async (s) => {
        const ac = await s.mustReach("a");
        await s.tap(ac.x, ac.y);
        await s.linkDrag("a", "t", await s.mustReach(id));
        const edges = edgesOf(s.file);
        check(
          edges.length === 1 && edges[0].includes(` ${id}`),
          `GRAPH STATE: edge a→${name}`,
          JSON.stringify(edges),
        );
      }, vp);
      await scenario(seed, async (s) => {
        const sc = await s.mustReach(id);
        await s.tap(sc.x, sc.y);
        const chrome = await s.chromeOf(id);
        check(
          chrome.handles === 8 && chrome.grips === 0,
          `${name}: 8 handles and no resize grips (fixed shape)`,
          JSON.stringify(chrome),
        );
        await s.linkDrag(id, "b", await s.mustReach("a"));
        check(edgesOf(s.file).length === 1, `GRAPH STATE: edge ${name}→a (dragging FROM the shape)`, JSON.stringify(edgesOf(s.file)));
      }, vp);
    }

    // ---------------------------------------------------------
    section("6. after a pinch and a pan (scale != 1, offset != 0)");
    // ---------------------------------------------------------
    for (const [name, from, to, want] of [["zoom out", 100, 55, (v) => v < 0.95], ["zoom in", 40, 100, (v) => v > 1.1]]) {
      await scenario("box a A 0 0\nbox b B 0 120\n", async (s) => {
        await s.pinch(195, 380, from, to);
        const sc = await s.scale();
        check(want(sc), `pinch ${name} moved the data viewport`, `scale=${sc}`);

        // …then a one-finger pan, so the offset is non-trivial too.
        await s.touch("touchStart", [[350, 640]]);
        for (let i = 1; i <= 6; i++) {
          await s.touch("touchMove", [[350 - i * 4, 640 - i * 6]]);
          await wait(16);
        }
        await s.touch("touchEnd", []);
        await wait(200);

        const ac = await s.mustReach("a");
        await s.tap(ac.x, ac.y);
        check((await s.chromeOf("a")).cls.includes("selected"), `${name}: box still selectable after pinch + pan`);
        await s.linkDrag("a", "b", await s.mustReach("b"));
        check(
          edgesOf(s.file).length === 1,
          `GRAPH STATE: edge created at scale ${sc}`,
          JSON.stringify(edgesOf(s.file)),
        );
      });
    }

    // ---------------------------------------------------------
    section("7. mode interaction, re-route, and wandering over chrome");
    // ---------------------------------------------------------
    await scenario("box a A 0 0\nbox b B 0 170\n", async (s) => {
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      for (const [key, mode] of [["b", "brush"], ["l", "line"]]) {
        await s.page.evaluate((k) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })), key);
        await wait(100);
        const display = await s.page.evaluate(() =>
          getComputedStyle(document.querySelector('.box[data-id="a"] .handle[data-handle="b"]')).display);
        check(display === "none", `${mode} mode hides the handles outright (same rule as desktop)`, `display=${display}`);
        await s.page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true })));
        await wait(100);
      }
      await s.linkDrag("a", "b", await s.mustReach("b"));
      check(edgesOf(s.file).length === 1, "GRAPH STATE: the drag works again after a mode round-trip");
    });

    await scenario("box a A 0 0\nbox b B 0 170\n", async (s) => {
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      const bar = await s.rectOf("#contextBar");
      check(!!bar, "the touch context bar is on screen");
      const h = await s.rectOf('.box[data-id="a"] .handle[data-handle="b"]');
      const b = await s.mustReach("b");
      // Detour straight through the middle of the bar and back. Once a
      // gesture is in flight the move handler deliberately keeps
      // following the finger over chrome — a drag must not break there.
      await s.touch("touchStart", [[h.x, h.y]]);
      await wait(30);
      for (const p of [...s.lerp(h, bar, 8), ...s.lerp(bar, b, 8)]) {
        await s.touch("touchMove", [[p.x, p.y]]);
        await wait(16);
      }
      await s.touch("touchEnd", []);
      await wait(500);
      check(edgesOf(s.file).length === 1, "GRAPH STATE: the edge still lands after crossing the chrome", JSON.stringify(edgesOf(s.file)));
    });

    await scenario("box a A 0 0\nbox b B 0 170\nbox c C 150 170\nedge a:b b:t\n", async (s) => {
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      await s.linkDrag("a", "b", await s.mustReach("c"));
      const edges = edgesOf(s.file);
      check(edges.length === 1, "GRAPH STATE: a re-route leaves exactly one edge", JSON.stringify(edges));
      check(edges.length === 1 && / c(:\w+)?$/.test(edges[0]), "GRAPH STATE: …now anchored to c, not b", JSON.stringify(edges));
    });

    // ---------------------------------------------------------
    section("8. a proximity-lit dot must not lie (brain#278)");
    // ---------------------------------------------------------
    // The one live case of classifyTarget's `selected.has(boxId)` gate.
    // A tap on chrome is declined by onTouchStart WITHOUT
    // preventDefault, so the browser synthesizes a mousemove at the
    // finger; mouse.ts's idle hover path runs updateProximity and
    // entitles the nearest box within PROXIMITY_PX — a box nobody
    // selected. Before the fix its dots were painted solid (opacity 1)
    // yet touching one dragged the box. This is the half jsdom cannot
    // see: it takes a real coarse-pointer engine to synthesize the
    // mousemove AND resolve the media query.
    await scenario("box a A 0 -200\nbox b B 0 120\n", async (s) => {
      const bar = await s.rectOf("#contextBar");
      check(!!bar, "the touch context bar is on screen");
      // A point ON the bar itself — not on one of its buttons, which
      // preventDefault on pointerup and so suppress the compatibility
      // mouse events — and close enough to box b to be inside the
      // proximity radius. A fixture where no such point exists is a
      // FIXTURE error: the case would silently not be under test.
      const spot = await s.page.evaluate(() => {
        const el = document.getElementById("contextBar");
        const box = document.querySelector('.box[data-id="b"]');
        if (!el || !box) return null;
        const r = el.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        for (let y = r.top + 2; y < r.bottom - 2; y += 4) {
          for (let x = r.left + 2; x < r.right - 2; x += 4) {
            if (document.elementFromPoint(x, y) !== el) continue;
            const dx = Math.max(b.left - x, 0, x - b.right);
            const dy = Math.max(b.top - y, 0, y - b.bottom);
            if (Math.hypot(dx, dy) <= 55) return { x, y };
          }
        }
        return null;
      });
      if (!spot) throw new Error("fixture: no bare context-bar point within the proximity radius of box b");

      await s.tap(spot.x, spot.y);
      const near = await s.chromeOf("b");
      // The mechanism must still fire, or the opacity check below is
      // vacuous — we are asserting the dot is HIDDEN, not that the
      // chrome was never built.
      check(near.cls.includes("proximity-target"), "a chrome tap still leaks a mousemove into the proximity cue", JSON.stringify(near.cls));
      check(near.handles === 8, "…which entitles the box's chrome (brain#239)", JSON.stringify(near));
      check(!near.cls.includes("selected"), "…on a box the user never selected", JSON.stringify(near.cls));
      const opacity = await s.page.evaluate(() =>
        getComputedStyle(document.querySelector('.box[data-id="b"] .handle[data-handle="t"]')).opacity);
      check(opacity === "0", "brain#278: the dots stay INVISIBLE on a coarse pointer", `opacity=${opacity}`);

      // …and the gate that made them inert is still there, so invisible
      // and inert agree instead of contradicting each other.
      const h = await s.rectOf('.box[data-id="b"] .handle[data-handle="t"]');
      const a = await s.rectOf('.box[data-id="a"]');
      await s.touch("touchStart", [[h.x, h.y]]);
      await wait(30);
      for (const p of s.lerp(h, a, 8)) {
        await s.touch("touchMove", [[p.x, p.y]]);
        await wait(16);
      }
      await s.touch("touchEnd", []);
      await wait(500);
      check(edgesOf(s.file).length === 0, "GRAPH STATE: touching one starts no link", JSON.stringify(edgesOf(s.file)));

      // Control, in the same page: fine-scoping the proximity rule must
      // not have taken the SELECTION reveal with it.
      const ac = await s.mustReach("a");
      await s.tap(ac.x, ac.y);
      const selOpacity = await s.page.evaluate(() =>
        getComputedStyle(document.querySelector('.box[data-id="a"] .handle[data-handle="b"]')).opacity);
      check(selOpacity === "1", "a SELECTED box's dots are still visible", `opacity=${selOpacity}`);
      await s.linkDrag("a", "b", { x: h.x, y: h.y });
      check(edgesOf(s.file).length === 1, "GRAPH STATE: …and still start a link", JSON.stringify(edgesOf(s.file)));
    });

    section("uncaught page errors");
    check(errors.length === 0, "no uncaught errors in any page");
    for (const e of errors) log(`\n${e}`);
  } finally {
    await browser.close();
  }

  log(`\n${failures === 0 ? "PASS" : `FAIL (${failures})`}`);
  process.exit(failures === 0 ? 0 : 1);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
