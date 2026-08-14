package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"

	"github.com/lassediercks/flowgo/pkg/flowgo"
	"github.com/lassediercks/flowgo/pkg/graph"
)

// Delta save protocol v1 (brain#25c), server half. The tests here are
// the protocol's contract:
//
//   - Byte parity (non-negotiable): a delta applied to state A writes
//     the SAME bytes a full save of the equivalent end-state document
//     writes. Both fixtures go through the real handlers.
//   - Revision guard: stale base → 409, file untouched.
//   - Atomicity: a delta failing at op N → 400, file and served
//     state untouched.
//   - The full-save path (no X-Flowgo-Save header) is byte-for-byte
//     unchanged.
//   - Gzip composes with the delta body.

// deltaBaseGraph is the shared starting document. It exercises every
// element kind's neighborhood and includes the map paths the drop-map
// "/" boundary rule is about: "/a" has a subtree ("/a/x") and a
// sibling whose path shares its prefix ("/ab").
func deltaBaseGraph() graph.Graph {
	return graph.Graph{
		Version: "dev",
		Maps: []graph.NamedMap{
			{
				Path: "/",
				Boxes: []graph.Box{
					{ID: "a", Label: "alpha"},
					{ID: "b", Label: "beta", X: 100, Y: 50},
				},
				Edges: []graph.Edge{{From: "a", To: "b"}},
			},
			{Path: "/a", Boxes: []graph.Box{{ID: "a1", Label: "child", X: 10, Y: 10}}},
			{Path: "/a/x", Boxes: []graph.Box{{ID: "ax1", Label: "grand"}}},
			{Path: "/ab", Boxes: []graph.Box{{ID: "ab1", Label: "sibling"}}},
		},
	}
}

func deltaSeed() string { return graph.Serialize(deltaBaseGraph()) }

// stateRevision GETs /state and returns the revision it advertises —
// the value a real client would base its next delta on. The revision
// counter is process-global (it survives serveTempMap reconfiguring
// the file), so tests must read it, never assume it.
func stateRevision(t *testing.T) uint64 {
	t.Helper()
	rec := httptest.NewRecorder()
	handleState(rec, httptest.NewRequest(http.MethodGet, "/state", nil))
	if rec.Code != 200 {
		t.Fatalf("/state status = %d, body = %s", rec.Code, rec.Body.String())
	}
	rev, err := strconv.ParseUint(rec.Header().Get(revisionHeader), 10, 64)
	if err != nil {
		t.Fatalf("/state %s header: %v", revisionHeader, err)
	}
	return rev
}

func deltaBody(base uint64, ops []map[string]any, doc map[string]any) []byte {
	payload := map[string]any{"base": base, "ops": ops}
	if doc != nil {
		payload["doc"] = doc
	}
	body, err := json.Marshal(payload)
	if err != nil {
		panic(err) // test-authored maps; cannot fail
	}
	return body
}

// postDelta sends a delta1 save through the real handler. It never
// fails the test itself so it is safe to call from racing goroutines.
func postDelta(base uint64, ops []map[string]any, doc map[string]any) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/save", bytes.NewReader(deltaBody(base, ops, doc)))
	req.Header.Set(flowgo.SaveModeHeader, flowgo.SaveModeDelta1)
	rec := httptest.NewRecorder()
	handleSave(rec, req)
	return rec
}

// postFullSave sends a plain full-document save (no save-mode header).
func postFullSave(g graph.Graph) *httptest.ResponseRecorder {
	body, err := json.Marshal(g)
	if err != nil {
		panic(err)
	}
	rec := httptest.NewRecorder()
	handleSave(rec, httptest.NewRequest(http.MethodPost, "/save", bytes.NewReader(body)))
	return rec
}

