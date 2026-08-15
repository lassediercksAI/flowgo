// @vitest-environment jsdom
//
// THE REGRESSION THIS FILE EXISTS FOR (brain#2c1). persistence.ts
// always built the right sentence for a rejected save — the sibling
// persistence-savefail.test.ts has asserted that for a while — but
// main.ts's setStatus was an empty function and index.html had no node
// to write into, so the sentence went nowhere. The old test passed
// because it injects its OWN setStatus spy: it proved the string was
// built, not that a user could read it.
//
// So every assertion here reads the DOM. Nothing in this file spies on
// setStatus, on purpose. Where it matters the message is driven all
// the way from a stubbed fetch through persistence.ts into the real
// status nodes, because "the string exists somewhere" is exactly the
// property that was already true while the bug was live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two nodes as index.html ships them. Kept verbatim so a rename
// there without a rename here fails loudly.
const STATUS_HTML = `
<div id="status">
  <div id="status-info" role="status" aria-live="polite"></div>
  <div id="status-error" class="hidden" role="alert" aria-live="assertive"></div>
</div>`;

const info = () => document.getElementById("status-info")!;
const err = () => document.getElementById("status-error")!;

// "Visible" for the error tier means: in the document, carrying the
// text, and not display:none'd via .hidden. jsdom does no layout, so
// the class is the honest proxy for the CSS rule in index.html.
const errorShown = (): boolean => !err().classList.contains("hidden") && err().textContent !== "";
// The info tier fades with opacity rather than display, so .visible is
// its proxy — see the #status-info rules in index.html.
const infoShown = (): boolean => info().classList.contains("visible") && info().textContent !== "";

const load = async (search = "/") => {
  vi.resetModules();
  window.history.replaceState(null, "", search);
  document.body.innerHTML = STATUS_HTML;
  return await import("./status.ts");
};

