// Live-events client (brain#250): event triage + the retry policy
// that turns "the document is dirty right now" into "the change lands
// as soon as it's safe".
//
// Transport itself (EventSource, reconnect, the SSE frames) is covered
// end-to-end against a real `flowgo --host` + headless Chromium — see
// scripts/live-e2e.mjs. These tests pin the decisions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideLiveEvent,
  startLive,
  currentNotice,
  NOTICE_AFTER_MS,
  RETRY_MS,
  requestRefresh,
  resetLive,
  SESSION_ID,
  wireLive,
  type RefreshOutcome,
} from "./live.ts";

describe("decideLiveEvent", () => {
  const ctx = { sessionId: "s-me", knownRevision: 5 };

  it("ignores an event this page caused", () => {
    // Server-side suppression is the primary mechanism; this is the
    // client-side backstop. Without one of the two, every save the
    // editor makes returns as a full rebuild of its own work.
    expect(decideLiveEvent({ rev: 9, origin: "s-me" }, ctx)).toBe("self");
  });

  it("acts on an event another writer caused", () => {
    expect(decideLiveEvent({ rev: 6, origin: "mcp" }, ctx)).toBe("refresh");
    expect(decideLiveEvent({ rev: 6, origin: "s-other" }, ctx)).toBe("refresh");
    expect(decideLiveEvent({ rev: 6, origin: "file" }, ctx)).toBe("refresh");
  });

  it("ignores a revision already applied", () => {
    expect(decideLiveEvent({ rev: 5, origin: "mcp" }, ctx)).toBe("stale");
    expect(decideLiveEvent({ rev: 1, origin: "mcp" }, ctx)).toBe("stale");
  });

  it("acts on a hello that reports a revision we don't have", () => {
    // The reconnect story: hello carries no origin, so a newer
    // revision means we slept through a change.
    expect(decideLiveEvent({ rev: 8 }, ctx)).toBe("refresh");
    expect(decideLiveEvent({ rev: 5 }, ctx)).toBe("stale");
  });

  it("acts on a malformed event rather than silently going deaf", () => {
    // A payload we can't read is not evidence that nothing happened.
    expect(decideLiveEvent({}, ctx)).toBe("refresh");
  });

  it("mints a session id that isn't a reserved origin", () => {
    expect(SESSION_ID).not.toBe("mcp");
    expect(SESSION_ID).not.toBe("file");
    expect(SESSION_ID.length).toBeGreaterThan(8);
  });
});

describe("refresh pump", () => {
  let outcomes: RefreshOutcome[];
  let calls: number;
  let status: string[];

  const wire = (): void => {
    calls = 0;
    status = [];
    wireLive({
      refresh: () => {
        calls++;
        return Promise.resolve(outcomes.shift() ?? "unchanged");
      },
      knownRevision: () => 0,
      setStatus: (s) => status.push(s),
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetLive();
    outcomes = [];
    wire();
  });

  afterEach(() => {
    resetLive();
    vi.useRealTimers();
  });

  it("applies a clean refresh once and stops", async () => {
    outcomes = ["applied"];
    requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    expect(status).toContain("updated from disk");

    // No retry armed: nothing left to do.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 5);
    expect(calls).toBe(1);
    expect(currentNotice()).toBeNull();
  });

  it("retries a deferred refresh until the document is clean", async () => {
    // The dirty case is almost always a save debounce closing, so the
    // change should land on its own — the user does nothing.
    outcomes = ["deferred", "deferred", "applied"];
    requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toBe(3);

    // Applied — the loop stops.
    await vi.advanceTimersByTimeAsync(RETRY_MS * 5);
    expect(calls).toBe(3);
  });

  it("stays quiet through a short deferral, then surfaces the notice", async () => {
    outcomes = Array<RefreshOutcome>(50).fill("deferred");
    requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    // A sub-second deferral is an in-flight save, not the user's
    // problem — don't flash a banner at them for it.
    expect(currentNotice()).toBeNull();

    await vi.advanceTimersByTimeAsync(NOTICE_AFTER_MS + RETRY_MS);
    expect(currentNotice()).toMatch(/unsaved edits/i);
  });

  it("clears the notice once the change finally lands", async () => {
    outcomes = [
      ...Array<RefreshOutcome>(20).fill("deferred"),
    ];
    requestRefresh();
    await vi.advanceTimersByTimeAsync(NOTICE_AFTER_MS + RETRY_MS * 2);
    expect(currentNotice()).not.toBeNull();

    outcomes = ["applied"];
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2);
    expect(currentNotice()).toBeNull();
  });

  it("backs off on failure instead of hammering a dead server", async () => {
    outcomes = Array<RefreshOutcome>(10).fill("failed");
    requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toBe(2);

    // Second retry waits twice as long: not yet at RETRY_MS...
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(calls).toBe(3);
  });

  it("collapses a burst of events into one refresh plus one follow-up", async () => {
    // An agent doing add_box × 20 emits 20 events. Each one is an
    // idempotent "go re-read", so the client must not queue 20 fetches.
    outcomes = ["unchanged", "unchanged", "unchanged"];
    requestRefresh();
    requestRefresh();
    requestRefresh();
    requestRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(calls).toBeLessThanOrEqual(2);
  });
});

// The editor bundle is shared with the hosted service, which serves no
// /events route. Before this gate, flowgo-map.com opened an EventSource
// to a 404 and EventSource's own retry loop parked a "lost the live
// connection" banner on a page where live updates were never offered.
describe("startLive opt-in gate", () => {
  const flag = globalThis as { FLOWGO_LIVE?: boolean };
  let constructed = 0;

  beforeEach(() => {
    constructed = 0;
    resetLive();
    delete flag.FLOWGO_LIVE;
    class FakeES {
      static OPEN = 1;
      readyState = 0;
      constructor() {
        constructed++;
      }
      addEventListener() {}
      close() {}
    }
    (globalThis as { EventSource?: unknown }).EventSource = FakeES;
  });

  afterEach(() => {
    resetLive();
    delete flag.FLOWGO_LIVE;
  });

  it("opens no stream when the server has not opted in", () => {
    startLive();
    expect(constructed).toBe(0);
  });

  it("opens a stream when the server injects FLOWGO_LIVE", () => {
    flag.FLOWGO_LIVE = true;
    startLive();
    expect(constructed).toBe(1);
  });
});