// TestDeltaByteParityGolden is the card's non-negotiable. For each
// scenario: fixture A applies the delta to the seeded base; fixture B
// full-saves the equivalent end-state document (hand-derived in the
// test, NOT via the delta code). The two .flowgo files must be
// byte-identical — that is what "one serializer, no second write
// path" buys, and what this test would catch the loss of.
func TestDeltaByteParityGolden(t *testing.T) {
	scenarios := []struct {
		name string
		ops  []map[string]any
		doc  map[string]any
		// end mutates a fresh copy of the base graph into the state
		// the delta is expected to produce.
		end func(g *graph.Graph)
	}{
		{
			name: "upsert new box appends",
			ops: []map[string]any{{
				"op": "upsert", "kind": "box", "map": "/",
				"item": map[string]any{"id": "c", "label": "gamma", "x": 5, "y": 7, "palette": 3},
			}},
			end: func(g *graph.Graph) {
				g.Maps[0].Boxes = append(g.Maps[0].Boxes, graph.Box{ID: "c", Label: "gamma", X: 5, Y: 7, Palette: 3})
			},
		},
		{
			name: "upsert existing box replaces in place",
			ops: []map[string]any{{
				"op": "upsert", "kind": "box", "map": "/",
				"item": map[string]any{"id": "a", "label": "alpha moved", "x": -3.5, "y": 8},
			}},
			end: func(g *graph.Graph) {
				g.Maps[0].Boxes[0] = graph.Box{ID: "a", Label: "alpha moved", X: -3.5, Y: 8}
			},
		},
		{
			name: "delete box, missing id tolerated",
			ops: []map[string]any{
				{"op": "delete", "kind": "box", "map": "/", "id": "b"},
				{"op": "delete", "kind": "box", "map": "/", "id": "never-existed"},
				{"op": "delete", "kind": "text", "map": "/never/made", "id": "t9"},
			},
			end: func(g *graph.Graph) {
				g.Maps[0].Boxes = g.Maps[0].Boxes[:1]
			},
		},
		{
			name: "set-edges replaces the whole edge array",
			ops: []map[string]any{{
				"op": "set-edges", "map": "/",
				"edges": []map[string]any{
					{"from": "b", "to": "a", "palette": 3},
					{"from": "a", "to": "b", "label": "depends on"},
				},
			}},
			end: func(g *graph.Graph) {
				g.Maps[0].Edges = []graph.Edge{
					{From: "b", To: "a", Palette: 3},
					{From: "a", To: "b", Label: "depends on"},
				}
			},
		},
		{
			name: "text line stroke image upserts",
			ops: []map[string]any{
				{"op": "upsert", "kind": "text", "map": "/",
					"item": map[string]any{"id": "t1", "label": "note", "x": 1, "y": 2, "font": 3}},
				{"op": "upsert", "kind": "line", "map": "/",
					"item": map[string]any{"id": "l1", "x1": 0, "y1": 0, "x2": 10, "y2": 10, "style": 2, "mids": [][]float64{{5, 5}}}},
				{"op": "upsert", "kind": "stroke", "map": "/",
					"item": map[string]any{"id": "s1", "points": [][]float64{{0, 0}, {2, 3}}, "palette": 4}},
				{"op": "upsert", "kind": "image", "map": "/",
					"item": map[string]any{"id": "i1", "src": "flowgo-media/abc.png", "x": 4, "y": 5, "width": 10, "height": 8}},
			},
			end: func(g *graph.Graph) {
				g.Maps[0].Texts = []graph.Text{{ID: "t1", Label: "note", X: 1, Y: 2, Font: 3}}
				g.Maps[0].Lines = []graph.Line{{ID: "l1", X2: 10, Y2: 10, Style: 2, Mids: [][]float64{{5, 5}}}}
				g.Maps[0].Strokes = []graph.Stroke{{ID: "s1", Points: [][]float64{{0, 0}, {2, 3}}, Palette: 4}}
				g.Maps[0].Images = []graph.Image{{ID: "i1", Src: "flowgo-media/abc.png", X: 4, Y: 5, Width: 10, Height: 8}}
			},
		},
		{
			name: "set-map then populate",
			ops: []map[string]any{
				{"op": "set-map", "map": "/b"},
				{"op": "upsert", "kind": "box", "map": "/b",
					"item": map[string]any{"id": "b1", "label": "inside"}},
			},
			end: func(g *graph.Graph) {
				g.Maps = append(g.Maps, graph.NamedMap{Path: "/b", Boxes: []graph.Box{{ID: "b1", Label: "inside"}}})
			},
		},
		{
			// The "/" boundary rule: dropping "/a" takes "/a/x" (its
			// subtree) but must NOT take "/ab" (a sibling whose path
			// merely starts with the same bytes).
			name: "drop-map removes subtree, keeps prefix sibling",
			ops:  []map[string]any{{"op": "drop-map", "map": "/a"}},
			end: func(g *graph.Graph) {
				g.Maps = []graph.NamedMap{g.Maps[0], g.Maps[3]}
			},
		},
		{
			name: "document default shape",
			doc:  map[string]any{"defaultShape": 1},
			end: func(g *graph.Graph) {
				g.DefaultShape = 1
			},
		},
		{
			name: "set-kind replaces a map's whole collection",
			ops: []map[string]any{{
				"op": "set-kind", "kind": "box", "map": "/ab",
				"items": []map[string]any{
					{"id": "n1", "label": "one"},
					{"id": "n2", "label": "two", "x": 50},
				},
			}},
			end: func(g *graph.Graph) {
				g.Maps[3].Boxes = []graph.Box{{ID: "n1", Label: "one"}, {ID: "n2", Label: "two", X: 50}}
			},
		},
		{
			name: "mixed batch across ops and doc",
			ops: []map[string]any{
				{"op": "upsert", "kind": "box", "map": "/",
					"item": map[string]any{"id": "c", "label": "gamma", "x": 5, "y": 7}},
				{"op": "delete", "kind": "box", "map": "/a", "id": "a1"},
				{"op": "set-edges", "map": "/", "edges": []map[string]any{{"from": "a", "to": "c"}}},
			},
			doc: map[string]any{"defaultShape": 2},
			end: func(g *graph.Graph) {
				g.Maps[0].Boxes = append(g.Maps[0].Boxes, graph.Box{ID: "c", Label: "gamma", X: 5, Y: 7})
				g.Maps[1].Boxes = nil
				g.Maps[0].Edges = []graph.Edge{{From: "a", To: "c"}}
				g.DefaultShape = 2
			},
		},
	}

	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			// Fixture A: apply the delta.
			pathA := serveTempMap(t, deltaSeed())
			rec := postDelta(stateRevision(t), sc.ops, sc.doc)
			if rec.Code != 204 {
				t.Fatalf("delta status = %d, body = %s", rec.Code, rec.Body.String())
			}
			gotDelta := mustReadFile(t, pathA)
			if gotDelta == deltaSeed() {
				t.Fatalf("scenario is a byte no-op; it can't prove parity")
			}

			// Fixture B: full-save the hand-derived end state.
			pathB := serveTempMap(t, deltaSeed())
			endState := deltaBaseGraph()
			sc.end(&endState)
			if rec := postFullSave(endState); rec.Code != 204 {
				t.Fatalf("full save status = %d, body = %s", rec.Code, rec.Body.String())
			}
			gotFull := mustReadFile(t, pathB)

			if gotDelta != gotFull {
				t.Errorf("delta and full save diverged:\n--- delta wrote ---\n%s\n--- full save wrote ---\n%s", gotDelta, gotFull)
			}
		})
	}
}

