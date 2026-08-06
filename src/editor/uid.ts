// Id minting for the editor, memoized per user action.
//
// The naive form — collectIds() over every layer, then probe
// `prefix1, prefix2, …` from 1 — is O(map) TWICE per minted id. That
// is invisible when a double-click mints one box and brutal when a
// bulk path mints hundreds: a 192-item paste on a 3,400-box map spent
// ~55ms of its ~84ms here, more than the whole render (brain#24f).
//
// So the used-id set and a per-prefix probe cursor are cached for as
// long as they are provably still valid:
//
//   • the cursor is only ever advanced, and every id it hands out is
//     added to the cached set — so a burst of mints inside ONE action
//     costs O(mints), not O(mints × map);
//   • the cache is dropped whenever an id could have been FREED or
//     added behind our back. mutations.ts's fire() — the chokepoint
//     every mutation seam already funnels through, the same hook the
//     proximity index uses (#236) — does that, and the current-map
//     identity check below catches the paths that swap the state slice
//     wholesale (map switch, load, undo/redo).
//
// Anything that adds or removes items WITHOUT going through
// mutations.ts must call invalidateUidCache() itself (collab's
// applyRemotePatch does).

import { collectIds, nextUid } from "../graph/id.ts";

interface MapLike {
  boxes: ReadonlyArray<{ readonly id: string }>;
  texts?: ReadonlyArray<{ readonly id: string }>;
  lines?: ReadonlyArray<{ readonly id: string }>;
  strokes?: ReadonlyArray<{ readonly id: string }>;
  images?: ReadonlyArray<{ readonly id: string }>;
}

interface UidBindings {
  readonly currentMap: () => MapLike;
}

interface UidCache {
  readonly map: MapLike;
  readonly used: Set<string>;
  readonly cursor: Map<string, number>;
}

let bindings: UidBindings | null = null;
let cache: UidCache | null = null;

export const wireUid = (b: UidBindings): void => {
  bindings = b;
  cache = null;
};

export const invalidateUidCache = (): void => {
  cache = null;
};

export const mintId = (prefix?: string): string => {
  if (!bindings) throw new Error("uid: wireUid() not called");
  const p = prefix || "b";
  const map = bindings.currentMap();
  if (!cache || cache.map !== map) {
    cache = {
      map,
      used: collectIds(
        map.boxes,
        map.texts ?? [],
        map.lines ?? [],
        map.strokes ?? [],
        map.images ?? [],
      ),
      cursor: new Map(),
    };
  }
  const id = nextUid(p, cache.used, cache.cursor.get(p) ?? 1);
  // Reserve it: the caller pushes the item into the map afterwards, so
  // until then only this set knows the id is taken.
  cache.used.add(id);
  cache.cursor.set(p, Number(id.slice(p.length)) + 1);
  return id;
};
