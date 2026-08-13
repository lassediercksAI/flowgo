// Platform detection: macOS reserves Ctrl+click for the secondary
// click gesture, so the "primary" modifier for navigation-style
// shortcuts is Cmd on Mac and Ctrl everywhere else. Keyboard shortcuts
// (Cmd+Z, Cmd+A, …) accept either modifier and don't need this helper;
// only the mouse path does.

// Pure sniff behind IS_MAC, exported for tests. `platform` wins when
// non-empty ("MacIntel", "iPhone", "Win32", …); the userAgent string
// is only a fallback for environments that leave platform blank.
export const isApplePlatform = (
  platform: string | undefined,
  userAgent: string | undefined,
): boolean => /Mac|iPhone|iPad|iPod/i.test(platform || userAgent || "");

export const IS_MAC: boolean =
  typeof navigator !== "undefined" &&
  isApplePlatform(navigator.platform, navigator.userAgent);

export const primaryMod = (e: { metaKey: boolean; ctrlKey: boolean }): boolean =>
  IS_MAC ? e.metaKey : e.ctrlKey;
