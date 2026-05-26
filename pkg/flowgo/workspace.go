package flowgo

import (
	"crypto/rand"
	"encoding/base32"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Workspace is the agent-session-scoped graph that MCP tools mutate. It dies
// when the session goes idle past the manager's TTL — there's no on-disk
// persistence for workspaces (snapshots are how anything durable happens).
type Workspace struct {
	mu       sync.Mutex
	Graph    Graph
	LastSeen time.Time
}

type WorkspaceManager struct {
	mu    sync.Mutex
	items map[string]*Workspace
	ttl   time.Duration
}

func NewWorkspaceManager(ttl time.Duration) *WorkspaceManager {
	m := &WorkspaceManager{
		items: map[string]*Workspace{},
		ttl:   ttl,
	}
	go m.sweep()
	return m
}

func (m *WorkspaceManager) Start() string {
	id := newWorkspaceID()
	ws := &Workspace{
		Graph:    Graph{Maps: []NamedMap{{Path: "/"}}},
		LastSeen: time.Now(),
	}
	m.mu.Lock()
	m.items[id] = ws
	m.mu.Unlock()
	return id
}

// With executes fn while holding the workspace's mutex. The mutator can read
// and write ws.Graph freely. LastSeen is bumped on entry so an active session
// keeps the workspace alive.
func (m *WorkspaceManager) With(id string, fn func(*Workspace) error) error {
	m.mu.Lock()
	ws, ok := m.items[id]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("workspace not found: %s (expired or never created — call start_workspace)", id)
	}
	ws.mu.Lock()
	defer ws.mu.Unlock()
	ws.LastSeen = time.Now()
	return fn(ws)
}

func (m *WorkspaceManager) sweep() {
	tick := m.ttl / 4
	if tick < time.Minute {
		tick = time.Minute
	}
	for {
		time.Sleep(tick)
		cutoff := time.Now().Add(-m.ttl)
		m.mu.Lock()
		for id, ws := range m.items {
			ws.mu.Lock()
			old := ws.LastSeen.Before(cutoff)
			ws.mu.Unlock()
			if old {
				delete(m.items, id)
			}
		}
		m.mu.Unlock()
	}
}

func newWorkspaceID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	enc := strings.TrimRight(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b), "=")
	return "ws-" + strings.ToLower(enc)
}