// A stale base means the client edited on top of a document that has
// since moved — applying would silently drop the other writer's work.
// 409, and not a byte on disk changes.
func TestDeltaStaleBaseGets409FileUntouched(t *testing.T) {
	path := serveTempMap(t, deltaSeed())
	rev := stateRevision(t)
	// Both directions of stale: a base from the future (confused
	// client) and — the case that actually happens — a base from
	// before another writer's save landed.
	stales := []uint64{rev + 1, rev + 1000}
	if rev > 0 {
		stales = append(stales, rev-1)
	}
	for _, stale := range stales {
		rec := postDelta(stale, []map[string]any{{
			"op": "upsert", "kind": "box", "map": "/",
			"item": map[string]any{"id": "c", "label": "gamma"},
		}}, nil)
		if rec.Code != 409 {
			t.Fatalf("base %d against revision %d: status = %d (want 409), body = %s", stale, rev, rec.Code, rec.Body.String())
		}
		if got := mustReadFile(t, path); got != deltaSeed() {
			t.Errorf("409 delta modified the file:\n%s", got)
		}
	}
	if got := stateRevision(t); got != rev {
		t.Errorf("409 delta bumped the revision: %d -> %d", rev, got)
	}
}

// A file that doesn't parse has no document to apply a delta against
// — but a full save would fix it by replacing the bytes wholesale, so
// the answer is 409 (client falls back to full), never 400/500.
func TestDeltaAgainstUnparseableFileGets409(t *testing.T) {
	const garbage = "this is not a flowgo directive\n"
	path := serveTempMap(t, garbage)
	rec := postDelta(flowgo.Revision(), []map[string]any{{
		"op": "upsert", "kind": "box", "map": "/",
		"item": map[string]any{"id": "c", "label": "gamma"},
	}}, nil)
	if rec.Code != 409 {
		t.Fatalf("delta on unparseable file: status = %d (want 409), body = %s", rec.Code, rec.Body.String())
	}
	if got := mustReadFile(t, path); got != garbage {
		t.Errorf("delta modified an unparseable file it could not have understood:\n%s", got)
	}
}

