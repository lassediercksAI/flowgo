// Delta save protocol v1 (brain#25c) — the server half.
//
// A full /save decodes the ENTIRE document out of the request body —
// measured 85ms of a 152ms save at 100k boxes — to persist what is
// typically a one-box change. A delta body carries only the changed
// elements, so the O(document) JSON decode disappears from the save
// path. What deliberately stays O(document) is the write itself:
// whole-file serialize + fsync + atomic rename (47ms floor at 100k)
// is the accepted price of crash-safety and hand-editability, so the
// on-disk model does not change here at all.
//
// The contract that keeps a delta indistinguishable from a full save:
//
//   - Byte parity. Ops are applied to the parsed in-memory document
//     and the result goes through the SAME validate + serialize +
//     atomic-write path SaveLocalGraphFrom runs. There is exactly one
//     serializer; the delta path adds no second way to write bytes,
//     so the file a delta produces is byte-identical to a full save
//     of the equivalent end-state document.
//
//   - Revision guard. A delta only makes sense against the document
//     the client last saw. The base revision is checked under the
//     file mutex, immediately before apply, so a full save or MCP
//     write that slipped in between forces a 409 — and the client's
//     answer to 409 is a full save, which cannot conflict. The same
//     409 (never 400/500) covers "no parsed document to apply
//     against": whatever broke the cached parse, a full save fixes
//     it by replacing the file wholesale, so 409 steers the client
//     to exactly the request that will succeed.
//
//   - Atomicity. Ops apply in order to a deep COPY of the cached
//     graph; the copy is validated and persisted only when every op
//     applied cleanly. A delta that fails at op N leaves the cache,
//     the file, and the revision exactly as they were — the client
//     retries with a full save and loses nothing.
package flowgo

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// SaveModeHeader / SaveModeDelta1 are the protocol surface of the
// delta capability. /state advertises SaveModeDelta1 in a
// SaveModeHeader response header (next to X-Flowgo-Accept-Encoding —
// same shared-bundle reasoning: the editor must never send a delta to
// a server that didn't announce it). A /save request carrying
// `X-Flowgo-Save: delta1` has a Delta body; a /save without the
// header is a full document, exactly as before.
const (
	SaveModeHeader = "X-Flowgo-Save"
	SaveModeDelta1 = "delta1"
)

// ErrDeltaConflict maps to HTTP 409: the delta's base revision is not
// the document's current revision, or there is no parsed document to
// apply against. Both mean the same thing to the client — fall back
// to a full save.
var ErrDeltaConflict = errors.New("delta base conflicts with the current document")

// ErrDeltaInvalid maps to HTTP 400: the delta itself is malformed
// (unknown op, unknown kind, missing/undecodable payload field). The
// client treats any non-2xx as fall-back-to-full, but 400 tells it —
// and anyone reading logs — that retrying the same delta is useless.
var ErrDeltaInvalid = errors.New("invalid delta")

// Delta is the `X-Flowgo-Save: delta1` request body:
//
//	{"base": <revision>, "ops": [...], "doc": {"defaultShape": 1}?}
type Delta struct {
	// Base is the revision (X-Flowgo-Revision) the client applied its
	// local edits on top of. Guarded against Revision() at apply time.
	Base uint64    `json:"base"`
	Ops  []DeltaOp `json:"ops"`
	// Doc carries document-level fields. A pointer per field
	// distinguishes "not mentioned" from "set to the zero value"
	// (defaultShape 0 = rectangle is a real setting).
	Doc *DeltaDoc `json:"doc,omitempty"`
}

// DeltaDoc is the document-level part of a delta.
type DeltaDoc struct {
	DefaultShape *int `json:"defaultShape,omitempty"`
}

