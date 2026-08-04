package flowgo

import (
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWorkspaceManager_StartCreatesRootMap(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	id := m.Start()
	if id == "" {
		t.Fatal("Start() returned an empty id")
	}
	var got Graph
	if err := m.With(id, func(ws *Workspace) error {
		got = ws.Graph
		return nil
	}); err != nil {
		t.Fatalf("With: %v", err)
	}
	if len(got.Maps) != 1 || got.Maps[0].Path != "/" {
		t.Fatalf("Start() graph = %+v, want a single root map at \"/\"", got)
	}
}

func TestWorkspaceManager_StartIDsAreUnique(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		id := m.Start()
		if seen[id] {
			t.Fatalf("Start() produced a duplicate id: %s", id)
		}
		seen[id] = true
	}
}

func TestNewWorkspaceID_HasWsPrefix(t *testing.T) {
	id := newWorkspaceID()
	if !strings.HasPrefix(id, "ws-") {
		t.Errorf("newWorkspaceID() = %q, want ws- prefix", id)
	}
	if id == newWorkspaceID() {
		t.Error("two calls to newWorkspaceID() produced the same id")
	}
}

func TestWorkspaceManager_WithMutatesGraphAndBumpsLastSeen(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	id := m.Start()

	var before time.Time
	if err := m.With(id, func(ws *Workspace) error {
		before = ws.LastSeen
		return nil
	}); err != nil {
		t.Fatalf("With: %v", err)
	}

	time.Sleep(2 * time.Millisecond)
	if err := m.With(id, func(ws *Workspace) error {
		ws.Graph.Maps[0].Boxes = append(ws.Graph.Maps[0].Boxes, Box{ID: "b1", Label: "hi"})
		return nil
	}); err != nil {
		t.Fatalf("With: %v", err)
	}

	if err := m.With(id, func(ws *Workspace) error {
		if len(ws.Graph.Maps[0].Boxes) != 1 {
			t.Errorf("mutation from a prior With() call didn't stick: %+v", ws.Graph.Maps[0])
		}
		if !ws.LastSeen.After(before) {
			t.Errorf("LastSeen = %v, want it bumped past %v", ws.LastSeen, before)
		}
		return nil
	}); err != nil {
		t.Fatalf("With: %v", err)
	}
}

func TestWorkspaceManager_WithUnknownIDErrors(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	err := m.With("ws-does-not-exist", func(ws *Workspace) error {
		t.Error("fn should never run for an unknown workspace id")
		return nil
	})
	if err == nil {
		t.Fatal("expected an error for an unknown workspace id")
	}
}

func TestWorkspaceManager_WithPropagatesFnError(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	id := m.Start()
	sentinel := errFromFn{}
	err := m.With(id, func(ws *Workspace) error { return sentinel })
	if err != sentinel {
		t.Fatalf("With() error = %v, want the mutator's own error propagated", err)
	}
}

type errFromFn struct{}

func (errFromFn) Error() string { return "boom" }

// TestWorkspaceManager_ConcurrentAccessIsSerialized exercises the two
// locks (manager-level for the map, per-workspace for the graph) under
// real concurrent access — go test -race is what actually proves this,
// but the assertion also checks no mutation was lost.
func TestWorkspaceManager_ConcurrentAccessIsSerialized(t *testing.T) {
	m := NewWorkspaceManager(time.Hour)
	id := m.Start()

	var wg sync.WaitGroup
	const n = 50
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = m.With(id, func(ws *Workspace) error {
				ws.Graph.Maps[0].Boxes = append(ws.Graph.Maps[0].Boxes, Box{ID: nextID(&ws.Graph.Maps[0], "b"), Label: "x"})
				return nil
			})
		}(i)
	}
	wg.Wait()

	if err := m.With(id, func(ws *Workspace) error {
		if len(ws.Graph.Maps[0].Boxes) != n {
			t.Errorf("got %d boxes, want %d (a concurrent write was lost)", len(ws.Graph.Maps[0].Boxes), n)
		}
		return nil
	}); err != nil {
		t.Fatalf("With: %v", err)
	}
}
