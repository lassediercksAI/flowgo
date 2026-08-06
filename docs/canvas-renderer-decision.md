# Canvas base renderer — decision brief

**brain#23b.** Should flowgo put a canvas/WebGL base layer under the
editor and keep DOM only where the user is interacting?

## TL;DR

**Yes, eventually — but as a two-day throwaway spike, not as work you
schedule now, and canvas 2D rather than WebGL.**

Three measured findings drive everything below.

1. **Map size is already a solved problem.** A 100,000-box map pans,
   zooms, hovers, selects and drags with the *same* ~950 DOM nodes and
   the same frame times as a 3,400-box map. Viewport culling (#23a)
   decoupled render cost from map size. There is no renderer crisis at
   normal zoom, at any map size.
2. **Zoomed out is the only failure mode**, because culling saves
   nothing when everything is in the viewport. The DOM ceiling there is
   **~5,000 simultaneously visible items** — and ~1,500 if the map uses
   hexagons, circles, triangles or resized boxes. Against a 100,000-node
   target that is a 20× gap that no DOM tuning closes. This is the one
   place the card's premise survives contact with measurement.
3. **Canvas 2D is enough.** Batched into one path per palette, 100,000
   rects draw in **3.9 ms** and 1,000,000 in 39 ms. WebGL is overkill at
   the 100k target by more than an order of magnitude.

But the thing that actually stops a 100k map today is **not the
renderer**: nudging one box blocks the main thread for 189 ms and adds
5.9 MB to the heap, because every edit `JSON.stringify`s the whole graph
for the undo stack. Fixing the renderer without fixing that produces a
map that draws beautifully and cannot be edited.

**Recommendation:** run the spike in [§6](#6-the-spike) to retire the
risk, then do nothing further until the trigger in
[§5](#5-recommendation) fires.

## Constraints this brief was written against

Operator decisions, taken as given:

| | |
| --- | --- |
| Target scale | **~100k nodes.** The card title says "millions"; that overreaches and is not costed here. |
| Demand | **Speculative.** No user is asking for this. It is a capability claim, not a reported problem. |
| Level of detail | **Accepted.** Below the zoom where text would be sub-pixel, drop labels and keep shape + colour. At 100k nodes fully zoomed out each node is ~4 px², so pixel-identical rendering is not physically available — the browser is already rasterising labels into mush. |
| Goal | **Prove it's possible.** A time-boxed, throwaway spike. Not production work, not a migration. |

The LOD decision is load-bearing: text is the expensive part of raster
rendering (see [§3](#3-canvas-2d-vs-webgl)), and dropping it at overview
zoom is what makes canvas 2D sufficient.

---

## 1. Method

Real binary, real browser, not jsdom.

| | |
| --- | --- |
| Machine | Apple M4 Mac mini, 16 GB, macOS 26.4 |
| Browser | Chrome for Testing 1234 (Playwright), window 1440×900 |
| Build | `pnpm exec vite build` + `go build ./cmd/flowgo` at `b1e3dd8` (v0.3.11) |
| Fixtures | `just perf-fixture <out> <n>` — seeded LCG, 200×140 px grid, plus `n/2` lines, `n/5` edges, `n/20` texts, `n/50` strokes |
| Metric | worst gap between consecutive `requestAnimationFrame` callbacks during the gesture — the longest the main thread was blocked, which is what a user feels |

One frame at 60 Hz is 16.7 ms. The rAF sampler reports ~17–20 ms when
nothing is wrong, so **treat anything under ~35 ms as "smooth"**.

### Map size is not the axis

Standard density, so ~50 boxes visible at 100 % zoom. Worst blocked
frame, ms:

| boxes | file | load (ms) | first box (ms) | DOM nodes | box els | heap (MB) | pan | zoom | hover | select | select-all | drag | paste 200 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3,400 | 0.2 MB | 1,579 | 28 | 954 | 48 | 4.2 | 33 | 28 | 21 | 23 | 29 | 21 | 24 |
| 10,000 | 0.6 MB | 1,601 | 49 | 958 | 45 | 9.8 | 40 | 30 | 27 | 21 | 27 | 26 | 22 |
| 50,000 | 3.3 MB | 1,797 | 245 | 940 | 54 | 35.7 | 33 | 28 | 20 | 27 | 36 | 27 | 122 |
| 100,000 | 6.7 MB | 2,316 | 759 | 978 | 54 | 78.9 | 38 | 28 | 23 | 23 | 61 | 21 | 208 |

**954 DOM nodes at 3,400 boxes; 978 at 100,000.** Pan, zoom, hover,
select and drag are flat across a 30× increase in map size. Whatever
this card is for, it is not this.

---

## 2. The zoomed-out cliff

`MIN_SCALE = 0.5` (`src/editor/viewport.ts:27`) is what makes the table
above true: the editor refuses to show you more than a few hundred items
at once, so culling always has something to cull. Removing that cap is
the entire question.

Measured on the 100,000-box fixture with a throwaway build where
`MIN_SCALE` is lowered to 0.01, stepping the zoom control out one notch
(÷1.25) at a time:

| zoom | box elements | DOM nodes | SVG nodes | heap (MB) | worst blocked frame (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 % | 54 | 978 | 380 | 79.8 | — |
| 51 % | 106 | 1,670 | 966 | 38.8 | 48 |
| 26 % | 274 | 3,610 | 2,562 | 38.9 | 46 |
| 13 % | 851 | 10,402 | 8,170 | 62.7 | 50 |
| 9 % | 1,868 | 22,187 | 17,867 | 64.4 | 54 |
| 7 % | 2,789 | 32,691 | 26,487 | 41.3 | 89 |
| 5 % | 4,278 | 48,024 | 38,760 | 68.3 | 92 |
| **4 %** | **6,559** | **71,309** | 57,383 | 53.0 | **858** |
| 4 % | 10,047 | 104,079 | 83,008 | 54.9 | 1,087 |
| 3 % | 15,523 | 151,076 | 118,793 | 48.7 | 347 |
| 2 % | 23,966 | 216,574 | 166,957 | 55.4 | 598 |
| 2 % | 37,033 | 299,803 | 223,403 | 58.3 | 1,028 |
| 1 % | 57,490 | 398,962 | 280,659 | 74.7 | 2,117 |
| 1 % | **100,000** | **538,167** | 332,678 | 101.8 | 2,143 |

Two things are true at once here, and both matter.

**It does not fall over.** The whole 100,000-box map materialises —
538,167 DOM nodes, 101.8 MB heap, zero `pageerror`s. The received wisdom
that "the DOM cannot hold 100k elements" is, on this machine and this
browser, wrong. Chrome holds half a million nodes fine.

**But it stops being interactive at ~5,000 items on screen.** The knee is
sharp and sits between 4,278 boxes (92 ms — bad but survivable) and 6,559
boxes (858 ms — a slideshow). Past that every zoom step costs 0.3–2.1
seconds. Note also that boxes are the *minority* of the DOM cost — at
5 % zoom the SVG line/stroke/edge layers are 38,760 of the 48,024 nodes
(~81 %). A raster base layer has to take the SVG layers with it, not just
the boxes.

So the DOM ceiling for a zoomed-out overview is **~5,000 simultaneously
visible items**, and the target is 100,000 — a 20× gap. That gap is real
and no amount of DOM tuning closes it. This is the one place where the
card's premise holds up.

(Blocked-frame figures above ~10,000 items are noisy — the work spreads
across several rAF passes and GC dominates, which is why the 88,988-box
step reads as 17 ms. The tab is unresponsive throughout regardless.)

### What breaks, in order

Only row 4 is a rendering problem.

| # | Wall | Where | Evidence | Fixed by canvas? |
| --- | --- | --- | --- | --- |
| 1 | **Whole-graph `JSON.stringify` per edit** | every mutation → `mutations.ts` `fire()` → `scheduleSave` (200 ms debounce) → `JSON.stringify(getGraph())` (`persistence.ts:236`) | nudge one box: **27 ms @ 3.4k → 117 ms @ 50k → 189 ms @ 100k**; undo: 36 → 163 → **294 ms** | **No** |
| 2 | **Undo history memory** | `persistence.ts:63,73` — `UNDO_LIMIT = 100`, `undoStack: string[]` of full-graph JSON | **+5.9 MB heap per edit at 100k** (12 edits: 78 → 149 MB). At the 100-entry limit that is ~590 MB of strings | **No** |
| 3 | **JS heap for the data model** | ~0.8 KB/box (4.2 MB @ 3.4k, 78.9 MB @ 100k) | 100k ≈ 79 MB before undo history | **No** |
| 4 | **Materialization cost per visible item** | `render.ts` `materializeBox`, `updateCulling` | see the zoom-out table | **Yes** |
| 5 | **`O(map)` cull pass per pan re-evaluation** | `updateCulling` (`render.ts:1315`) walks every box/text/image/line/stroke/edge; `requiredEdgeBoxIds` (`culling.ts:227`) builds a fresh `Map` of *all* boxes; `cullEdges` then calls `rebuildBoxIndex(map)` again | pan 33 → 38 ms over 3.4k → 100k | **No** — data-structure problem |
| 6 | **Initial parse + first render** | 28 → 759 ms over 3.4k → 100k, linear; `/state` fetch+parse alone is 716 ms at 100k | | Partly |

**Rows 1–3 bite before row 4 does.** A 100k map on today's data model is
already unpleasant to *edit* at normal zoom, where the renderer is
demonstrably fine. Any plan that fixes the renderer first ships a map
you can admire and not use.

### Two rendering costs worth naming

**Layout thrash at materialization — a 5–14× multiplier, and a bug.**
Every box with a fixed frame — resized boxes *and every hexagon, circle
and triangle* — runs `updateSizedLabelClamp` /
`updateFixedShapeLabelClamp` immediately after insertion
(`render.ts:535-541`). Those call `getComputedStyle` twice and read
`clientHeight` (`label-clamp.ts:47-66`), forcing a synchronous
style+layout flush **per element, interleaved with insertion** — the
textbook layout-thrash pattern.

Controlled A/B, identical zoom-step method, only difference being
whether the fixture carries `nodesize` (and therefore the `.sized`
class):

| box elements on screen | auto-sized boxes | fixed-frame boxes | ratio |
| ---: | ---: | ---: | ---: |
| ~850 / 728 | 50 ms | 52 ms | 1.0× |
| ~1,868 / 1,599 | 54 ms | 257 ms | 4.8× |
| ~2,789 / 2,350 | 89 ms | 511 ms | 5.7× |
| ~4,278 / 3,538 | 92 ms | **1,271 ms** | 13.8× |
| ~6,559 / 5,400 | 858 ms | **3,694 ms** | 4.3× |

The fixed-frame fixture is the *lighter* map — 11 SVG nodes against tens
of thousands — and is still 5–14× slower per materialized box. **Any map
built from hexagons, circles or triangles hits its ceiling at ~1,500
visible items instead of ~5,000.** Batching the measurement, or deriving
the line count arithmetically from `w`/`h` and font size, is a contained
fix worth doing regardless of what happens to this card.

**`O(map)` cull scan.** Row 5. `proximity-index.ts` already demonstrates
the fix: a uniform 256 px grid in data space. A sibling index over data
rects (culling already carries conservative size estimates —
`EST_ITEM_W/H`) makes the cull pass `O(visible)`. ~200 lines, same shape
as an existing tested module. **A raster renderer needs this too**, so it
is not throwaway work either way.

---

## 3. Canvas 2D vs WebGL

Measured directly: draw *n* flowgo-ish boxes filling a 1440×900 canvas
(the zoomed-all-the-way-out case), median ms per full redraw over 12
frames, Chrome for Testing on the M4.

| n | batch (one path per palette, 10 `fill()` calls) | dot (`fillRect` each) | shape (`roundRect` + per-item `stroke`) | text (shape + centred label) |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | **0.5** | 1.3 | 4.2 | 22.7 |
| 50,000 | **2.1** | 7.3 | 63.4 | 187.9 |
| 100,000 | **3.9** | 19.4 | 106.0 | 371.9 |
| 250,000 | **9.9** | 67.2 | 277.9 | 976.0 |
| 1,000,000 | **39.2** | 282.2 | 1,108.3 | 3,991.6 |

Three conclusions:

- **At the 100k target, canvas 2D is not close to being the bottleneck**
  — 3.9 ms is a quarter of a frame budget, with the whole map on screen,
  redrawn from scratch every frame. A tile/offscreen cache (redraw only
  on zoom, translate a bitmap on pan) makes it cheaper still.
- **WebGL earns nothing here.** It would begin to matter somewhere past
  ~1M items, where batched 2D reaches 39 ms/frame. That is beyond the
  agreed target and would add a glyph atlas, tessellation, DPR handling,
  context-loss recovery and GPU-driver bugs that CI cannot reproduce.
- **The LOD decision is what makes this work.** Per-item `stroke()` costs
  5× a batched fill; text costs another 3.5× on top. `text` at 100k is
  372 ms/frame — unusable. Confirming the operator's read: with LOD
  accepted, text stops being the bottleneck; without it, nothing else
  matters.

**Verdict: canvas 2D, batched by palette, labels dropped below a zoom
threshold.** The Go OG-image renderer (`flowgo-website
internal/ogimage`) already solved the label-visibility-vs-zoom
heuristic — reuse its rule (`minLabelPx`).

---

## 4. Options

Effort: **S** = days, **M** = weeks, **L** = months.

### (a) Cap zoom-out; navigate via submaps instead

| | |
| --- | --- |
| Work | None to the renderer. Keep `MIN_SCALE` where it is; lean on the nested-map model flowgo already has (`navigation.ts`, `graph/submap.ts`) plus a minimap or search for wayfinding |
| Rewrites | Nothing |
| Breaks | Nothing |
| Effort | **0–S** |
| Cost | You cannot show a 100k-node map as one picture. The "millions of nodes" marketing claim becomes "unlimited nodes, navigated hierarchically" |
| Buys | The entire problem, for free |

This deserves fair treatment because it fits the product's own model:
flowgo is a *nested* map tool, and "zoom out until 100k nodes are 4 px²
each" is not obviously a thing anyone wants to look at. The honest
counter-argument is that a single zoomed-out overview is a real
wayfinding affordance and the thing that makes big maps *feel*
tractable — a minimap is the cheap 80 % of it.

### (b) Keep DOM, push culling/virtualization further

| | |
| --- | --- |
| Work | Data-space spatial index for the cull pass; batch/eliminate the label-clamp reflow |
| Rewrites | Additive changes in `render.ts` / `culling.ts` / `label-clamp.ts` |
| Breaks | Nothing; all 398 tests stay valid |
| Effort | **S–M** |
| Cost | Zero features |
| Buys | Pan cost independent of map size; visible-item ceiling moves up roughly an order of magnitude. **Does not** reach 100k visible — DOM element count is a hard wall well below that |

Worth doing on its own merits. Not a substitute for (c) if the zoom-out
overview is actually wanted.

### (c) Canvas 2D base layer + DOM interaction overlay

| | |
| --- | --- |
| Work | A raster painter for the base layer; DOM retained for the selection, the hover/proximity target, the item being edited, and all chrome |
| Rewrites | `render.ts` (1,579 lines) and every element-dependent consumer: `attach.ts` (693), `mouse.ts` (693), `touch.ts` (1,113), `movers.ts` (500), `contextbar.ts` (408), `align.ts` (294), `edit.ts` (228), `anchors.ts`, `factories.ts`, `media.ts`, `brush.ts`, `line.ts` — **24 `offsetWidth`/`offsetHeight` call sites across 11 files** |
| Breaks | Text metrics (see [§7](#7-what-the-dom-gives-us-today)); find-in-page; browser text zoom; print-to-vector |
| Effort | **L** as production work; **S** as the read-only spike in [§6](#6-the-spike) |
| Cost | See [§7](#7-what-the-dom-gives-us-today) |
| Buys | 100k items on screen at 3.9 ms/frame |

### (d) WebGL base layer + DOM overlay

Same rewrite as (c), plus instanced quads, a glyph atlas or SDF text,
tile caching, shader paths for the hex/circle/triangle silhouettes,
curve tessellation for line styles 2/3, DPR, context loss. **Effort L+,
buys nothing measurable at 100k.** Ruled out by [§3](#3-canvas-2d-vs-webgl).

### (e) Hybrid — DOM under N items, canvas above

The switch is not a separate option so much as the *shape* any real
version of (c) has to take: DOM stays for the readable zooms where all
the interaction lives, canvas takes over for the overview zoom where
nothing is interactive anyway. Cost is two render paths to keep
correct, and a visible behaviour cliff at the boundary (find-in-page and
browser text zoom stop working past it). That cost is acceptable
precisely because the boundary coincides with "text is too small to read
or click".

### Was the DOM render chain a detour?

#236 (proximity index), #237 (diff `applyClasses`), #238 (incremental
`renderAll`), #239 (lazy chrome), #23a (culling) and #24f (bulk paste)
all landed days ago. Mostly stepping stone:

| Card | Survives a raster renderer? |
| --- | --- |
| #236 proximity index | **Yes** — more necessary without DOM hit-testing |
| #23a viewport culling | **Yes** — `culling.ts` is deliberately DOM-free, and its `wireCulling` provider slot is exactly the seam a second renderer plugs into |
| #24f memoized `uid` | **Yes** — pure data-model cost |
| #238 incremental `renderAll` | **Partly** — the "rebuild only these ids" contract survives, the `insertBefore` z-order machinery does not |
| #237 diff `applyClasses` | **No** — class toggling is inherently DOM |
| #239 lazy chrome | **No**, though the entitlement logic is reusable |

Roughly two thirds is renderer-agnostic, and the third that isn't was
the cheapest third. More to the point, #23a is what produced the finding
in §1 that makes this decision easy.

---

## 5. Recommendation

**Run the spike ([§6](#6-the-spike)). Ship nothing else against this
card until the trigger fires.**

Order of work, if big maps become a real goal:

1. **First, and regardless (S):** kill the whole-graph `JSON.stringify`
   per edit and the full-snapshot undo stack — rows 1–2 of §2. This is
   card #23c. At 100k it is the difference between a 189 ms hitch on
   every nudge and a usable editor. **The renderer work is pointless
   without it.**
2. **Then (S):** the `O(visible)` cull index and the label-clamp reflow
   fix — option (b). Needed by both paths.
3. **Then, if and only if the trigger below fires:** option (c), shaped
   as (e).

### The ceiling

| | |
| --- | --- |
| DOM path, normal zoom | **No practical limit from the renderer.** Flat to 100k boxes; the data model breaks first |
| DOM path, zoomed out, plain boxes | **~5,000 visible items.** Knee between 4,278 (92 ms) and 6,559 (858 ms). Renders 100k at 538k DOM nodes without crashing, at ~2 s per zoom step |
| DOM path, zoomed out, hex/circle/triangle/resized | **~1,500 visible items** — the label-clamp reflow, fixable |
| Canvas 2D, batched, no labels | 100k @ 3.9 ms; ~1M @ 39 ms |
| Editing a 100k map today | 189 ms per edit, 294 ms per undo, +5.9 MB heap per edit |

### The trigger

**Start option (c) when a zoomed-out overview of a >20,000-node map is a
committed product feature** — i.e. when someone decides `MIN_SCALE` must
drop below ~0.1 and that submap navigation plus a minimap is not an
acceptable answer.

Until then the honest position is: the use case is speculative; at every
zoom the product currently permits, the renderer is not the binding
constraint (the data model is); and the cheapest path to the same
user-visible outcome — "I can see and navigate my whole 100k map" — is
option (a) plus a minimap, which costs days rather than months and loses
nothing.

The spike is worth running anyway, because it is two days and it
converts "we think this is possible" into "we have a screenshot".

---

## 6. The spike

Time-boxed to **two days**, throwaway, on a branch nobody merges. It
exists to answer one question — *can a canvas base layer render a
zoomed-out 100k-node flowgo map at interactive framerates while the DOM
keeps handling interaction?* — and then be deleted.

**Do:**

1. Generate the fixture: `just perf-fixture /tmp/fx-100000.flowgo 100000`.
2. Add a `<canvas>` behind `#canvas` in `index.html`, sized to the
   window, transformed by the same viewport translate/scale that
   `viewport.ts applyViewport` already computes.
3. Write `src/render/raster.ts` as a **pure function**
   `(map, viewportRect, scale, ctx) => void`. Import the existing pure
   helpers unchanged — `graph/shape.ts` (`fixedShapeSize`),
   `graph/palette.ts` (`resolvePalette`), `graph/handle.ts`
   (`rectAnchor`), `graph/segrect.ts`. No editor state, no DOM reads.
4. Implement exactly two LOD levels:
   - `scale * boxHeight < ~8 px` → batched rects, one `Path2D` per
     palette, one `fill()` each, no stroke, no label;
   - above that → per-item rounded rect + stroke + label.
     Take the threshold from the Go OG-image renderer's `minLabelPx`.
5. Gate on scale: below `MIN_SCALE` the canvas draws and the DOM path is
   told to cull *everything*; at or above it, the canvas draws nothing
   and today's DOM path is untouched. Lower `MIN_SCALE` to 0.01 behind
   the same flag.
6. Measure with the rAF-gap sampler: pan and zoom at 100k, fully zoomed
   out. Record ms/frame and heap.

**Explicitly do not:**

- touch `attach.ts`, `mouse.ts`, `touch.ts`, `movers.ts` or `edit.ts` —
  nothing is interactive at overview zoom, which is the whole reason
  this is a two-day job and not a two-month one;
- implement hit-testing, selection chrome, or inline editing on canvas;
- attempt text-metric parity with the DOM path;
- write tests beyond a smoke check, or worry about a11y — it is
  throwaway.

**Success criteria:** the whole 100k map on screen, pan and zoom with
worst blocked frame **< 50 ms**, no `pageerror`, and a screenshot that
is legibly a map rather than grey mush. Predicted from §3: comfortably
achievable.

**What it de-risks:** whether "draw the whole map" is affordable at all
(answered in the abstract by §3; the spike answers it against *real
data*, real geometry and the real viewport transform), and whether the
canvas transform can be kept in sync with the DOM path frame-for-frame.

**What it deliberately does not de-risk:** text metrics, hit-testing,
editing, accessibility. Those are the expensive parts, and they are only
worth costing once the trigger in §5 has fired.

---

## 7. What the DOM gives us today

If (c) ever becomes production work rather than a spike, this is the
bill. The section people skip and regret.

### Cheap to re-implement on canvas

| Feature | Today | Canvas |
| --- | --- | --- |
| 9 palettes (`graph/palette.ts`) — 56 CSS rules across 7 element kinds | cascade | one lookup table |
| 4 shapes: rect+radius, circle, hex `polygon(25% 0%,…)`, triangle | `clip-path` + pseudo-elements | `Path2D`, trivial |
| 8 handles + 4 grips per box, shape-specific positions (~30 CSS rules) | CSS | geometry already in `graph/handle.ts`, `graph/shape.ts` |
| `.selected` / `.drop-target` / `.resizing` colour swaps, selection band, align guides | class toggles | direct draw calls |
| Lines/strokes/edges, arrowheads, dashes, round joins | SVG `<path>` + `<marker>` | direct `ctx` calls |
| 12 cursors incl. a data-URI pencil | `cursor:` | still `style.cursor` on the host |
| `@media (pointer: coarse)` handle sizing | 2 media queries | one `matchMedia` boolean |
| Hit-testing | delegation + `elementsFromPoint` + `.closest()` | `isPointInPath` over a z-ordered spatial-index walk; `proximity-index.ts` is the template |

### Hard but doable

- **Text measurement and layout.** Auto-sized boxes shrink-to-fit their
  label — *width and height are never stored, they are a browser layout
  result*. Fixed frames wrap with `overflow-wrap: break-word` and
  ellipsise via `-webkit-line-clamp` with a JS-computed line count.
  **24 `offsetWidth`/`offsetHeight` read sites in 11 files** consume
  those results: edge routing, all 8 handle anchors, band-select,
  align/distribute, resize, create/paste/drop centring, centre-on-box
  navigation, the proximity index. No web fonts are used (`system-ui`),
  so today's metrics are *per-OS and unspecified*; matching them exactly
  is not possible, and **stored `b.w`/`b.h` plus the hexagon lattice
  snap in `graph/hex.ts` assume the current rendered sizes**, so drift
  changes existing files. This is the single biggest risk in (c) — and
  the spike sidesteps it entirely by not drawing text.
- **`filter: drop-shadow` on clipped silhouettes** (hex/triangle),
  including the stacked has-submap + selected double shadow.
- **HiDPI**: crisp 1 px / 2 px borders become your problem.

### Effectively lost

| Feature | Note |
| --- | --- |
| **Find-in-page (Cmd+F) on labels** | works today for materialized items; needs a hidden mirror DOM otherwise |
| **Browser text zoom / OS minimum font size** | today `em`-based padding reflows every box for free |
| **Print / Save-as-PDF with real vector text** | canvas prints as a bitmap |
| **The cheap accessibility escape hatch** | canvas items carry **zero** `aria-*`/`role`/`tabindex` today, so the immediate regression is ~nil — but adding roles to existing `div`s is a day's work, whereas on canvas it means building and maintaining a parallel a11y tree forever |
| **IME, spellcheck, autocorrect, native field undo, caret model** | `edit.ts` is only 228 lines because `contenteditable` does the rest; `media.ts:179-182` explicitly defers paste to the browser while a label is being edited. Mitigation is the DOM overlay — which works, but then canvas and DOM text layout must agree pixel-for-pixel or labels jump on edit entry |
| **Cascade-composed cues** | e.g. `#canvas:has(.dragging) #alignToolbar`, and the has-submap × selected × dragging × resizing shadow matrix — ~15 CSS rules become explicit imperative branches |

**Zero loss:** mouse text selection inside labels — `.box` and
`.text-item` already set `user-select: none`.

---

## 8. Reproducing these numbers

```
# machine-independent op counts (what CI gates on)
just perf

# fixtures
just perf-fixture /tmp/fx-100000.flowgo 100000
```

The jsdom harness (`src/editor/perf/`) asserts DOM-*operation* counts and
cannot see layout, paint or compositing — which is exactly where the
costs in §2 live. Work on this axis needs a real-browser harness
(`playwright-core` + Chrome for Testing + rAF-gap sampling); the scripts
used for this brief are attached to the brain card's comment thread. The
zoom-out table required a throwaway build with `MIN_SCALE` lowered to
0.01 in `src/editor/viewport.ts:27`.
