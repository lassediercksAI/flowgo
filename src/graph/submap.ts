// Submap path utilities. A box at id `X` on map `/` owns the submap
// `/X`; if that submap (or any deeper descendant) carries content, the
// box is rendered with a "has-submap" affordance. These helpers run
// against a plain graph object and don't touch the DOM.

export interface MapLike {
  readonly path: string;
  readonly boxes?: ReadonlyArray<unknown>;
  readonly edges?: ReadonlyArray<unknown>;
  readonly texts?: ReadonlyArray<unknown>;
  readonly lines?: ReadonlyArray<unknown>;
  readonly strokes?: ReadonlyArray<unknown>;
}

export interface GraphLike {
  readonly version?: string;
  readonly maps?: ReadonlyArray<MapLike>;
}

// The submap path that hangs off `boxId` when viewing `currentPath`.
// Root maps to `/<id>`; nested paths get `/<id>` appended.
export const submapPathFor = (currentPath: string, boxId: string): string =>
  currentPath === "/" ? `/${boxId}` : `${currentPath}/${boxId}`;

const mapHasContent = (m: MapLike): boolean =>
  (m.boxes?.length ?? 0) > 0 ||
  (m.edges?.length ?? 0) > 0 ||
  (m.texts?.length ?? 0) > 0 ||
  (m.lines?.length ?? 0) > 0 ||
  (m.strokes?.length ?? 0) > 0;

// True when the submap rooted at `currentPath/boxId`, OR any deeper
// descendant of it, holds at least one item. Catches the case where
// the immediate submap is empty but one of its grandchildren has
// content — the top-level box should still flag as "has-submap".
export const hasSubmapContent = (
  graph: GraphLike,
  currentPath: string,
  boxId: string,
): boolean => {
  const root = submapPathFor(currentPath, boxId);
  const prefix = root + "/";
  for (const m of graph.maps ?? []) {
    if (m.path !== root && !m.path.startsWith(prefix)) continue;
    if (mapHasContent(m)) return true;
  }
  return false;
};
