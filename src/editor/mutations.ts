// Chokepoint for "the live graph just mutated; persist." Every
// mutation seam in the editor calls one of the typed mutator
// functions below instead of scheduleSave() directly.
//
// Two hooks fan out from each mutator:
//
//   scheduleSave  — required. Today this funnels into the editor's
//                   own debounced save path so file persistence (CLI
//                   mode) or in-memory session save (serve mode)
//                   happens automatically.
//   onMutate      — optional. Fires alongside scheduleSave with a
//                   typed event so a downstream binding (e.g. a Yjs
//                   collab plugin) can scope its diff to the right
//                   kind of change without a 30-site audit.

import { invalidateProximityIndex } from "./proximity-index.ts";
import { invalidateUidCache } from "./uid.ts";

export type MutationKind =
  | "box"
  | "edge"
  | "text"
  | "line"
  | "stroke"
  | "image"
  | "currentMap"
  | "doc";

export interface MutationEvent {
  readonly kind: MutationKind;
  readonly mapPath: string;
}

interface MutationBindings {
  readonly scheduleSave: () => void;
  /** Optional. Returns the editor's currently-focused map path
   *  (e.g. "/", "/b1", "/b1/c2"). Defaults to "/" if not provided. */
  readonly getMapPath?: () => string;
  /** Optional. Called after scheduleSave for every mutation. */
  readonly onMutate?: (e: MutationEvent) => void;
}

let bindings: MutationBindings | null = null;

export const wireMutations = (b: MutationBindings): void => {
  bindings = b;
};

const fire = (kind: MutationKind): void => {
  if (!bindings) throw new Error("mutations: wireMutations() not called");
  // Positions/sizes may have changed, so cached box rects in the
  // proximity index are suspect. This chokepoint is what covers the
  // one geometry change that does NOT go through renderAll: a box
  // drag mutates b.x/b.y live and only fires mutatedCurrentMap() on
  // release. Invalidation is a flag-set; the rebuild is lazy, so
  // over-invalidating (edge/text/stroke mutations) costs nothing
  // until the next proximity query.
  invalidateProximityIndex();
  // Items may have been added or (crucially) deleted, so ids below the
  // memoized mint cursor can have become free again — the id cache
  // must not outlive a mutation (#24f).
  invalidateUidCache();
  bindings.scheduleSave();
  if (bindings.onMutate) {
    const mapPath = bindings.getMapPath ? bindings.getMapPath() : "/";
    bindings.onMutate({ kind, mapPath });
  }
};

// One function per kind on the current map. The function shapes
// reserve room for downstream wiring that wants to scope a diff to
// a specific entity; today they all just fire scheduleSave + onMutate.

export const mutatedBox = (): void => fire("box");
export const mutatedEdge = (): void => fire("edge");
export const mutatedText = (): void => fire("text");
export const mutatedLine = (): void => fire("line");
export const mutatedStroke = (): void => fire("stroke");
export const mutatedImage = (): void => fire("image");

// The current map changed in a way that spans multiple kinds or
// touches the whole map (paste, align, multi-select palette change).
export const mutatedCurrentMap = (): void => fire("currentMap");

// The document structure changed (maps added/removed via box
// deletion, or anything that affects more than one map at once).
export const mutatedDoc = (): void => fire("doc");
