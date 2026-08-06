// Live document events for the flowgo CLI (`flowgo <file> --host`).
//
// The CLI serves the editor AND an MCP endpoint from one process, so
// an agent can rewrite the .flowgo file while a human has it open.
// Before this module the browser fetched /state exactly once, at page
// load, so every agent edit was invisible until a manual refresh —
// which defeats the point of running --host in the first place.
//
// Transport: server-sent events on GET /events (pkg/flowgo/events.go).
// One-way server→browser is all this needs — the browser already
// pushes through /save — and EventSource reconnects on its own, so
// there is no dependency, no handshake, and no reconnect loop to get
// subtly wrong.
//
// This module is only the transport and the retry policy. It never
// touches the graph: an event means "revision N exists", and the
// actual re-read + apply (including the dirty-document policy) lives
// behind the `refresh` binding, in persistence.ts.
//
// Echo suppression is by identity, never by timing: SESSION_ID is
// minted once per page, sent on /save as X-Flowgo-Session and on the
// /events query string, and the server never delivers a change back to
// the session that caused it. decideLiveEvent re-checks client-side so
// a future server that forgets can't make the editor rebuild itself.

/** Outcome of one attempt to pull the server's document. */
export type RefreshOutcome =
  /** The server's document was newer and is now on screen. */
  | "applied"
  /** We were already current — nothing to do, nothing to say. */
  | "unchanged"
  /** The local document is dirty; applying would destroy work. */
  | "deferred"
  /** The fetch failed (server gone, transient network). */
  | "failed";

export interface LiveEvent {
  readonly rev?: number;
  readonly origin?: string;
}

export interface LiveBindings {
  /** Re-read the server's document and apply it if that's safe. */
  readonly refresh: () => Promise<RefreshOutcome>;
  /** Highest revision this page knows it has seen. */
  readonly knownRevision: () => number;
  readonly setStatus: (s: string) => void;
}

// Retry cadence. A deferred refresh means the user is mid-edit or a
// save is in flight — both resolve in well under a second, so a short
// fixed retry converges quickly without the user doing anything. A
// failed refresh means the server is gone, so back off.
export const RETRY_MS = 400;
export const MAX_BACKOFF_MS = 5_000;
// Don't flash a banner for the sub-second deferral of an in-flight
// save. Only tell the user once "we can't apply this" has actually
// become their problem.
export const NOTICE_AFTER_MS = 1_500;
// EventSource fires `error` on every reconnect attempt, including ones
// that succeed immediately. Only surface a dropped connection once
// it's persisted long enough to matter.
export const OFFLINE_AFTER_MS = 3_000;

const DIRTY_NOTICE =
  "This map changed elsewhere. Your unsaved edits are keeping the update off-screen — it lands as soon as they're saved.";
const OFFLINE_NOTICE =
  "Lost the live connection to flowgo. Retrying — changes made elsewhere won't appear until it's back.";

let bindings: LiveBindings | null = null;
const must = (): LiveBindings => {
  if (!bindings) throw new Error("live: wireLive() not called");
  return bindings;
};

export const wireLive = (b: LiveBindings): void => {
  bindings = b;
};

// ---------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------

const mintSessionId = (): string => {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return "s-" + c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    return "s-" + Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  }
  // Last resort (very old browsers, and Node in tests). Collision here
  // costs echo suppression between two tabs, not correctness — a
  // spurious rebuild, never lost data.
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
};

/**
 * This page's identity, for the lifetime of the document. Two tabs on
 * the same map get different ids, which is exactly what makes story 5
 * (two tabs stay in sync) work: each hears the other's saves and
 * ignores only its own.
 */
export const SESSION_ID: string = mintSessionId();

// ---------------------------------------------------------------
// Event triage (pure — this is the part worth unit-testing)
// ---------------------------------------------------------------

export type LiveDecision =
  /** Our own write coming back. Ignore, or the page rebuilds itself. */
  | "self"
  /** A revision we already have. Ignore. */
  | "stale"
  /** Something new exists on the server. Go and get it. */
  | "refresh";

export const decideLiveEvent = (
  ev: LiveEvent,
  ctx: { readonly sessionId: string; readonly knownRevision: number },
): LiveDecision => {
  if (ev.origin !== undefined && ev.origin === ctx.sessionId) return "self";
  if (typeof ev.rev === "number" && ev.rev <= ctx.knownRevision) return "stale";
  return "refresh";
};

// ---------------------------------------------------------------
// Notice banner
// ---------------------------------------------------------------

// Deliberately not a modal and deliberately not a toast that fades:
// the user is mid-edit, so stealing focus is the wrong move, and a
// message that disappears on its own can't carry an action.
const NOTICE_EL = "live-notice";
const NOTICE_TEXT_EL = "live-notice-text";
const NOTICE_ACTION_EL = "live-notice-action";

let noticeShown: string | null = null;