// Atomicity: ops apply to a copy and persist only on full success. A
// delta that fails midway must leave the file, the served state, and
// the revision exactly as they were — the good ops before the bad one
// must not leak.
func TestDeltaMidFailureLeavesEverythingUntouched(t *testing.T) {
	path := serveTempMap(t, deltaSeed())
	rev := stateRevision(t)
	rec := postDelta(rev, []map[string]any{
		{"op": "upsert", "kind": "box", "map": "/",
			"item": map[string]any{"id": "c", "label": "gamma"}},
		{"op": "transmogrify", "map": "/"},
	}, nil)
	if rec.Code != 400 {
		t.Fatalf("status = %d (want 400), body = %s", rec.Code, rec.Body.String())
	}
	if got := mustReadFile(t, path); got != deltaSeed() {
		t.Errorf("failed delta modified the file:\n%s", got)
	}
	// The good first op must not be visible through /state either.
	stateRec := httptest.NewRecorder()
	handleState(stateRec, httptest.NewRequest(http.MethodGet, "/state", nil))
	var g graph.Graph
	if err := json.Unmarshal(stateRec.Body.Bytes(), &g); err != nil {
		t.Fatalf("decode /state: %v", err)
	}
	if len(g.Maps) == 0 || len(g.Maps[0].Boxes) != 2 {
		t.Errorf("half-applied delta leaked into /state: %s", stateRec.Body.String())
	}
	if got := stateRevision(t); got != rev {
		t.Errorf("failed delta bumped the revision: %d -> %d", rev, got)
	}
}

// Every way a delta can be malformed answers 400 with the file
// untouched. (Unknown op/kind per the spec; the rest are the same
// "retrying this exact delta is useless" class.)
func TestDeltaRejectsMalformedOps(t *testing.T) {
	cases := map[string][]map[string]any{
		"unknown op":           {{"op": "merge", "map": "/"}},
		"unknown kind":         {{"op": "upsert", "kind": "circle", "map": "/", "item": map[string]any{"id": "c"}}},
		"unknown delete kind":  {{"op": "delete", "kind": "kine", "map": "/nowhere", "id": "x"}},
		"missing map path":     {{"op": "upsert", "kind": "box", "item": map[string]any{"id": "c", "label": "g"}}},
		"upsert without item":  {{"op": "upsert", "kind": "box", "map": "/"}},
		"set-kind sans items":  {{"op": "set-kind", "kind": "box", "map": "/"}},
		"set-edges sans edges": {{"op": "set-edges", "map": "/"}},
		"item of wrong shape":  {{"op": "upsert", "kind": "box", "map": "/", "item": 42}},
		// Unwritable content is the full-save 400 (brain#245), reached
		// through the same ValidateWritable gate.
		"unwritable id": {{"op": "upsert", "kind": "box", "map": "/", "item": map[string]any{"id": "sp ace", "label": "x"}}},
	}
	for name, ops := range cases {
		t.Run(name, func(t *testing.T) {
			path := serveTempMap(t, deltaSeed())
			rec := postDelta(stateRevision(t), ops, nil)
			if rec.Code != 400 {
				t.Fatalf("status = %d (want 400), body = %s", rec.Code, rec.Body.String())
			}
			if got := mustReadFile(t, path); got != deltaSeed() {
				t.Errorf("rejected delta modified the file:\n%s", got)
			}
		})
	}
}

