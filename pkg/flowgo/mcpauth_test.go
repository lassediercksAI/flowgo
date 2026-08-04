package flowgo

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// fakeAuth is an in-memory MCPAuth: enough to prove the wiring in
// pkg/flowgo without dragging Postgres in. The real implementation
// lives in flowgo-website's internal/mcpauth.
type fakeAuth struct {
	linked   map[string]Owner // sessionID -> account
	pending  map[string]string
	beginErr error
	ownerErr error
	begins   int
	ended    []string
}

func newFakeAuth() *fakeAuth {
	return &fakeAuth{linked: map[string]Owner{}, pending: map[string]string{}}
}

func (f *fakeAuth) BeginPairing(ctx context.Context, sessionID string) (Pairing, error) {
	if f.beginErr != nil {
		return Pairing{}, f.beginErr
	}
	f.begins++
	code := "code-for-" + sessionID
	f.pending[code] = sessionID
	return Pairing{
		URL:       "https://flowgo-map.com/authenticate?code=" + code,
		ExpiresAt: time.Now().Add(10 * time.Minute),
	}, nil
}

func (f *fakeAuth) SessionOwner(ctx context.Context, sessionID string) (Owner, bool, error) {
	if f.ownerErr != nil {
		return Owner{}, false, f.ownerErr
	}
	o, ok := f.linked[sessionID]
	return o, ok, nil
}

func (f *fakeAuth) EndSession(ctx context.Context, sessionID string) error {
	f.ended = append(f.ended, sessionID)
	delete(f.linked, sessionID)
	return nil
}

// approve simulates the human opening the /authenticate URL and
// confirming while signed in.
func (f *fakeAuth) approve(code string, owner Owner) {
	f.linked[f.pending[code]] = owner
}

// withAuth wires serve mode + a share webhook + a fake account system,
// restoring the package config afterwards.
func withAuth(t *testing.T, handler http.HandlerFunc) *fakeAuth {
	t.Helper()
	webhook := httptest.NewServer(handler)
	t.Cleanup(webhook.Close)
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	auth := newFakeAuth()
	Configure(Config{
		ServeMode:          true,
		Workspaces:         NewWorkspaceManager(time.Hour),
		ShareWebhookURL:    webhook.URL,
		ShareWebhookSecret: "test-secret",
		Auth:               auth,
	})
	return auth
}

func TestAuthenticateTool_NotListedWithoutAuthBackend(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { cfg = orig })
	Configure(Config{ServeMode: true, Workspaces: NewWorkspaceManager(time.Hour)})
	for _, tool := range mcpTools() {
		if tool.Name == "authenticate" {
			t.Fatal("authenticate must not be advertised when Config.Auth is nil")
		}
	}
	if _, err := dispatchTool("authenticate", nil); err == nil {
		t.Fatal("calling authenticate without an auth backend should error")
	}
}

func TestAuthenticateTool_ListedWithAuthBackend(t *testing.T) {
	withAuth(t, func(w http.ResponseWriter, r *http.Request) {})
	var found bool
	for _, tool := range mcpTools() {
		if tool.Name == "authenticate" {
			found = true
		}
	}
	if !found {
		t.Fatal("authenticate should be advertised when Config.Auth is set")
	}
}

func TestAuthenticate_MintsPairingURLThenReportsLinkedAccount(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})

	first, err := actAuthenticate(context.Background(), "sess-1", nil)
	if err != nil {
		t.Fatalf("actAuthenticate: %v", err)
	}
	text := mcpToolResultText(t, first)
	if !strings.Contains(text, "https://flowgo-map.com/authenticate?code=code-for-sess-1") {
		t.Fatalf("first call should hand back the approval URL, got: %s", text)
	}

	auth.approve("code-for-sess-1", Owner{ID: "user-uuid", Label: "a@example.com"})

	second, err := actAuthenticate(context.Background(), "sess-1", nil)
	if err != nil {
		t.Fatalf("actAuthenticate (post-approval): %v", err)
	}
	text = mcpToolResultText(t, second)
	if !strings.Contains(text, "a@example.com") {
		t.Fatalf("second call should report the linked account, got: %s", text)
	}
	if auth.begins != 1 {
		t.Errorf("an already-linked session must not mint a second pairing code (begins = %d)", auth.begins)
	}
}

func TestAuthenticate_FallsBackToWorkspaceIDWithoutSessionHeader(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})

	if _, err := actAuthenticate(context.Background(), "", nil); err == nil {
		t.Fatal("no session header and no workspace_id should be an error, not a silent anonymous link")
	}

	if _, err := actAuthenticate(context.Background(), "", map[string]any{"workspace_id": "ws-abc"}); err != nil {
		t.Fatalf("workspace_id fallback: %v", err)
	}
	if _, ok := auth.pending["code-for-ws:ws-abc"]; !ok {
		t.Fatalf("workspace fallback should key the pairing on ws:<workspace_id>, pending = %v", auth.pending)
	}
}

func TestAuthenticate_ErrorsAreNotLeakedVerbatim(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})
	auth.ownerErr = errors.New("pq: relation \"mcp_sessions\" does not exist")
	_, err := actAuthenticate(context.Background(), "sess-1", nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "mcp_sessions") {
		t.Fatalf("database internals leaked to the MCP client: %v", err)
	}
}

