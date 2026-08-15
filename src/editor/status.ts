// The editor's own status surface.
//
// WHY THIS FILE EXISTS (brain#2c1). main.ts used to carry
//
//     function setStatus(_s) { /* status area was removed */ }
//
// and index.html had no node to put anything in. Roughly forty call
// sites across the editor kept handing it text that no user ever saw.
// Mostly that was harmless chatter ("pasted 3 items", "redo"), but one
// of them was not: persistence.ts detects a rejected save, says
// `save failed (413) — recent changes are NOT saved; retrying`, and
// retries every 5 s. With the sink in place the browser and the server
// diverged in complete silence — no banner, no toast, no dirty marker.
// The unit test passed the whole time because it injects its own
// setStatus spy, so it proved the STRING was built, not that anybody
// could read it.
//
// DO NOT CONFUSE THIS WITH THE HOST SHELL'S PILL. flowgo-website's
// assets/wrapper.html has its own `#status` in the OUTER document. It
// covers the things the drawer does (share, import, new map) and it
// physically cannot see anything happening inside the iframe — the
// autosave included. This module is the inner document's surface and
// the two are independent by design.
//
// TWO TIERS, because the messages are two different kinds of thing:
//
//   info / ok   transient. "saved", "pasted 3 items", "12 selected".
//               A permanent pill repeating these would be noise, and
//               in an embed it would be clutter, so it fades and it
//               never renders in embed mode at all.
//
//   error       sticky. "recent changes are NOT saved" is an alarm
//               about divergence that lasts until the divergence is
//               over. It stays on screen until a call site says the
//               condition cleared, it is visually distinct (red, bold,
//               its own node), and it renders EVEN IN EMBED MODE: a
//               playground that silently drops the visitor's work is
//               the same bug in a smaller box.
//
// "ok" is "info that also resolves the alarm". It exists so that
// persistence.ts's success path (`setStatus("saved", "ok")`) dismisses
// a standing save-failure, while an UNRELATED info message — mouse.ts
// reporting "3 selected" on the next click — cannot. Wiring the clear
// to any-message-at-all was the obvious design and it is wrong: the
// user selects a box a second after the alarm appears and the alarm is
// gone while the save is still failing.
//
// The node is OPTIONAL at runtime. Downstream embedders ship their own
// HTML around these modules, and help.ts's `attachHelpListeners` —
// which throws on a missing `#helpOverlay` and runs early in main.ts's
// boot — is the cautionary tale: one absent element takes every later
// listener down with it and the user gets a blank canvas. Policy here
// follows toolbar.ts's: warn once, continue.

import { EMBED_MODE } from "./embed.ts";

export type StatusSeverity = "info" | "ok" | "error";

const INFO_EL = "status-info";
const ERROR_EL = "status-error";

// How long a transient message stays legible before it starts fading.
// Long enough to read a short phrase, short enough that it is gone
// before the user wonders whether it is stuck.
export const INFO_TTL_MS = 2600;
// Matches the opacity transition on #status-info in index.html. The
// text is only cleared once the fade has finished, so the pill never
// sits on screen visibly empty.
export const INFO_FADE_MS = 300;

let fadeTimer: ReturnType<typeof setTimeout> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let warned = false;

const node = (id: string): HTMLElement | null => {
  if (typeof document === "undefined") return null;
  const el = document.getElementById(id);
  if (!el && !warned) {
    warned = true;
    // Once, not per call: a status update happens on nearly every user
    // action and an embedder without the node should not get its
    // console filled.
    console.warn(
      `flowgo: #${id} missing from the document — status messages ` +
        `(including save failures) will not be shown`,
    );
  }
  return el;
};

const cancelTimers = (): void => {
  if (fadeTimer !== null) clearTimeout(fadeTimer);
  if (clearTimer !== null) clearTimeout(clearTimer);
  fadeTimer = null;
  clearTimer = null;
};

/**
 * Show a status message.
 *
 * The single-argument form is the one ~40 existing call sites already
 * use and it keeps meaning exactly what it did: transient chatter.
 * Only the paths that know they are reporting a durable problem — or
 * the end of one — pass a severity.
 */
export const setStatus = (s: string, severity: StatusSeverity = "info"): void => {
  if (severity === "error") {
    const el = node(ERROR_EL);
    if (!el) return;
    el.textContent = s;
    el.classList.remove("hidden");
    return;
  }

  // "ok" means the condition an error was reporting is over. Do this
  // before the embed bail-out below: an embed shows errors, so an
  // embed must be able to stop showing them.
  if (severity === "ok") {
    const err = node(ERROR_EL);
    if (err) {
      err.textContent = "";
      err.classList.add("hidden");
    }
  }

  // Routine chatter has no place in the landing-page playground or the
  // read-only gallery embeds. Errors escaped above; everything here is
  // suppressed rather than styled away, so an embed never even holds
  // the text.
  if (EMBED_MODE) return;

  const el = node(INFO_EL);
  if (!el) return;
  cancelTimers();
  el.textContent = s;
  el.classList.add("visible");
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    el.classList.remove("visible");
    clearTimer = setTimeout(() => {
      clearTimer = null;
      el.textContent = "";
    }, INFO_FADE_MS);
  }, INFO_TTL_MS);
};

/** Exposed for tests, which need the timers not to outlive a case. */
export const resetStatusForTests = (): void => {
  cancelTimers();
  warned = false;
};
