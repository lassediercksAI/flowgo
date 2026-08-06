// Live document events for single-file (CLI) mode.
//
// The CLI serves the editor AND the MCP endpoint from one process, so
// an agent can rewrite the .flowgo file while a human has it open in a
// browser. Before this file existed the browser fetched /state exactly
// once, at page load, so every agent edit was invisible until a manual
// refresh — which defeats the point of `flowgo <file> --host`.
//
// The model here:
//
//   - A process-wide revision counter is bumped by the ONE choke point
//     every write already funnels through: persistLocalBytesLocked in
//     localfile.go. Both the editor's /save and every MCP mutation end
//     up there, so the counter cannot miss a change and cannot fire
//     for a change that didn't happen (that function skips
//     byte-identical writes, so a no-op save wakes nobody).
//
//     This is deliberately NOT filesystem watching. A watcher would
//     fire on our own writes, needs debouncing against atomic
//     temp+rename, and can't tell WHO wrote — all three of which the
//     in-process hook gets right for free. External edits are handled
//     separately and explicitly by WatchLocalFile below.
//
//   - Each change carries an origin. The browser mints a session id
//     per page and sends it on /save; MCP mutations carry OriginMCP.
//     A subscriber never receives an event it caused, so the editor's
//     own save can't bounce back as a full rebuild. Echo suppression
//     is by identity, never by timing.
//
//   - The payload is "revision N changed", never the document. The
//     client re-fetches /state, which keeps exactly one source of
//     truth for what the document is. Streaming the graph inline
//     would be a fine optimization and a second place for /state and
//     the wire format to drift apart.
//
// Transport is server-sent events (EventsHandler). One-way
// server→browser is all this needs — the browser already pushes
// through /save — and SSE is plain HTTP with reconnection built into
// the browser's EventSource, so there's no dependency, no handshake,
// and no proxy negotiation to get wrong.

package flowgo

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Origins that aren't a browser session. Editor sessions use their own
// opaque id (see the X-Flowgo-Session header on /save), so these two
// are the only reserved values.
const (
	// OriginMCP marks a write made by an agent through the MCP
	// endpoint — the case this whole file exists for.
	OriginMCP = "mcp"
	// OriginFile marks a change made to the .flowgo outside this
	// process (vim, git checkout, another flowgo), detected by
	// WatchLocalFile.
	OriginFile = "file"
)

const (
	// eventQueueDepth is 1 on purpose. Events are idempotent "go
	// re-read /state" pokes, so a queued event is fully superseded by
	// a newer one; a depth-1 slot plus coalescing (see bumpRevision)
	// means a slow client converges on the latest revision instead of
	// replaying a backlog it would collapse anyway.
	eventQueueDepth = 1

	// maxEventSubscribers bounds the goroutines + connections this
	// route can pin. --host binds 0.0.0.0 by design, so an
	// unauthenticated LAN client could otherwise open streams until
	// the process runs out of file descriptors. Real use is one tab,
	// occasionally a handful.
	maxEventSubscribers = 64

	// eventPingInterval keeps intermediaries (and any future reverse
	// proxy) from reaping an idle stream, and gives the server a
	// periodic write that fails fast when the peer has vanished
	// without a FIN.
	eventPingInterval = 20 * time.Second
)

// changeEvent is the SSE `data:` payload. Rev is monotonic for the
// lifetime of the process; Origin is empty on the hello event.
type changeEvent struct {
	Rev    uint64 `json:"rev"`
	Origin string `json:"origin,omitempty"`
}

// eventSub is one connected client. session is the browser's
// X-Flowgo-Session value (empty for anything that didn't send one),
// used to suppress self-echo at the source rather than at the client.
type eventSub struct {
	session string
	ch      chan changeEvent
}

var liveEvents = struct {
	mu   sync.Mutex
	rev  uint64
	subs map[*eventSub]struct{}
}{subs: map[*eventSub]struct{}{}}

