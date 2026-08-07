// Collaboration extension point.
//
// Downstream consumers (e.g. a Yjs collab plugin in a cloud product)
// import `whenCollabReady` from "@flowgo/editor/collab" and pass a
// callback that receives a typed `CollabHandle`. The handle exposes
// the minimum surface needed to mirror the editor's in-memory graph
// into an external store:
//
//   1. snapshot()          — read the current graph as a plain object.
//   2. applyRemotePatch(fn) — mutate the live graph + trigger a render
//                            without losing focus or selection.
//   3. onLocalMutation(cb)  — subscribe to local mutation events so the
//                            plugin can diff and push to its own store.
//
// This module ships in every editor bundle but has zero runtime cost
// until something calls whenCollabReady — no Yjs dep, no subscription
// list traversal, no behaviour change for single-user / CLI users.
//
// Bootstrap order:
//
//   The editor's main.ts calls `exposeCollabHandle(...)` at the end
//   of its bootstrap, AFTER every wireX() registration has run. A
//   plugin that loaded earlier (its whenCollabReady callback queued)
//   gets invoked at that moment; a plugin that loads later sees the
//   handle immediately.
//
// All types here mirror the on-disk pkg/graph.Graph shape verbatim
// so the cloud plugin can pass snapshots to a Rust/Go sidecar via
// JSON without translation.

import type { MutationEvent } from "./mutations.ts";

// ---------------------------------------------------------------
// Graph shape (mirror of pkg/graph.Graph).
// ---------------------------------------------------------------

export interface FlowgoBox {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
  anchor?: boolean;
  // Explicit on-canvas size in data px (both set = user resized the
  // box). Omitted/0 = auto-size. Mirrors pkg/graph.Box.W/H.
  w?: number;
  h?: number;
  // Render silhouette: 0/unset rectangle, 1 hexagon, 2 circle,
  // 3 triangle. Mirrors pkg/graph.Box.Shape.
  shape?: number;
}

export interface FlowgoImage {
  id: string;
  // Path relative to the .flowgo file (mirrors pkg/graph.Image.Src).
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FlowgoEdge {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
  palette?: number;
  /** Relationship text drawn at the edge midpoint (brain#266).
   *  Mirrors pkg/graph.Edge.Label. */
  label?: string;
}

export interface FlowgoText {
  id: string;
  label: string;
  x: number;
  y: number;
  palette?: number;
  font?: number;
}

export interface FlowgoLine {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  palette?: number;
  style?: number;
  mids?: number[][];
}

export interface FlowgoStroke {
  id: string;
  points: number[][];
  palette?: number;
}

export interface FlowgoMap {
  path: string;
  boxes: FlowgoBox[];
  edges: FlowgoEdge[];
  texts?: FlowgoText[];
  lines?: FlowgoLine[];
  strokes?: FlowgoStroke[];
  images?: FlowgoImage[];
}

export interface FlowgoGraph {
  version?: string;
  maps: FlowgoMap[];
  // Document-level default shape for new boxes: 1 hexagon, 2 circle,
  // 3 triangle; 0/unset rectangle. Mirrors pkg/graph.Graph.DefaultShape
  // (replaced the old per-browser hexagon toggle — see #208).
  defaultShape?: number;
}

// ---------------------------------------------------------------
// Plugin handle.
// ---------------------------------------------------------------

export interface CollabHandle {
  /** Read-only snapshot of the current in-memory graph. The returned
   *  object is a structured clone — mutating it does NOT mutate the
   *  editor. Use applyRemotePatch() to write. */
  snapshot(): FlowgoGraph;

  /** Mutate the live graph and trigger a re-render. The callback
   *  receives a mutable reference to the graph; mutations propagate
   *  to the next render frame. Selection and focus are preserved. */
  applyRemotePatch(fn: (g: FlowgoGraph) => void): void;

  /** Subscribe to local mutation events. Returns an unsubscribe
   *  function. The plugin is expected to diff its own store against
   *  snapshot() inside the callback and forward deltas. */
  onLocalMutation(cb: (e: MutationEvent) => void): () => void;
}

// ---------------------------------------------------------------
// Bootstrap-order plumbing.
// ---------------------------------------------------------------

let handle: CollabHandle | null = null;
const awaiting: Array<(h: CollabHandle) => void> = [];

/** Plugin entry point: register a callback that fires as soon as the
 *  editor is ready to be wired. Safe to call before OR after the
 *  editor's main.ts has run. */
export const whenCollabReady = (cb: (h: CollabHandle) => void): void => {
  if (handle) {
    cb(handle);
    return;
  }
  awaiting.push(cb);
};

/** Editor entry point: install the handle. Called once by main.ts at
 *  the end of bootstrap. Calling twice replaces the handle (last one
 *  wins) and re-fires any waiting plugins against the new handle. */
export const exposeCollabHandle = (h: CollabHandle): void => {
  handle = h;
  const pending = awaiting.splice(0);
  for (const cb of pending) cb(h);
};