const setNotice = (text: string | null): void => {
  if (noticeShown === text) return;
  noticeShown = text;
  if (typeof document === "undefined") return;
  const el = document.getElementById(NOTICE_EL);
  if (!el) return;
  if (text === null) {
    el.classList.add("hidden");
    return;
  }
  const label = document.getElementById(NOTICE_TEXT_EL);
  if (label) label.textContent = text;
  el.classList.remove("hidden");
};

/** Exposed for tests; the banner element is optional at runtime. */
export const currentNotice = (): string | null => noticeShown;

const attachNoticeAction = (): void => {
  if (typeof document === "undefined") return;
  const btn = document.getElementById(NOTICE_ACTION_EL);
  // The explicit escape hatch for the dirty case: reload and take the
  // server's document, discarding whatever is unsaved. Destructive, so
  // it is never automatic — the user asks for it by name.
  btn?.addEventListener("click", () => location.reload());
};

// ---------------------------------------------------------------
// Refresh pump
// ---------------------------------------------------------------

let refreshing = false;
let queued = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let deferredSince = 0;
let backoff = RETRY_MS;

const clearRetry = (): void => {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
};

const scheduleRetry = (ms: number): void => {
  clearRetry();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void pump();
  }, ms);
};

/**
 * Note that the server has something we don't and start (or re-arm)
 * the pull. Safe to call repeatedly — concurrent calls collapse into
 * one in-flight refresh plus one queued follow-up.
 */
export const requestRefresh = (): void => {
  queued = true;
  void pump();
};

const pump = async (): Promise<void> => {
  if (refreshing || !queued) return;
  refreshing = true;
  try {
    queued = false;
    const outcome = await must().refresh();
    switch (outcome) {
      case "applied":
      case "unchanged":
        deferredSince = 0;
        backoff = RETRY_MS;
        clearRetry();
        setNotice(null);
        if (outcome === "applied") must().setStatus("updated from disk");
        break;
      case "deferred":
        // Do NOT apply over unsaved work, and do NOT merge — but do
        // keep asking. Every mutation in this editor schedules a save,
        // so "dirty" is almost always a debounce window that closes on
        // its own; retrying means the change lands the moment it's
        // safe, with no action from the user at all.
        if (deferredSince === 0) deferredSince = Date.now();
        queued = true;
        if (Date.now() - deferredSince >= NOTICE_AFTER_MS) setNotice(DIRTY_NOTICE);
        scheduleRetry(RETRY_MS);
        break;
      case "failed":
        queued = true;
        scheduleRetry(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        break;
    }
  } finally {
    refreshing = false;
    // A request that arrived while we were awaiting still needs
    // servicing; the branches above already armed a timer for the
    // retrying outcomes, so only the idle case needs one here.
    if (queued && retryTimer === null) scheduleRetry(RETRY_MS);
  }
};

// ---------------------------------------------------------------
// Connection
// ---------------------------------------------------------------

let source: EventSource | null = null;
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

const clearOfflineTimer = (): void => {
  if (offlineTimer !== null) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
  }
};

const onFrame = (raw: string, isHello: boolean): void => {
  let ev: LiveEvent;
  try {
    ev = JSON.parse(raw) as LiveEvent;
  } catch {
    return;
  }
  const decision = decideLiveEvent(ev, {
    sessionId: SESSION_ID,
    knownRevision: must().knownRevision(),
  });
  if (decision === "refresh") {
    requestRefresh();
  } else if (isHello) {
    // Reconnected and already current — whatever gap we were warning
    // about is closed.
    setNotice(null);
  }
};

/**
 * Open the event stream. Call once, after the initial /state load, so
 * the hello event has a revision baseline to compare against.
 *
 * The hello event is the whole reconnect story: EventSource retries by
 * itself, and hello reports where the document stands right now, so a
 * page that was asleep (laptop lid, server restart, agent working
 * while the tab was disconnected) catches up on the next connect
 * rather than waiting for the agent's next write.
 */
export const startLive = (): void => {
  if (typeof EventSource === "undefined") return;
  if (source) return;
  attachNoticeAction();
  const es = new EventSource(
    "/events?session=" + encodeURIComponent(SESSION_ID),
  );
  source = es;
  es.addEventListener("hello", (e) => onFrame((e as MessageEvent).data, true));
  es.addEventListener("change", (e) => onFrame((e as MessageEvent).data, false));
  es.addEventListener("open", () => {
    clearOfflineTimer();
    if (currentNotice() === OFFLINE_NOTICE) setNotice(null);
  });
  es.addEventListener("error", () => {
    if (offlineTimer !== null) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (es.readyState !== EventSource.OPEN) setNotice(OFFLINE_NOTICE);
    }, OFFLINE_AFTER_MS);
  });
};

/** Tear down and forget all state. Tests only. */
export const resetLive = (): void => {
  source?.close();
  source = null;
  clearRetry();
  clearOfflineTimer();
  refreshing = false;
  queued = false;
  deferredSince = 0;
  backoff = RETRY_MS;
  noticeShown = null;
  bindings = null;
};