// Revision reports the current document revision. It starts at 0 and
// increases by one per write that actually changed the file's bytes.
// Served on /state and /save as X-Flowgo-Revision so a client knows
// where it stands without waiting for the next event.
func Revision() uint64 {
	liveEvents.mu.Lock()
	defer liveEvents.mu.Unlock()
	return liveEvents.rev
}

// bumpRevision records a change and fans it out. Callers hold
// cfg.LocalFileMu (the write path) — every send below is
// non-blocking, so a stalled reader can never hold the file lock.
func bumpRevision(origin string) uint64 {
	liveEvents.mu.Lock()
	defer liveEvents.mu.Unlock()
	liveEvents.rev++
	ev := changeEvent{Rev: liveEvents.rev, Origin: origin}
	for s := range liveEvents.subs {
		// Never hand a session its own write back. This is the whole
		// of echo suppression: the editor saves, the file changes,
		// every OTHER tab hears about it, and the tab that did it
		// carries on without a rebuild or a flicker.
		if origin != "" && s.session == origin {
			continue
		}
		select {
		case s.ch <- ev:
		default:
			// Slot full: drop the stale event and queue this one. The
			// newest revision strictly supersedes anything waiting,
			// so coalescing loses nothing (see eventQueueDepth).
			select {
			case <-s.ch:
			default:
			}
			select {
			case s.ch <- ev:
			default:
			}
		}
	}
	return liveEvents.rev
}

// subscribeEvents registers a client. The returned bool is false when
// the subscriber cap is already reached; callers should refuse the
// request rather than serve a stream nobody is tracking.
func subscribeEvents(session string) (*eventSub, uint64, bool) {
	liveEvents.mu.Lock()
	defer liveEvents.mu.Unlock()
	if len(liveEvents.subs) >= maxEventSubscribers {
		return nil, liveEvents.rev, false
	}
	s := &eventSub{session: session, ch: make(chan changeEvent, eventQueueDepth)}
	liveEvents.subs[s] = struct{}{}
	return s, liveEvents.rev, true
}

func unsubscribeEvents(s *eventSub) {
	liveEvents.mu.Lock()
	defer liveEvents.mu.Unlock()
	delete(liveEvents.subs, s)
}

// eventSubscriberCount is the in-package hook the teardown test uses
// to prove a disconnected client is actually unregistered.
func eventSubscriberCount() int {
	liveEvents.mu.Lock()
	defer liveEvents.mu.Unlock()
	return len(liveEvents.subs)
}