// The load-bearing behaviour of the whole card: once a session is
// linked, the graph POSTed to the share webhook carries owner_id.
func TestShare_CarriesOwnerIDOnceAuthenticated(t *testing.T) {
	var body map[string]any
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "xyz", "url": "https://flowgo-map.com/m/xyz"})
	})

	wsID := cfg.Workspaces.Start()

	if _, err := shareWorkspace(context.Background(), "sess-1", map[string]any{"workspace_id": wsID}); err != nil {
		t.Fatalf("share (anonymous): %v", err)
	}
	if _, present := body["owner_id"]; present {
		t.Fatalf("an unlinked session must not stamp an owner: %v", body["owner_id"])
	}

	if _, err := actAuthenticate(context.Background(), "sess-1", nil); err != nil {
		t.Fatalf("actAuthenticate: %v", err)
	}
	auth.approve("code-for-sess-1", Owner{ID: "user-uuid", Label: "a@example.com"})

	if _, err := shareWorkspace(context.Background(), "sess-1", map[string]any{"workspace_id": wsID}); err != nil {
		t.Fatalf("share (authenticated): %v", err)
	}
	if body["owner_id"] != "user-uuid" {
		t.Fatalf("owner_id = %v, want user-uuid", body["owner_id"])
	}
}

func TestCreateMap_CarriesOwnerIDOnceAuthenticated(t *testing.T) {
	var body map[string]any
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "xyz", "url": "https://flowgo-map.com/m/xyz"})
	})
	auth.linked["sess-2"] = Owner{ID: "owner-2", Label: "b@example.com"}

	if _, err := createMap(context.Background(), "sess-2", map[string]any{"flowgo_text": "node b1 hello 0 0\n"}); err != nil {
		t.Fatalf("createMap: %v", err)
	}
	if body["owner_id"] != "owner-2" {
		t.Fatalf("owner_id = %v, want owner-2", body["owner_id"])
	}
}

// An auth backend that's down must cost attribution, never the share
// itself — a human waiting on a link shouldn't be blocked by a table
// they never asked about.
func TestShare_FailsOpenWhenAuthLookupErrors(t *testing.T) {
	var body map[string]any
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "xyz", "url": "https://flowgo-map.com/m/xyz"})
	})
	auth.ownerErr = errors.New("db down")

	wsID := cfg.Workspaces.Start()
	if _, err := shareWorkspace(context.Background(), "sess-1", map[string]any{"workspace_id": wsID}); err != nil {
		t.Fatalf("share should still succeed when the auth lookup fails: %v", err)
	}
	if _, present := body["owner_id"]; present {
		t.Fatal("owner_id must be absent when the lookup failed")
	}
}

func TestMCPSessionID_MintedOnInitializeAndEchoedBack(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	w := httptest.NewRecorder()
	MCPHandler(w, req)
	sid := w.Header().Get(mcpSessionHeader)
	if sid == "" {
		t.Fatal("initialize must assign an Mcp-Session-Id")
	}
	if len(sid) < 32 {
		t.Fatalf("session id looks too short to be unguessable: %q", sid)
	}

	// A client-supplied id on initialize is honoured rather than
	// replaced, so a reconnecting client keeps its account link.
	req = httptest.NewRequest(http.MethodPost, "/mcp",
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	req.Header.Set(mcpSessionHeader, "client-chosen")
	w = httptest.NewRecorder()
	MCPHandler(w, req)
	if got := w.Header().Get(mcpSessionHeader); got != "client-chosen" {
		t.Fatalf("session id = %q, want the client's own value echoed back", got)
	}
}

func TestMCPDelete_UnlinksTheSession(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})
	auth.linked["sess-3"] = Owner{ID: "o", Label: "c@example.com"}

	req := httptest.NewRequest(http.MethodDelete, "/mcp", nil)
	req.Header.Set(mcpSessionHeader, "sess-3")
	w := httptest.NewRecorder()
	MCPHandler(w, req)

	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", w.Code)
	}
	if _, still := auth.linked["sess-3"]; still {
		t.Fatal("DELETE should drop the account link")
	}
}

// tools/call must carry the transport session through to the tool, or
// authenticate would mint a fresh pairing code on every single call.
func TestToolsCall_ThreadsSessionIDThrough(t *testing.T) {
	auth := withAuth(t, func(w http.ResponseWriter, r *http.Request) {})
	auth.linked["sess-4"] = Owner{ID: "o", Label: "d@example.com"}

	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"authenticate","arguments":{}}}`))
	req.Header.Set(mcpSessionHeader, "sess-4")
	w := httptest.NewRecorder()
	MCPHandler(w, req)

	var resp struct {
		Result struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v (body %s)", err, w.Body.String())
	}
	if len(resp.Result.Content) == 0 || !strings.Contains(resp.Result.Content[0].Text, "d@example.com") {
		t.Fatalf("authenticate did not see the transport session: %s", w.Body.String())
	}
	if auth.begins != 0 {
		t.Error("an already-linked session should not mint a pairing code")
	}
}