// MCP-style race: a full save and a delta contend for the same
// document. Whichever lands second at the revision either loses (the
// delta, via the guard) or wins wholesale (the full save, which is
// the protocol's conflict resolution) — in both orderings the file is
// one writer's complete output, never an interleaving.
func TestDeltaFullSaveRaceBothOrderings(t *testing.T) {
	fullDoc := deltaBaseGraph()
	fullDoc.Maps[0].Boxes[0].Label = "full-winner"
	deltaOps := []map[string]any{{
		"op": "upsert", "kind": "box", "map": "/",
		"item": map[string]any{"id": "c", "label": "delta-was-here"},
	}}

	t.Run("full save lands first, stale delta 409s", func(t *testing.T) {
		path := serveTempMap(t, deltaSeed())
		base := stateRevision(t) // delta client read this, then lost the race
		if rec := postFullSave(fullDoc); rec.Code != 204 {
			t.Fatalf("full save status = %d", rec.Code)
		}
		afterFull := mustReadFile(t, path)
		rec := postDelta(base, deltaOps, nil)
		if rec.Code != 409 {
			t.Fatalf("stale delta status = %d (want 409), body = %s", rec.Code, rec.Body.String())
		}
		if got := mustReadFile(t, path); got != afterFull {
			t.Errorf("409 delta corrupted the winner's bytes:\n%s", got)
		}
	})

	t.Run("delta lands first, full save wins wholesale", func(t *testing.T) {
		path := serveTempMap(t, deltaSeed())
		if rec := postDelta(stateRevision(t), deltaOps, nil); rec.Code != 204 {
			t.Fatalf("delta status = %d", rec.Code)
		}
		if rec := postFullSave(fullDoc); rec.Code != 204 {
			t.Fatalf("full save status = %d", rec.Code)
		}
		expected := fullDoc
		expected.Version = resolveVersionString()
		if got := mustReadFile(t, path); got != graph.Serialize(expected) {
			t.Errorf("file is not the full save's complete output:\n%s", got)
		}
	})
}

// True-parallel smoke on top of the deterministic orderings: two
// writers hammer /save concurrently (run under -race in CI). Any
// interleaved write would leave non-canonical or unparseable bytes.
func TestDeltaFullSaveParallelNoCorruption(t *testing.T) {
	path := serveTempMap(t, deltaSeed())
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			doc := deltaBaseGraph()
			doc.Maps[0].Boxes[1].Label = fmt.Sprintf("full%d", i)
			if rec := postFullSave(doc); rec.Code != 204 {
				t.Errorf("full save %d: status %d", i, rec.Code)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 25; i++ {
			ops := []map[string]any{{
				"op": "upsert", "kind": "box", "map": "/",
				"item": map[string]any{"id": "r", "label": fmt.Sprintf("delta%d", i)},
			}}
			// Base sampled the way a client would; racing full saves
			// legitimately turn some of these into 409s.
			if rec := postDelta(flowgo.Revision(), ops, nil); rec.Code != 204 && rec.Code != 409 {
				t.Errorf("delta %d: status %d, body %s", i, rec.Code, rec.Body.String())
				return
			}
		}
	}()
	wg.Wait()
	data := mustReadFile(t, path)
	g, err := graph.Parse(data)
	if err != nil {
		t.Fatalf("racing writers corrupted the file: %v\n%s", err, data)
	}
	if graph.Serialize(g) != data {
		t.Errorf("file bytes are not canonical serializer output:\n%s", data)
	}
}

// Regression pin for the full-save path: without the X-Flowgo-Save
// header, /save must keep writing the exact bytes it wrote before the
// delta protocol existed. The expected string is hard-coded on
// purpose — pinning through the serializer would follow a serializer
// regression instead of catching one.
func TestFullSaveBytesUnchangedWithoutDeltaHeader(t *testing.T) {
	path := serveTempMap(t, "node old x 0 0\n")
	rec := postFullSave(graph.Graph{Maps: []graph.NamedMap{{
		Path:  "/",
		Boxes: []graph.Box{{ID: "b1", Label: "hello"}, {ID: "b2", Label: "two words", X: 100, Y: 0}},
		Edges: []graph.Edge{{From: "b1", To: "b2"}},
	}}})
	if rec.Code != 204 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get(revisionHeader) == "" {
		t.Errorf("full save no longer echoes %s", revisionHeader)
	}
	const want = "version dev\nnode b1 hello 0 0\nnode b2 \"two words\" 100 0\n\nedge b1 b2\n"
	if got := mustReadFile(t, path); got != want {
		t.Errorf("full-save bytes changed:\n got: %q\nwant: %q", got, want)
	}
}

