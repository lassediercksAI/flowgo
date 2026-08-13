// Platform sniff tests. Two layers:
//   1. isApplePlatform — the pure predicate, testable directly.
//   2. IS_MAC / primaryMod — baked at module load from the navigator
//      global, so each case stubs navigator, resets the module
//      registry, and dynamically re-imports a fresh instance.
// Node ≥21 ships a real global navigator (platform "MacIntel" on this
// dev machine!), so tests must never read the host's value — every
// module-level assertion runs against an explicit stub.

import { afterEach, describe, expect, it, vi } from "vitest";
import { isApplePlatform } from "./platform.ts";

// Save the host descriptor once; restore after every test so the stub
// can never leak into other files or later tests.
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

const setNavigator = (value: unknown): void => {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
};

afterEach(() => {
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  } else {
    // Host had no navigator: remove ours entirely.
    delete (globalThis as { navigator?: unknown }).navigator;
  }
  vi.resetModules();
});

// Fresh module instance evaluated against whatever navigator stub is
// currently installed.
const freshPlatform = async (): Promise<typeof import("./platform.ts")> => {
  vi.resetModules();
  return import("./platform.ts");
};

describe("isApplePlatform (pure)", () => {
  it("recognises every Apple platform string", () => {
    // navigator.platform values seen in the wild.
    for (const p of ["MacIntel", "MacPPC", "Mac68K", "iPhone", "iPad", "iPod"]) {
      expect(isApplePlatform(p, "")).toBe(true);
    }
  });

  it("rejects non-Apple platforms", () => {
    for (const p of ["Win32", "Win64", "Linux x86_64", "Linux armv8l", "CrOS x86_64"]) {
      expect(isApplePlatform(p, "")).toBe(false);
    }
  });

  it("matches case-insensitively", () => {
    expect(isApplePlatform("MACINTEL", "")).toBe(true);
    expect(isApplePlatform("macintel", "")).toBe(true);
  });

  it("gives a non-empty platform precedence over the userAgent", () => {
    // A Windows box whose UA happens to mention Mac (UA strings lie;
    // platform is the more honest signal when present).
    expect(isApplePlatform("Win32", "pretending to be Macintosh")).toBe(false);
    expect(isApplePlatform("MacIntel", "Mozilla/5.0 (Windows NT 10.0)")).toBe(true);
  });

  it("falls back to the userAgent when platform is empty or missing", () => {
    expect(isApplePlatform("", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe(true);
    expect(isApplePlatform(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(true);
    expect(isApplePlatform("", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(false);
  });

  it("is false when both signals are empty or missing", () => {
    expect(isApplePlatform("", "")).toBe(false);
    expect(isApplePlatform(undefined, undefined)).toBe(false);
  });
});

describe("IS_MAC (module constant)", () => {
  it("is false when navigator does not exist (SSR / bare node)", async () => {
    setNavigator(undefined);
    const { IS_MAC } = await freshPlatform();
    expect(IS_MAC).toBe(false);
  });

  it("is true on a Mac navigator", async () => {
    setNavigator({ platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" });
    const { IS_MAC } = await freshPlatform();
    expect(IS_MAC).toBe(true);
  });

  it("is false on a Windows navigator", async () => {
    setNavigator({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" });
    const { IS_MAC } = await freshPlatform();
    expect(IS_MAC).toBe(false);
  });

  it("uses the userAgent fallback when platform is empty (iPadOS quirk)", async () => {
    setNavigator({
      platform: "",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
    });
    const { IS_MAC } = await freshPlatform();
    expect(IS_MAC).toBe(true);
  });
});

describe("primaryMod", () => {
  it("is Cmd (metaKey) on Mac — Ctrl+click is the secondary-click gesture", async () => {
    setNavigator({ platform: "MacIntel", userAgent: "" });
    const { primaryMod } = await freshPlatform();
    expect(primaryMod({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(primaryMod({ metaKey: false, ctrlKey: true })).toBe(false);
    expect(primaryMod({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("is Ctrl everywhere else", async () => {
    setNavigator({ platform: "Win32", userAgent: "" });
    const { primaryMod } = await freshPlatform();
    expect(primaryMod({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(primaryMod({ metaKey: true, ctrlKey: false })).toBe(false);
  });
});