// DeltaOp is one operation. Which fields matter depends on Op; the
// payload fields stay raw JSON so each op decodes exactly the type it
// needs (the item schema is pkg/graph's element types, verbatim).
type DeltaOp struct {
	// Op is one of: upsert, delete, set-kind, set-edges, set-map,
	// drop-map.
	Op string `json:"op"`
	// Kind selects the element collection for upsert / delete /
	// set-kind: box, text, line, stroke, image. (Edges have no ids,
	// so they get their own whole-array op instead.)
	Kind string `json:"kind,omitempty"`
	// Map is the target map path. Required by every op.
	Map string `json:"map,omitempty"`
	// ID is the element to remove (delete only).
	ID string `json:"id,omitempty"`
	// Item is one full element (upsert), carrying its own id.
	Item json.RawMessage `json:"item,omitempty"`
	// Items is the full replacement collection (set-kind).
	Items json.RawMessage `json:"items,omitempty"`
	// Edges is the full replacement edge array (set-edges).
	Edges json.RawMessage `json:"edges,omitempty"`
}

// ApplyLocalDelta is ApplyLocalDeltaFrom with an anonymous writer.
func ApplyLocalDelta(d Delta) (uint64, error) {
	return ApplyLocalDeltaFrom(d, "")
}

// ApplyLocalDeltaFrom applies a delta1 payload to the local document
// and persists the result through the full-save write path. origin is
// the writer's identity for live-event echo suppression, exactly as
// in SaveLocalGraphFrom. On success it returns the revision the write
// produced (unchanged when the delta was a byte-level no-op — e.g.
// only deletes of already-missing ids — because the persist layer
// skips identical bytes and byte-identical content is nothing to
// notify subscribers about).
//
// Errors: ErrDeltaConflict → 409, ErrDeltaInvalid / ErrInvalidGraph →
// 400, anything else is a disk failure → 500.
func ApplyLocalDeltaFrom(d Delta, origin string) (uint64, error) {
	cfg.LocalFileMu.Lock()
	defer cfg.LocalFileMu.Unlock()
	// The guard runs under the file mutex, so "base == current" here
	// means no other writer can land between the check and our
	// persist — the revision cannot move until we release the lock.
	if cur := Revision(); d.Base != cur {
		return 0, fmt.Errorf("%w: delta base %d, document at revision %d", ErrDeltaConflict, d.Base, cur)
	}
	g, err := localGraphLocked()
	if err != nil {
		// Missing file, unreadable file, unparseable file: a delta has
		// nothing to apply against, but a full save would succeed by
		// replacing the file wholesale — so this is a 409 (retry as
		// full save), never a 400/500 the client would give up on.
		return 0, fmt.Errorf("%w: no document to apply against: %v", ErrDeltaConflict, err)
	}
	// Atomicity: ops mutate a deep copy. An op failing halfway leaves
	// the cached graph — and therefore disk — untouched, so a 400 is
	// always safe to answer with "nothing happened".
	work := cloneGraph(*g)
	if err := ApplyDeltaOps(&work, d); err != nil {
		return 0, err
	}
	// From here down this is the full-save path, step for step:
	// ValidateWritable gate (same reasons as SaveLocalGraphFrom — the
	// items came off the network, and one unwritable id would brick
	// the file for every later read), version stamp, one serializer,
	// atomic write.
	if errs := validateWritable(work); len(errs) > 0 {
		msgs := make([]string, len(errs))
		for i, e := range errs {
			msgs[i] = e.Error()
		}
		return 0, fmt.Errorf("%w: %s", ErrInvalidGraph, strings.Join(msgs, "; "))
	}
	work.Version = cfg.Version()
	if err := persistLocalBytesLocked([]byte(serialize(work)), origin); err != nil {
		return 0, err
	}
	// Keep the applied copy as the cached parse. SaveLocalGraphFrom
	// drops the cache because its payload is a whole document straight
	// off the network; this copy is a parsed graph plus structured
	// mutations — the same category as an MCP mutation, which the
	// cache contract in localfile.go already admits. Dropping it here
	// would put an O(document) re-parse back in front of the NEXT
	// delta, which is the cost this protocol exists to remove.
	localFile.hasGraph = true
	localFile.graph = work
	return Revision(), nil
}

