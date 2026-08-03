// Cross-browser storage.local wrapper for the single on/off toggle.
// Modern Chrome (88+) and Firefox's `browser.*` API both return a
// Promise from storage.local.get/set when no callback is passed —
// this relies on that rather than juggling both callback- and
// Promise-based call conventions.

export const ENABLED_KEY = "flowgoRenderEnabled";

interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface OnChanged {
  addListener(cb: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void): void;
}

interface ExtensionGlobal {
  browser?: { storage?: { local?: StorageArea; onChanged?: OnChanged } };
  chrome?: { storage?: { local?: StorageArea; onChanged?: OnChanged } };
}

function getStorageArea(): StorageArea {
  const g = globalThis as unknown as ExtensionGlobal;
  const area = g.browser?.storage?.local ?? g.chrome?.storage?.local;
  if (!area) {
    throw new Error("flowgo: no storage.local API available (not running in an extension context)");
  }
  return area;
}

export async function isEnabled(): Promise<boolean> {
  const area = getStorageArea();
  const result = await area.get([ENABLED_KEY]);
  return result[ENABLED_KEY] !== false; // default: on
}

export async function setEnabled(enabled: boolean): Promise<void> {
  const area = getStorageArea();
  await area.set({ [ENABLED_KEY]: enabled });
}

// Fires cb(enabled) whenever the setting changes in another context
// (e.g. the popup toggling it while a content script is already
// running on an open tab).
export function onEnabledChanged(cb: (enabled: boolean) => void): void {
  const g = globalThis as unknown as ExtensionGlobal;
  const onChanged = g.browser?.storage?.onChanged ?? g.chrome?.storage?.onChanged;
  onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local" || !(ENABLED_KEY in changes)) return;
    cb(changes[ENABLED_KEY]?.newValue !== false);
  });
}
