// Box-resize mode: the tiny bit of state behind "press E and grips
// appear". One box at a time can be in resize mode; the id lives here
// and everything else reads it:
//
//   - keys.ts toggles it on E (and clears on Escape),
//   - render.ts's applyClasses() projects it onto the DOM as the
//     `.resizing` class (which CSS uses to swap connection handles
//     for resize grips) and self-heals by dropping the mode when the
//     box is deselected or gone,
//   - attach.ts's grip handlers only ever fire while the class is on
//     (grips are display:none otherwise).
//
// Deliberately dependency-free so any editor module can import it
// without cycles.

let resizing: string | null = null;

// Toggle resize mode for a box: same id → off, different id → switch.
// Returns the new mode so callers can set a status message.
export const toggleBoxResize = (boxId: string): boolean => {
  resizing = resizing === boxId ? null : boxId;
  return resizing !== null;
};

export const clearBoxResize = (): void => {
  resizing = null;
};

export const resizingBoxId = (): string | null => resizing;