// deltaKinds is the closed set of id-carrying element collections.
// Guarded up front so an unknown kind is a 400 even on ops that would
// otherwise no-op (delete on a missing map must still reject "kine":
// the client is confused, and silently swallowing that hides it).
func deltaKindKnown(kind string) bool {
	switch kind {
	case "box", "text", "line", "stroke", "image":
		return true
	}
	return false
}

// ApplyDeltaOps applies a delta's ops and doc-level fields to g in
// place, with no revision guard and no persistence — the pure half of
// ApplyLocalDeltaFrom, exported for hosts with their own storage (the
// website applies deltas against Postgres-stored graphs and must
// share these exact op semantics, not re-implement them). The caller
// owns atomicity: hand in a copy if a failed op must leave the
// original untouched.
func ApplyDeltaOps(g *Graph, d Delta) error {
	for i := range d.Ops {
		if err := applyDeltaOp(g, d.Ops[i]); err != nil {
			return fmt.Errorf("%w: ops[%d]: %v", ErrDeltaInvalid, i, err)
		}
	}
	if d.Doc != nil && d.Doc.DefaultShape != nil {
		g.DefaultShape = *d.Doc.DefaultShape
	}
	return nil
}

func applyDeltaOp(g *Graph, op DeltaOp) error {
	if op.Op != "" && op.Map == "" {
		return fmt.Errorf("op %q needs a map path", op.Op)
	}
	switch op.Op {
	case "upsert":
		if !deltaKindKnown(op.Kind) {
			return fmt.Errorf("unknown kind %q", op.Kind)
		}
		if len(op.Item) == 0 {
			return errors.New("upsert needs an item")
		}
		// Upsert implicitly materialises the map, mirroring the MCP
		// add_* contract — the editor may drop an element onto a
		// submap it just navigated into.
		return upsertInto(ensureMapAt(g, op.Map), op.Kind, op.Item)
	case "delete":
		if !deltaKindKnown(op.Kind) {
			return fmt.Errorf("unknown kind %q", op.Kind)
		}
		m := findMapAt(g, op.Map)
		if m == nil {
			// LWW tolerance: deleting from a map that is already gone
			// is as deleted as it gets. Same rule as a missing id.
			return nil
		}
		deleteFrom(m, op.Kind, op.ID)
		return nil
	case "set-kind":
		if !deltaKindKnown(op.Kind) {
			return fmt.Errorf("unknown kind %q", op.Kind)
		}
		if op.Items == nil {
			return errors.New("set-kind needs items")
		}
		return setKindOn(ensureMapAt(g, op.Map), op.Kind, op.Items)
	case "set-edges":
		if op.Edges == nil {
			return errors.New("set-edges needs edges")
		}
		var edges []Edge
		if err := json.Unmarshal(op.Edges, &edges); err != nil {
			return fmt.Errorf("bad edges: %v", err)
		}
		ensureMapAt(g, op.Map).Edges = edges
		return nil
	case "set-map":
		// Ensure-exists; an empty map serializes to nothing, so this
		// only changes bytes once something lands on the map.
		ensureMapAt(g, op.Map)
		return nil
	case "drop-map":
		dropMapAndSubtree(g, op.Map)
		return nil
	default:
		return fmt.Errorf("unknown op %q", op.Op)
	}
}

// dropMapAndSubtree removes the map at path and every map beneath it.
// The "/" boundary is the editor's withoutSubmaps rule
// (src/editor/factories.ts), ported exactly: a descendant is a path
// with the prefix path+"/", so dropping "/a" takes "/a/b" but must
// leave "/ab" alone — a bare prefix test would eat the sibling.
func dropMapAndSubtree(g *Graph, path string) {
	kept := g.Maps[:0]
	for _, m := range g.Maps {
		if m.Path == path || strings.HasPrefix(m.Path, path+"/") {
			continue
		}
		kept = append(kept, m)
	}
	g.Maps = kept
}

