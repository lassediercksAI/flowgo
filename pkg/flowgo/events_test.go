package flowgo

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lassediercks/flowgo/pkg/graph"
)

const seedDoc = "version dev\nnode b1 seed 0 0\n"

// sseClient is a connected /events reader. next() blocks until the
// next non-comment frame arrives (or the deadline passes), so tests
// read what the wire actually carried rather than poking at internals.
type sseClient struct {
	cancel context.CancelFunc
	frames chan sseFrame
	errs   chan error
	body   interface{ Close() error }
}

type sseFrame struct {
	event string
	id    string
	data  changeEvent
}

// dialEvents opens a real HTTP connection to base+/events. It returns
// once the stream is established, so a caller that mutates
// immediately after cannot race the subscription.
func dialEvents(t *testing.T, base, session string) *sseClient {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	url := base + "/events"
	if session != "" {
		url += "?session=" + session
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		t.Fatalf("build request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("GET /events: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		cancel()
		t.Fatalf("GET /events: status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		cancel()
		t.Fatalf("GET /events: content-type %q", ct)
	}
	c := &sseClient{
		cancel: cancel,
		frames: make(chan sseFrame, 16),
		errs:   make(chan error, 1),
		body:   resp.Body,
	}
	go func() {
		defer close(c.frames)
		sc := bufio.NewScanner(resp.Body)
		var cur sseFrame
		var haveData bool
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if haveData {
					c.frames <- cur
				}
				cur, haveData = sseFrame{}, false
			case strings.HasPrefix(line, ":"):
				// comment / ping — ignored
			case strings.HasPrefix(line, "event: "):
				cur.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "id: "):
				cur.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "data: "):
				if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &cur.data); err != nil {
					c.errs <- err
					return
				}
				haveData = true
			}
		}
	}()
	t.Cleanup(c.close)
	return c
}

func (c *sseClient) close() {
	c.cancel()
	_ = c.body.Close()
}

// next returns the next frame, or fails the test after d.
func (c *sseClient) next(t *testing.T, d time.Duration) sseFrame {
	t.Helper()
	select {
	case f, ok := <-c.frames:
		if !ok {
			t.Fatal("event stream closed while waiting for a frame")
		}
		return f
	case err := <-c.errs:
		t.Fatalf("event stream error: %v", err)
	case <-time.After(d):
		t.Fatalf("no event within %s", d)
	}
	return sseFrame{}
}

// expectNothing asserts silence for d — the self-echo test's whole
// point. There is no way to prove a negative faster than waiting.
func (c *sseClient) expectNothing(t *testing.T, d time.Duration) {
	t.Helper()
	select {
	case f, ok := <-c.frames:
		if !ok {
			t.Fatal("event stream closed unexpectedly")
		}
		t.Fatalf("expected no event, got %s rev=%d origin=%q", f.event, f.data.Rev, f.data.Origin)
	case <-time.After(d):
	}
}