describe("status surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("renders a sticky, visible error and keeps it there", async () => {
    const s = await load();
    s.setStatus("save failed (413) — recent changes are NOT saved; retrying", "error");

    expect(errorShown()).toBe(true);
    expect(err().textContent).toContain("NOT saved");

    // The alarm outlives the transient tier's whole lifetime...
    vi.advanceTimersByTime(s.INFO_TTL_MS + s.INFO_FADE_MS + 60_000);
    expect(errorShown()).toBe(true);

    // ...and it outlives unrelated chatter. mouse.ts reports a
    // selection on the very next click; if that dismissed the alarm
    // the user would lose it a second after it appeared while the
    // save was still failing.
    s.setStatus("3 selected");
    expect(errorShown()).toBe(true);
    expect(err().textContent).toContain("NOT saved");
  });

  it("a successful save clears the error", async () => {
    const s = await load();
    s.setStatus("save failed (413) — recent changes are NOT saved; retrying", "error");
    expect(errorShown()).toBe(true);

    s.setStatus("saved", "ok");
    expect(errorShown()).toBe(false);
    expect(err().textContent).toBe("");
  });

  it("the error is announced assertively and steals no focus", async () => {
    const s = await load();
    const probe = document.createElement("input");
    document.body.appendChild(probe);
    probe.focus();

    s.setStatus("save failed (500) — recent changes are NOT saved; retrying", "error");

    expect(err().getAttribute("aria-live")).toBe("assertive");
    expect(info().getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(probe);
    expect(err().tabIndex).toBeLessThan(0);
  });

  it("routine info shows, then fades and clears itself", async () => {
    const s = await load();
    s.setStatus("pasted 3 items");
    expect(infoShown()).toBe(true);

    vi.advanceTimersByTime(s.INFO_TTL_MS - 1);
    expect(infoShown()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(info().classList.contains("visible")).toBe(false);
    // Text survives the fade so the pill is never on screen visibly
    // empty; it goes once the fade has finished.
    expect(info().textContent).toBe("pasted 3 items");

    vi.advanceTimersByTime(s.INFO_FADE_MS);
    expect(info().textContent).toBe("");
  });

  it("a newer info message restarts the fade instead of racing it", async () => {
    const s = await load();
    s.setStatus("first");
    vi.advanceTimersByTime(s.INFO_TTL_MS - 10);
    s.setStatus("second");
    // The first message's timer must not take the second one down.
    vi.advanceTimersByTime(20);
    expect(infoShown()).toBe(true);
    expect(info().textContent).toBe("second");
  });

  describe("embed mode", () => {
    it("suppresses routine chatter but still shows failures", async () => {
      const s = await load("/?embed=1");

      s.setStatus("saved");
      s.setStatus("pasted 3 items");
      expect(info().textContent).toBe("");
      expect(info().classList.contains("visible")).toBe(false);

      // A playground that silently drops the visitor's work is the
      // same bug in a smaller box, so errors are NOT suppressed.
      s.setStatus("save failed (413) — recent changes are NOT saved; retrying", "error");
      expect(errorShown()).toBe(true);
    });

    it("still lets a success dismiss a standing error", async () => {
      const s = await load("/?embed=1");
      s.setStatus("save failed (413) — recent changes are NOT saved; retrying", "error");
      expect(errorShown()).toBe(true);
      s.setStatus("saved", "ok");
      expect(errorShown()).toBe(false);
    });

    it("?embed=0 is not embed mode — chatter shows", async () => {
      const s = await load("/?embed=0");
      s.setStatus("saved");
      expect(infoShown()).toBe(true);
    });
  });

  // help.ts's attachHelpListeners THROWS when #helpOverlay is missing
  // and runs before most of main.ts's wiring, so a hard DOM dependency
  // added here would hand any host shipping its own HTML a blank
  // canvas. Policy is toolbar.ts's: log and carry on.
  describe("without the status nodes", () => {
    it("does not throw, and warns only once", async () => {
      vi.resetModules();
      window.history.replaceState(null, "", "/");
      document.body.innerHTML = `<div id="canvas"></div>`;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const s = await import("./status.ts");

      expect(() => s.setStatus("saved")).not.toThrow();
      expect(() =>
        s.setStatus("save failed (413) — recent changes are NOT saved; retrying", "error"),
      ).not.toThrow();
      expect(() => s.setStatus("saved", "ok")).not.toThrow();

      // A status update happens on nearly every user action; an
      // embedder without the node must not get its console filled.
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });
});

// The end-to-end half: a real rejected fetch, through the real
// persistence module, landing in the real status nodes. This is the
// assertion the pre-existing spy-based test could not make.
describe("a rejected save is visible to the user", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  const wire = async (responses: Array<{ ok: boolean; status: number }>) => {
    vi.resetModules();
    window.history.replaceState(null, "", "/");
    document.body.innerHTML = STATUS_HTML;
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      const r = responses[Math.min(n, responses.length - 1)]!;
      n++;
      return {
        ok: r.ok,
        status: r.status,
        headers: { get: () => null },
        json: async () => ({}),
        text: async () => "",
      };
    });
    const status = await import("./status.ts");
    const p = await import("./persistence.ts");
    p.wirePersistence({
      getGraph: () => ({ maps: [{ path: "/", boxes: [], edges: [], texts: [], lines: [] }] }),
      setGraph: () => {},
      // The real thing, not a spy: main.ts wires exactly this.
      setStatus: status.setStatus,
    } as never);
    return p;
  };

  it("puts the failure on screen and keeps it there while it retries", async () => {
    const p = await wire([{ ok: false, status: 413 }]);
    p.scheduleSave();
    await vi.runOnlyPendingTimersAsync();

    expect(errorShown()).toBe(true);
    expect(err().textContent).toContain("413");
    expect(err().textContent).toContain("NOT saved");
  });

  it("and takes it down once a save lands", async () => {
    const p = await wire([
      { ok: false, status: 413 },
      { ok: true, status: 200 },
    ]);
    p.scheduleSave();
    await vi.runOnlyPendingTimersAsync();
    expect(errorShown()).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // the retry window
    expect(errorShown()).toBe(false);
  });
});
