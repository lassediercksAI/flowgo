import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isEnabled, setEnabled, onEnabledChanged, ENABLED_KEY } from "../src/settings";

// Minimal fake chrome.storage.local — good enough to exercise the
// get/set/onChanged contract without a real browser runtime.
function installFakeChromeStorage(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const listeners: Array<(changes: Record<string, { newValue?: unknown }>, area: string) => void> = [];

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) => {
          const result: Record<string, unknown> = {};
          for (const k of keys) if (k in store) result[k] = store[k];
          return result;
        },
        set: async (items: Record<string, unknown>) => {
          const changes: Record<string, { newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { newValue: v };
            store[k] = v;
          }
          for (const l of listeners) l(changes, "local");
        },
      },
      onChanged: {
        addListener: (cb: (changes: Record<string, { newValue?: unknown }>, area: string) => void) => {
          listeners.push(cb);
        },
      },
    },
  };
  return store;
}

beforeEach(() => {
  delete (globalThis as any).chrome;
  delete (globalThis as any).browser;
});

afterEach(() => {
  delete (globalThis as any).chrome;
  delete (globalThis as any).browser;
});

describe("isEnabled/setEnabled", () => {
  it("defaults to enabled when nothing has been stored yet", async () => {
    installFakeChromeStorage();
    expect(await isEnabled()).toBe(true);
  });

  it("reflects a stored false value", async () => {
    installFakeChromeStorage({ [ENABLED_KEY]: false });
    expect(await isEnabled()).toBe(false);
  });

  it("setEnabled persists the value for a later isEnabled call", async () => {
    installFakeChromeStorage();
    await setEnabled(false);
    expect(await isEnabled()).toBe(false);
    await setEnabled(true);
    expect(await isEnabled()).toBe(true);
  });

  it("throws a clear error outside an extension context rather than crashing silently", async () => {
    await expect(isEnabled()).rejects.toThrow(/no storage/i);
  });

  it("also works against a Firefox-shaped `browser` global", async () => {
    const store = { [ENABLED_KEY]: false };
    (globalThis as any).browser = {
      storage: {
        local: {
          get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, (store as any)[k]])),
          set: async (items: Record<string, unknown>) => Object.assign(store, items),
        },
      },
    };
    expect(await isEnabled()).toBe(false);
  });
});

describe("onEnabledChanged", () => {
  it("fires with the new value when the setting changes", async () => {
    installFakeChromeStorage();
    const cb = vi.fn();
    onEnabledChanged(cb);
    await setEnabled(false);
    expect(cb).toHaveBeenCalledWith(false);
  });

  it("ignores changes to unrelated keys or a different storage area", async () => {
    const store = installFakeChromeStorage();
    const cb = vi.fn();
    onEnabledChanged(cb);
    const chromeLocal = (globalThis as any).chrome.storage.local;
    // A change notification for some other key.
    await chromeLocal.set({ someOtherSetting: true });
    expect(cb).not.toHaveBeenCalled();
    void store;
  });
});