// eventsServer starts a real net/http server (not a ResponseRecorder)
// with the CLI's timeouts, configured against a temp .flowgo. A real
// server is the point: the write deadline that WriteTimeout arms is a
// connection-level thing a recorder doesn't have, and it is exactly
// what would silently kill this route.
func eventsServer(t *testing.T, writeTimeout time.Duration) (base, path string) {
	t.Helper()
	orig := cfg
	t.Cleanup(func() { Configure(orig) })
	path = t.TempDir() + "/map.flowgo"
	if err := os.WriteFile(path, []byte(seedDoc), 0644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	Configure(Config{LocalFile: path})

	mux := http.NewServeMux()
	mux.HandleFunc("/events", EventsHandler)
	srv := httptest.NewUnstartedServer(mux)
	srv.Config.ReadTimeout = writeTimeout
	srv.Config.WriteTimeout = writeTimeout
	srv.Config.IdleTimeout = writeTimeout
	srv.Start()
	t.Cleanup(srv.Close)
	return srv.URL, path
}

// mutate applies an MCP-shaped write (the agent path).
func mutate(t *testing.T, label string) {
	t.Helper()
	_, err := updateFile(func(g *Graph) error {
		m := ensureMapAt(g, "/")
		m.Boxes = append(m.Boxes, graph.Box{ID: nextID(m, "b"), Label: label})
		return nil
	})
	if err != nil {
		t.Fatalf("updateFile: %v", err)
	}
}

// TestEventsDeliversMCPMutation is the core promise: an agent writes
// through the MCP path, the browser hears about it.
func TestEventsDeliversMCPMutation(t *testing.T) {
	base, _ := eventsServer(t, 30*time.Second)
	c := dialEvents(t, base, "tab-1")

	hello := c.next(t, 2*time.Second)
	if hello.event != "hello" {
		t.Fatalf("first frame = %q, want hello", hello.event)
	}

	mutate(t, "from the agent")

	f := c.next(t, 2*time.Second)
	if f.event != "change" {
		t.Fatalf("event = %q, want change", f.event)
	}
	if f.data.Origin != OriginMCP {
		t.Errorf("origin = %q, want %q", f.data.Origin, OriginMCP)
	}
	if f.data.Rev <= hello.data.Rev {
		t.Errorf("rev = %d, want > hello rev %d", f.data.Rev, hello.data.Rev)
	}
	if f.id != fmt.Sprint(f.data.Rev) {
		t.Errorf("SSE id = %q, want %d (Last-Event-ID must carry the revision)", f.id, f.data.Rev)
	}
}

// TestEventsSuppressesSelfOriginatedSave is user story 3: my own save
// must not come back at me. Without this the editor would rebuild its
// whole DOM every time it saved.
func TestEventsSuppressesSelfOriginatedSave(t *testing.T) {
	base, _ := eventsServer(t, 30*time.Second)
	mine := dialEvents(t, base, "tab-mine")
	other := dialEvents(t, base, "tab-other")
	mine.next(t, 2*time.Second)  // hello
	other.next(t, 2*time.Second) // hello

	g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "typed by hand"}}}}}
	if err := SaveLocalGraphFrom(g, "tab-mine"); err != nil {
		t.Fatalf("SaveLocalGraphFrom: %v", err)
	}

	// The other tab sees it...
	f := other.next(t, 2*time.Second)
	if f.event != "change" || f.data.Origin != "tab-mine" {
		t.Fatalf("other tab: got %s origin=%q, want change origin=tab-mine", f.event, f.data.Origin)
	}
	// ...and the tab that made it does not.
	mine.expectNothing(t, 300*time.Millisecond)
}