// EventsHandler streams document-change notifications as server-sent
// events. Mount it at GET /events in single-file mode.
//
// Wire format:
//
//	event: hello
//	data: {"rev":12}
//
//	event: change
//	id: 13
//	data: {"rev":13,"origin":"mcp"}
//
//	: ping
//
// The hello event is the reconnect story: EventSource reconnects on
// its own, and hello tells the client where the document stands right
// now, so a client that was offline while an agent edited catches up
// on the next successful connect instead of waiting for the agent's
// next write.
//
// Note the exposure: /events tells anyone who can reach the bind
// address THAT the map changed (never what changed — the payload is a
// counter). That is strictly less than /state already gives them, and
// --host is unauthenticated on 0.0.0.0 by design, but it is one more
// read-only channel on that surface.
func EventsHandler(w http.ResponseWriter, r *http.Request) {
	if cfg.ServeMode || cfg.LocalFile == "" {
		// Serve mode is multi-tenant and has no single document to
		// have a revision of. Nothing to stream.
		http.Error(w, "live events are only available in single-file mode", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// THE trap on this route. cmd/flowgo sets WriteTimeout (and
	// ReadTimeout) on the server so slow/idle clients can't pin
	// connections on the 0.0.0.0 surface — but for HTTP/1.x those are
	// implemented as connection deadlines armed when the request is
	// read, which means a long-lived text/event-stream is killed at
	// the deadline. The failure mode is nasty: the page keeps its
	// EventSource, the stream silently stops delivering, and updates
	// just quietly stop arriving.
	//
	// ResponseController clears both deadlines for THIS connection
	// only, leaving the server-wide protection in place for every
	// other route. The errors are ignored deliberately: on a
	// ResponseWriter that doesn't support deadlines (httptest's
	// recorder) there is no deadline to clear either.
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Time{})
	_ = rc.SetReadDeadline(time.Time{})

	sub, rev, ok := subscribeEvents(r.URL.Query().Get("session"))
	if !ok {
		http.Error(w, "too many live-event subscribers", http.StatusServiceUnavailable)
		return
	}
	defer unsubscribeEvents(sub)

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-store, no-transform")
	h.Set("Connection", "keep-alive")
	// Belt and braces for any reverse proxy in front of us (nginx and
	// friends buffer responses by default, which turns an event
	// stream into a stream that arrives all at once, at the end).
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if !writeSSE(w, flusher, "hello", 0, changeEvent{Rev: rev}) {
		return
	}

	ping := time.NewTicker(eventPingInterval)
	defer ping.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			// Client hung up (tab closed, navigated, network died).
			// The deferred unsubscribe is the only cleanup needed —
			// nothing else holds a reference to sub.
			return
		case ev := <-sub.ch:
			if !writeSSE(w, flusher, "change", ev.Rev, ev) {
				return
			}
		case <-ping.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeSSE emits one event frame and flushes it. Returns false when
// the connection is gone, which is the handler's cue to unwind.
func writeSSE(w io.Writer, f http.Flusher, name string, id uint64, payload changeEvent) bool {
	body, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	var b strings.Builder
	b.WriteString("event: ")
	b.WriteString(name)
	b.WriteString("\n")
	if id > 0 {
		fmt.Fprintf(&b, "id: %d\n", id)
	}
	b.WriteString("data: ")
	b.Write(body)
	b.WriteString("\n\n")
	if _, err := io.WriteString(w, b.String()); err != nil {
		return false
	}
	f.Flush()
	return true
}

// WatchLocalFile polls cfg.LocalFile and bumps the revision when the
// bytes changed underneath this process — someone editing the .flowgo
// in vim, a git checkout, a second flowgo on the same file. Run it as
// a goroutine from the CLI; it returns when stop is closed.
//
// This is a poller, not an fsnotify watcher, on purpose: the only
// question being asked is the one localfile.go's cache already asks on
// every access ("is the (mtime,size) we recorded still what's on
// disk?"), so reusing that record means our own atomic temp+rename
// writes can never be mistaken for an external edit. One stat per
// second costs nothing next to being wrong about who wrote.
func WatchLocalFile(interval time.Duration, stop <-chan struct{}) {
	if interval <= 0 {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			checkExternalChange()
		}
	}
}

// checkExternalChange compares the file's live stat against the
// identity localfile.go recorded on the last read or write.
//
// A mismatch means someone else wrote, so the cached parse is dropped
// and the revision bumped; the client's resulting /state fetch
// re-parses and re-arms this check. When nothing is recorded yet
// (fresh process, or the cache was just invalidated) there's no
// baseline to compare against and we wait — the next read establishes
// one.
func checkExternalChange() {
	if cfg.ServeMode || cfg.LocalFile == "" || cfg.LocalFileMu == nil {
		return
	}
	cfg.LocalFileMu.Lock()
	defer cfg.LocalFileMu.Unlock()
	c := &localFile
	if !c.diskKnown || c.path != cfg.LocalFile {
		return
	}
	fi, err := os.Stat(cfg.LocalFile)
	if err != nil {
		// Deleted or unreadable: not a content change we can describe,
		// and the next read will surface the real error to the client.
		return
	}
	if fi.Size() == c.size && fi.ModTime().Equal(c.modTime) {
		return
	}
	resetLocalCacheLocked()
	bumpRevision(OriginFile)
}