// upsertInto decodes item as the kind's element type and replaces the
// element with the same id, or appends when no such element exists.
func upsertInto(m *NamedMap, kind string, item json.RawMessage) error {
	decode := func(v any) error {
		if err := json.Unmarshal(item, v); err != nil {
			return fmt.Errorf("bad %s item: %v", kind, err)
		}
		return nil
	}
	switch kind {
	case "box":
		var v Box
		if err := decode(&v); err != nil {
			return err
		}
		m.Boxes = upsertByID(m.Boxes, func(b Box) string { return b.ID }, v)
	case "text":
		var v Text
		if err := decode(&v); err != nil {
			return err
		}
		m.Texts = upsertByID(m.Texts, func(t Text) string { return t.ID }, v)
	case "line":
		var v Line
		if err := decode(&v); err != nil {
			return err
		}
		m.Lines = upsertByID(m.Lines, func(l Line) string { return l.ID }, v)
	case "stroke":
		var v Stroke
		if err := decode(&v); err != nil {
			return err
		}
		m.Strokes = upsertByID(m.Strokes, func(s Stroke) string { return s.ID }, v)
	case "image":
		var v Image
		if err := decode(&v); err != nil {
			return err
		}
		m.Images = upsertByID(m.Images, func(i Image) string { return i.ID }, v)
	}
	return nil
}

// deleteFrom removes the element with the given id from the kind's
// collection. A missing id is a no-op by design (LWW tolerance): two
// clients deleting the same element must both get a 2xx, not a
// failure on whoever arrives second.
func deleteFrom(m *NamedMap, kind, id string) {
	switch kind {
	case "box":
		m.Boxes = deleteByID(m.Boxes, func(b Box) string { return b.ID }, id)
	case "text":
		m.Texts = deleteByID(m.Texts, func(t Text) string { return t.ID }, id)
	case "line":
		m.Lines = deleteByID(m.Lines, func(l Line) string { return l.ID }, id)
	case "stroke":
		m.Strokes = deleteByID(m.Strokes, func(s Stroke) string { return s.ID }, id)
	case "image":
		m.Images = deleteByID(m.Images, func(i Image) string { return i.ID }, id)
	}
}

// setKindOn replaces the map's whole collection of one kind — the
// bulk fallback for edits with no cheaper delta expression (multi-
// select drag, reorder).
func setKindOn(m *NamedMap, kind string, items json.RawMessage) error {
	decode := func(v any) error {
		if err := json.Unmarshal(items, v); err != nil {
			return fmt.Errorf("bad %s items: %v", kind, err)
		}
		return nil
	}
	switch kind {
	case "box":
		var v []Box
		if err := decode(&v); err != nil {
			return err
		}
		m.Boxes = v
	case "text":
		var v []Text
		if err := decode(&v); err != nil {
			return err
		}
		m.Texts = v
	case "line":
		var v []Line
		if err := decode(&v); err != nil {
			return err
		}
		m.Lines = v
	case "stroke":
		var v []Stroke
		if err := decode(&v); err != nil {
			return err
		}
		m.Strokes = v
	case "image":
		var v []Image
		if err := decode(&v); err != nil {
			return err
		}
		m.Images = v
	}
	return nil
}

// upsertByID replaces the element whose id matches item's, else
// appends. Replace-in-place preserves the element's position, which
// is part of byte parity: a moved box must serialize on the same line
// it always did.
func upsertByID[T any](s []T, id func(T) string, item T) []T {
	want := id(item)
	for i := range s {
		if id(s[i]) == want {
			s[i] = item
			return s
		}
	}
	return append(s, item)
}

// deleteByID removes the first element with the given id; absent ids
// leave the slice untouched.
func deleteByID[T any](s []T, id func(T) string, want string) []T {
	for i := range s {
		if id(s[i]) == want {
			return append(s[:i], s[i+1:]...)
		}
	}
	return s
}