// Gzip composes: a delta body may arrive Content-Encoding: gzip and
// must produce the same bytes as the identical plain delta.
func TestDeltaGzipRoundTrip(t *testing.T) {
	ops := []map[string]any{{
		"op": "upsert", "kind": "box", "map": "/",
		"item": map[string]any{"id": "c", "label": "gamma", "x": 5, "y": 7},
	}}

	pathPlain := serveTempMap(t, deltaSeed())
	if rec := postDelta(stateRevision(t), ops, nil); rec.Code != 204 {
		t.Fatalf("plain delta status = %d, body = %s", rec.Code, rec.Body.String())
	}
	want := mustReadFile(t, pathPlain)

	pathGz := serveTempMap(t, deltaSeed())
	body := deltaBody(stateRevision(t), ops, nil)
	req := httptest.NewRequest(http.MethodPost, "/save", gzipped(t, string(body)))
	req.Header.Set("Content-Encoding", "gzip")
	req.Header.Set(flowgo.SaveModeHeader, flowgo.SaveModeDelta1)
	rec := httptest.NewRecorder()
	handleSave(rec, req)
	if rec.Code != 204 {
		t.Fatalf("gzip delta status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := mustReadFile(t, pathGz); got != want {
		t.Errorf("gzip delta wrote different bytes:\n got: %q\nwant: %q", got, want)
	}
}

// The capability handshake: the editor only ever sends a delta after
// seeing this header on /state (shared-bundle rule — servers that
// don't advertise keep receiving full saves).
func TestStateAdvertisesDeltaCapability(t *testing.T) {
	serveTempMap(t, deltaSeed())
	rec := httptest.NewRecorder()
	handleState(rec, httptest.NewRequest(http.MethodGet, "/state", nil))
	if got := rec.Header().Get(flowgo.SaveModeHeader); got != flowgo.SaveModeDelta1 {
		t.Errorf("/state %s = %q, want %q", flowgo.SaveModeHeader, got, flowgo.SaveModeDelta1)
	}
}

// A successful delta answers like a full save: 204 with the NEW
// revision in X-Flowgo-Revision, so the client can chain its next
// delta without a /state round trip.
func TestDeltaSuccessEchoesNewRevision(t *testing.T) {
	serveTempMap(t, deltaSeed())
	before := stateRevision(t)
	rec := postDelta(before, []map[string]any{{
		"op": "upsert", "kind": "box", "map": "/",
		"item": map[string]any{"id": "c", "label": "gamma"},
	}}, nil)
	if rec.Code != 204 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	echoed := rec.Header().Get(revisionHeader)
	after := stateRevision(t)
	if after != before+1 {
		t.Errorf("revision after delta = %d, want %d", after, before+1)
	}
	if echoed != strconv.FormatUint(after, 10) {
		t.Errorf("delta echoed revision %q, /state says %d", echoed, after)
	}
}

// A delta whose net effect is no byte change (here: only creating an
// empty map, which the serializer drops) succeeds without bumping the
// revision — byte-identical writes are skipped, so there is no new
// revision to announce and none is invented.
func TestDeltaByteNoOpKeepsRevision(t *testing.T) {
	path := serveTempMap(t, deltaSeed())
	before := stateRevision(t)
	rec := postDelta(before, []map[string]any{{"op": "set-map", "map": "/zz"}}, nil)
	if rec.Code != 204 {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if got := mustReadFile(t, path); got != deltaSeed() {
		t.Errorf("empty-map delta changed bytes:\n%s", got)
	}
	if got := rec.Header().Get(revisionHeader); got != strconv.FormatUint(before, 10) {
		t.Errorf("no-op delta echoed revision %q, want %d", got, before)
	}
}

// An X-Flowgo-Save value we don't speak fails closed. Falling through
// to the full-document decoder would read a delta-shaped body as an
// EMPTY graph (unknown JSON fields are ignored) and wipe the map.
func TestUnknownSaveModeFailsClosed(t *testing.T) {
	path := serveTempMap(t, deltaSeed())
	body := deltaBody(stateRevision(t), []map[string]any{{"op": "drop-map", "map": "/a"}}, nil)
	req := httptest.NewRequest(http.MethodPost, "/save", bytes.NewReader(body))
	req.Header.Set(flowgo.SaveModeHeader, "delta2")
	rec := httptest.NewRecorder()
	handleSave(rec, req)
	if rec.Code != 400 {
		t.Fatalf("unknown save mode: status = %d (want 400), body = %s", rec.Code, rec.Body.String())
	}
	if got := mustReadFile(t, path); got != deltaSeed() {
		t.Errorf("unknown save mode modified the file:\n%s", got)
	}
}