// TestEventsNoEventForByteIdenticalSave: the editor re-saves the same
// document all the time (undo/redo round trips, a drag that lands
// where it started). Nothing changed, so nobody should be told to
// re-read.
func TestEventsNoEventForByteIdenticalSave(t *testing.T) {
	base, path := eventsServer(t, 30*time.Second)
	// Prime the disk-identity record the skip check needs.
	if _, err := readFile(); err != nil {
		t.Fatalf("readFile: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	g, err := graph.Parse(string(data))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	c := dialEvents(t, base, "watcher")
	c.next(t, 2*time.Second) // hello

	if err := SaveLocalGraphFrom(g, "someone-else"); err != nil {
		t.Fatalf("save: %v", err)
	}
	c.expectNothing(t, 300*time.Millisecond)
}

// TestEventsMultipleSubscribers: every connected tab gets the change,
// and the fan-out doesn't serialize behind a slow reader.
func TestEventsMultipleSubscribers(t *testing.T) {
	base, _ := eventsServer(t, 30*time.Second)
	const n = 5
	clients := make([]*sseClient, n)
	for i := range clients {
		clients[i] = dialEvents(t, base, fmt.Sprintf("tab-%d", i))
		clients[i].next(t, 2*time.Second) // hello
	}

	mutate(t, "broadcast")

	var wg sync.WaitGroup
	for i, c := range clients {
		wg.Add(1)
		go func(i int, c *sseClient) {
			defer wg.Done()
			f := c.next(t, 3*time.Second)
			if f.event != "change" || f.data.Origin != OriginMCP {
				t.Errorf("client %d: got %s origin=%q", i, f.event, f.data.Origin)
			}
		}(i, c)
	}
	wg.Wait()
}

// TestEventsUnsubscribesOnClientDisconnect: a closed tab must not leak
// a goroutine, a connection, or a slot in the subscriber cap.
func TestEventsUnsubscribesOnClientDisconnect(t *testing.T) {
	base, _ := eventsServer(t, 30*time.Second)
	before := eventSubscriberCount()

	c := dialEvents(t, base, "ephemeral")
	c.next(t, 2*time.Second) // hello — proves the handler is in its loop
	if got := eventSubscriberCount(); got != before+1 {
		t.Fatalf("subscribers while connected = %d, want %d", got, before+1)
	}

	c.close()

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if eventSubscriberCount() == before {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("subscriber still registered %s after disconnect (count %d, want %d)",
		3*time.Second, eventSubscriberCount(), before)
}

// TestEventsSurvivesServerWriteTimeout pins the trap the whole route
// had to be designed around. cmd/flowgo arms ReadTimeout/WriteTimeout
// on the server (commit 2a24e8b) so the 0.0.0.0 surface can't be
// slowloris'd; for HTTP/1.x those become connection deadlines set when
// the request is read, which kills a long-lived event stream at the
// deadline WITHOUT the browser noticing — updates would just silently
// stop arriving after N seconds.
//
// The timeout here is deliberately shorter than the wait, so a
// regression (dropping the ResponseController deadline clearing)
// fails this test rather than shipping.
func TestEventsSurvivesServerWriteTimeout(t *testing.T) {
	const timeout = 300 * time.Millisecond
	base, _ := eventsServer(t, timeout)
	c := dialEvents(t, base, "patient-tab")
	c.next(t, 2*time.Second) // hello

	// Sit idle well past the server's write deadline.
	time.Sleep(4 * timeout)

	mutate(t, "after the deadline would have fired")

	f := c.next(t, 3*time.Second)
	if f.event != "change" {
		t.Fatalf("event = %q, want change — the stream died at WriteTimeout", f.event)
	}
}

// TestEventsRejectedInServeMode: serve mode is multi-tenant and has no
// single document, so there is no revision to stream.
func TestEventsRejectedInServeMode(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { Configure(orig) })
	Configure(Config{ServeMode: true, Workspaces: NewWorkspaceManager(time.Hour)})

	rec := httptest.NewRecorder()
	EventsHandler(rec, httptest.NewRequest(http.MethodGet, "/events", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("serve mode /events = %d, want 404", rec.Code)
	}
}

// TestEventsCapsSubscribers: /events is reachable by anyone on the
// bind address under --host, so the route must refuse rather than
// accumulate connections without bound.
func TestEventsCapsSubscribers(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { Configure(orig) })
	path := t.TempDir() + "/map.flowgo"
	if err := os.WriteFile(path, []byte(seedDoc), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	Configure(Config{LocalFile: path})

	var subs []*eventSub
	t.Cleanup(func() {
		for _, s := range subs {
			unsubscribeEvents(s)
		}
	})
	for len(subs) < maxEventSubscribers {
		s, _, ok := subscribeEvents("")
		if !ok {
			t.Fatalf("subscribe refused at %d, cap is %d", len(subs), maxEventSubscribers)
		}
		subs = append(subs, s)
	}

	rec := httptest.NewRecorder()
	EventsHandler(rec, httptest.NewRequest(http.MethodGet, "/events", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("over-cap /events = %d, want 503", rec.Code)
	}
}

// TestWatchLocalFileDetectsExternalEdit is user story 4: the file
// changes in vim (or a git checkout, or a second flowgo) and the open
// page finds out. The poller compares against the identity our own
// write path records, so this can only fire for someone else's write.
func TestWatchLocalFileDetectsExternalEdit(t *testing.T) {
	base, path := eventsServer(t, 30*time.Second)
	// Establish the identity baseline the poller compares against.
	if _, err := readFile(); err != nil {
		t.Fatalf("readFile: %v", err)
	}

	c := dialEvents(t, base, "tab")
	c.next(t, 2*time.Second) // hello

	stop := make(chan struct{})
	defer close(stop)
	go WatchLocalFile(20*time.Millisecond, stop)

	// Sleep past filesystem mtime granularity before writing so the
	// (mtime,size) comparison can't tie. The size changes too, which
	// is belt and braces.
	time.Sleep(30 * time.Millisecond)
	if err := os.WriteFile(path, []byte(seedDoc+"node b2 \"edited in vim\" 200 0\n"), 0644); err != nil {
		t.Fatalf("external write: %v", err)
	}

	f := c.next(t, 3*time.Second)
	if f.event != "change" || f.data.Origin != OriginFile {
		t.Fatalf("got %s origin=%q, want change origin=%q", f.event, f.data.Origin, OriginFile)
	}
}

// TestWatchLocalFileIgnoresOwnWrites: the poller must not fire for
// this process's own atomic temp+rename writes, or every save would
// broadcast twice — once correctly attributed, once as OriginFile
// with no session to suppress, which would bounce straight back at
// the tab that saved.
func TestWatchLocalFileIgnoresOwnWrites(t *testing.T) {
	base, _ := eventsServer(t, 30*time.Second)
	if _, err := readFile(); err != nil {
		t.Fatalf("readFile: %v", err)
	}

	c := dialEvents(t, base, "tab-mine")
	c.next(t, 2*time.Second) // hello

	stop := make(chan struct{})
	defer close(stop)
	go WatchLocalFile(20*time.Millisecond, stop)

	g := Graph{Maps: []NamedMap{{Path: "/", Boxes: []Box{{ID: "b1", Label: "mine"}}}}}
	if err := SaveLocalGraphFrom(g, "tab-mine"); err != nil {
		t.Fatalf("save: %v", err)
	}
	// SaveLocalGraph drops the cached graph but keeps the disk
	// identity, so the poller has a live baseline. Re-read the way the
	// browser would, then give the poller plenty of ticks.
	if _, err := readFile(); err != nil {
		t.Fatalf("readFile: %v", err)
	}
	c.expectNothing(t, 400*time.Millisecond)
}

// TestRevisionMonotonicPerRealChange: the counter is the client's
// only "am I current?" signal, so it must move exactly once per real
// change and never move for a no-op.
func TestRevisionMonotonicPerRealChange(t *testing.T) {
	orig := cfg
	t.Cleanup(func() { Configure(orig) })
	path := t.TempDir() + "/map.flowgo"
	if err := os.WriteFile(path, []byte(seedDoc), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	Configure(Config{LocalFile: path})

	start := Revision()
	mutate(t, "one")
	if got := Revision(); got != start+1 {
		t.Fatalf("after one mutation rev = %d, want %d", got, start+1)
	}
	mutate(t, "two")
	if got := Revision(); got != start+2 {
		t.Fatalf("after two mutations rev = %d, want %d", got, start+2)
	}

	g, err := readFile()
	if err != nil {
		t.Fatalf("readFile: %v", err)
	}
	if err := SaveLocalGraphFrom(g, "tab"); err != nil {
		t.Fatalf("save: %v", err)
	}
	if got := Revision(); got != start+2 {
		t.Fatalf("byte-identical save moved the revision to %d, want %d", got, start+2)
	}
}
