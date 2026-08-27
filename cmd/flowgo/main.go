// Package main is the public flowgo CLI. It composes the
// pkg/flowgo library with a small flag parser, browser launcher, and
// version reporter; everything substantive lives in the library so
// downstream consumers can wire flowgo onto their own HTTP mux
// without copying code.
package main

import (
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lassediercks/flowgo/pkg/flowgo"
	"github.com/lassediercks/flowgo/pkg/graph"
)

// version is overwritten at release-build time via:
//
//	go build -ldflags "-X main.version=<tag>" ./cmd/flowgo
//
// `go install ...@<tag>` also surfaces the module version via
// runtime/debug, which resolveVersionString falls back on.
var version = "dev"

var (
	fileMu   sync.Mutex
	filePath string
	mediaMu  sync.Mutex
)

// mediaDirName is the sibling folder (next to the .flowgo file) that
// holds pasted/dropped image assets. It's also the URL prefix the
// editor references images by, so the on-disk layout and the relative
// `src` in the .flowgo file line up.
const mediaDirName = "flowgo-media"

// mediaExtByType maps accepted image content-types to the file
// extension used for content-addressed storage. Anything not listed is
// rejected — we don't want to write arbitrary uploaded bytes to disk.
//
// SVG is deliberately NOT accepted. Stored as image/svg+xml and
// re-served byte-for-byte, an uploaded SVG can carry a <script> or an
// onload handler that executes in this server's origin the moment a
// browser is pointed at the raw asset URL (a direct link/share, an
// <object>/<iframe> embed, or any other non-<img> consumer — <img>
// itself disables SVG scripting by spec, but nothing here controls
// how the URL this endpoint hands back gets used later). There's no
// hand-maintained sanitizer in front of it, so the only safe answer is
// not to store SVG at all.
var mediaExtByType = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// mediaTypeByExt is the reverse map, used to set Content-Type when
// serving a stored asset back.
var mediaTypeByExt = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
}

func mediaDir() string {
	return filepath.Join(filepath.Dir(filePath), mediaDirName)
}

// dirSize sums the sizes of the regular files directly in dir (the
// media folder is flat — no subdirs). A missing dir is 0, not an error.
func dirSize(dir string) (int64, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		total += info.Size()
	}
	return total, nil
}

func main() {
	if len(os.Args) < 2 {
		printUsage(os.Stderr)
		os.Exit(1)
	}
	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
		return
	case "upgrade":
		runUpgrade(os.Args[2:])
		return
	}
	bindHost := "127.0.0.1"
	useRandomName := false
	hexagonMode := false
	presetName := ""
	var positional []string
	// Index-based loop because --preset consumes the following token
	// as its value.
	for i := 1; i < len(os.Args); i++ {
		a := os.Args[i]
		switch a {
		case "version", "-v", "--version":
			printVersion(os.Stdout)
			return
		case "help", "-h", "--help":
			printUsage(os.Stdout)
			return
		case "new":
			useRandomName = true
		case "--host":
			bindHost = "0.0.0.0"
		case "--hexagon":
			hexagonMode = true
		case "--preset":
			if i+1 >= len(os.Args) {
				die("--preset needs a name (available: %s)", strings.Join(flowgo.PresetNames(), ", "))
			}
			i++
			presetName = os.Args[i]
			if _, ok := flowgo.Preset(presetName); !ok {
				die("unknown preset %q (available: %s)", presetName, strings.Join(flowgo.PresetNames(), ", "))
			}
		default:
			if strings.HasPrefix(a, "-") {
				fmt.Fprintf(os.Stderr, "unknown flag: %s\n", a)
				os.Exit(1)
			}
			positional = append(positional, a)
		}
	}
	switch {
	case useRandomName:
		filePath = randomMapName() + ".flowgo"
		for i := 0; i < 5; i++ {
			if _, err := os.Stat(filePath); os.IsNotExist(err) {
				break
			}
			filePath = randomMapName() + ".flowgo"
		}
	case len(positional) >= 1:
		filePath = positional[0]
		if !strings.HasSuffix(filePath, ".flowgo") {
			filePath += ".flowgo"
		}
	default:
		printUsage(os.Stderr)
		os.Exit(1)
	}

	createdFile := false
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		var seed string
		if presetName != "" {
			s, err := presetSeed(presetName, resolveVersionString())
			if err != nil {
				die("preset %s: %v", presetName, err)
			}
			seed = s
		} else {
			seed = graph.Serialize(graph.Graph{
				Version: resolveVersionString(),
				Maps: []graph.NamedMap{{
					Path:  "/",
					Boxes: []graph.Box{{ID: "b1", Label: seedBoxLabel(filePath)}},
				}},
			})
		}
		if err := flowgo.AtomicWriteFile(filePath, []byte(seed)); err != nil {
			die("create file: %v", err)
		}
		createdFile = true
	} else if presetName != "" {
		// A preset is a seed, not a merge — silently ignoring it on an
		// existing map would surprise; refusing keeps the contract
		// crisp: presets apply to NEW maps only.
		die("%s already exists — --preset only applies to new maps", filePath)
	}
	if createdFile {
		if presetName != "" {
			fmt.Printf("initialised %s from preset %s\n", filePath, presetName)
		} else {
			fmt.Printf("initialised the flowgo interface on a new file %s\n", filePath)
		}
	}

	// --hexagon seeds the FILE's default shape (the `defaultshape 1`
	// directive): double-click creates hexagons in this map, wherever
	// it opens. This replaced the old browser-preference injection
	// (window.FLOWGO_HEXAGON) — the flag now writes through to the
	// document, once, and only upgrades a rectangle default so it
	// can't clobber an explicit circle/triangle choice.
	if hexagonMode {
		data, err := os.ReadFile(filePath)
		if err != nil {
			die("--hexagon: read %s: %v", filePath, err)
		}
		g, err := graph.Parse(string(data))
		if err != nil {
			die("--hexagon: parse %s: %v", filePath, err)
		}
		if g.DefaultShape == 0 {
			g.DefaultShape = 1
			g.Version = resolveVersionString()
			if err := flowgo.AtomicWriteFile(filePath, []byte(graph.Serialize(g))); err != nil {
				die("--hexagon: write %s: %v", filePath, err)
			}
			fmt.Printf("default shape of %s set to hexagon (defaultshape 1)\n", filePath)
		}
	}

	// Opening an existing file normalizes it to the current format:
	// legacy directive spellings (box/boxsize/boxshape → node forms)
	// and legacy settings (`hexagons on` → `defaultshape 1`) are
	// rewritten once, up front, so every later save diffs cleanly
	// against a canonical baseline. A file that fails to parse is left
	// byte-for-byte untouched — same behaviour the editor would hit on
	// /state, just surfaced earlier and without bricking the map.
	if !createdFile {
		migrated, err := migrateFileToCurrentFormat(filePath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: %s not migrated: %v\n", filePath, err)
		} else if migrated {
			fmt.Printf("migrated %s to the current format (box→node / defaultshape)\n", filePath)
		}
	}

	flowgo.Configure(flowgo.Config{
		ServeMode:   false,
		LocalFile:   filePath,
		LocalFileMu: &fileMu,
		Version:     resolveVersionString,
	})

	// The editor bundle is shared with the hosted service, which has no
	// /events route (it uses the yrs collab sidecar instead). So the
	// live-event client is OFF unless a server opts in by injecting
	// this flag — otherwise flowgo-map.com opens an EventSource to a
	// 404 and retries forever behind a "lost the live connection"
	// banner. Only this CLI --host server serves /events today.
	editorHTML := injectLiveFlag([]byte(flowgo.IndexHTML))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// No-store: the editor bundle is embedded at build time, so a
		// browser that heuristically caches this page (no cache headers
		// = cache at the browser's discretion) keeps serving the OLD
		// editor after the binary is upgraded or the dev loop restarts
		// — new features then look broken until a hard reload. The
		// page is served from memory; re-sending it costs nothing.
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(editorHTML)
	})
	http.HandleFunc("/state", handleState)
	http.HandleFunc("/save", handleSave)
	http.HandleFunc("/media", handleMediaUpload)
	http.HandleFunc("/"+mediaDirName+"/", handleMediaGet)
	http.HandleFunc("/version", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, resolveVersionString())
	})
	http.HandleFunc("/mcp", flowgo.MCPHandler)
	// Live document events (brain#250). An agent editing over /mcp
	// while a human has the map open used to be invisible until a
	// manual refresh; this is the channel that tells the open page a
	// new revision exists. See pkg/flowgo/events.go — including why
	// the route has to defuse the server WriteTimeout set below.
	http.HandleFunc("/events", flowgo.EventsHandler)

	// Walk forward from the canonical port so a second flowgo (or any
	// process holding 54041) doesn't fail to start. Range is bounded to
	// keep collisions visible in URLs rather than scattering across
	// ephemeral space.
	ln, err := listenFirstFree(bindHost, 54041, 54099)
	if err != nil {
		die("listen on %s:54041-54099: %v", bindHost, err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	displayHost := bindHost
	if bindHost == "0.0.0.0" {
		if lan := pickLanIP(); lan != "" {
			displayHost = lan
		}
	}
	// FLOWGO_DISPLAY_HOST overrides the host portion of the printed
	// URL without affecting where the server actually binds. Useful
	// when the LAN IP picked from inside a container is the Docker
	// bridge address (e.g. 192.168.165.2) — unreachable from the
	// host — and the dev image wants to point users at the
	// port-forwarded "localhost" instead.
	if v := os.Getenv("FLOWGO_DISPLAY_HOST"); v != "" {
		displayHost = v
	}
	url := fmt.Sprintf("http://%s:%d", displayHost, addr.Port)
	fmt.Printf("flowgo editing %s\n  GUI: %s\n  MCP: %s/mcp\n  live: agent + external edits appear in the open page without a refresh\n", filePath, url, url)
	if bindHost == "127.0.0.1" && os.Getenv("FLOWGO_NO_OPEN") == "" {
		openBrowser(url)
	} else if bindHost != "127.0.0.1" && !isLocalhostHost(displayHost) {
		fmt.Printf("  (also reachable on http://localhost:%d from this machine)\n", addr.Port)
	}
	maybeNotifyNewVersion()
	// Editing the .flowgo in vim/another tool while flowgo runs already
	// worked (the parsed-file cache re-reads on an (mtime,size) change)
	// — but nothing ASKED, so an open browser never found out. This
	// poller asks once a second and bumps the live revision when the
	// bytes moved under us. Own writes are excluded by construction:
	// the comparison is against the identity our own write path
	// recorded. See flowgo.WatchLocalFile.
	go flowgo.WatchLocalFile(externalWatchInterval, nil)
	// Timeouts matter once --host exposes this on 0.0.0.0: the zero-value
	// http.Server has no read deadline, so slow/idle clients (slowloris)
	// pin a goroutine + connection indefinitely and exhaust the host.
	// Handler nil uses DefaultServeMux, where the routes above registered.
	srv := &http.Server{
		Handler:           nil,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	if err := srv.Serve(ln); err != nil {
		die("serve: %v", err)
	}
}

// isLocalhostHost reports whether the display host is one of the
// loopback aliases the "(also reachable on localhost…)" hint would
// just repeat. Keeps the redundant line suppressed when callers set
// FLOWGO_DISPLAY_HOST to any of localhost / 127.0.0.1 / ::1.
func isLocalhostHost(h string) bool {
	switch h {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// pickLanIP returns a usable IPv4 from this host's interfaces, preferring
// RFC 1918 private ranges (10/8, 172.16/12, 192.168/16) over any other
// non-loopback IPv4. Empty string when nothing usable is reachable —
// callers should fall back to bindHost in that case.
func pickLanIP() string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return ""
	}
	return pickLanIPFromAddrs(addrs)
}

func pickLanIPFromAddrs(addrs []net.Addr) string {
	var fallback string
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil {
			continue
		}
		if ip4.IsLoopback() || ip4.IsLinkLocalUnicast() || ip4.IsUnspecified() {
			continue
		}
		if ip4.IsPrivate() {
			return ip4.String()
		}
		if fallback == "" {
			fallback = ip4.String()
		}
	}
	return fallback
}

// listenFirstFree tries each port in [start, end] on host and returns the
// first listener that binds successfully.
//
// The range is validated up front rather than discovered a port at a
// time (brain#24b). Without the guard the loop misbehaves at both ends:
// an empty range (start > end) returned (nil, nil), so the caller's
// ln.Addr() panicked on a nil listener; start <= 0 asked the kernel for
// port 0, which binds a random ephemeral port *outside* the requested
// range; and an end above 65535 walked ports that cannot exist, so a
// full range surfaced "address 65551: invalid port" instead of saying
// the range was exhausted.
func listenFirstFree(host string, start, end int) (net.Listener, error) {
	if start < 1 || end > 65535 || start > end {
		return nil, fmt.Errorf("invalid port range %d-%d: want 1 <= start <= end <= 65535", start, end)
	}
	var lastErr error
	for port := start; port <= end; port++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err == nil {
			return ln, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// handleState serves the parsed document as JSON. The read goes
// through the library's cached store (which locks fileMu itself, via
// Config.LocalFileMu): the file is only re-read and re-parsed when its
// mtime/size changed since the last access, so repeated loads of a
// large map don't pay the full parse each time.
func handleState(w http.ResponseWriter, r *http.Request) {
	g, err := flowgo.LocalGraph()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// The revision these bytes correspond to. The editor records it so
	// the live stream's hello event can tell it whether it slept
	// through a change (see pkg/flowgo/events.go).
	w.Header().Set(revisionHeader, strconv.FormatUint(flowgo.Revision(), 10))
	// Capability advertisement (brain#25c): the editor only compresses
	// save bodies after seeing this — the shared bundle also talks to
	// servers that predate gzip support, and a blind gzip POST to one
	// of those is a 400 (see feedback-shared-bundle-blast-radius).
	w.Header().Set("X-Flowgo-Accept-Encoding", "gzip")
	// Delta capability (brain#25c, same advertisement pattern as gzip
	// above): the editor only sends `X-Flowgo-Save: delta1` bodies to
	// a server that announced it here — the shared bundle also talks
	// to servers that don't speak deltas, and those must keep seeing
	// plain full-document saves.
	w.Header().Set(flowgo.SaveModeHeader, flowgo.SaveModeDelta1)
	json.NewEncoder(w).Encode(g)
}

// revisionHeader carries the document revision on /state and /save.
// sessionHeader carries the editor's per-page session id on /save, so
// the live-events stream can skip echoing a change back to the tab
// that made it.
const (
	revisionHeader = "X-Flowgo-Revision"
	sessionHeader  = "X-Flowgo-Session"
)

// externalWatchInterval is how often the CLI stats the .flowgo looking
// for edits made outside this process. One second is well under the
// "did that appear yet?" threshold and is a single stat call.
const externalWatchInterval = time.Second

// handleSave persists the editor's full-document payload. Version
// stamping and the atomic write (temp+rename — a crash mid-save can
// never truncate the map) live in flowgo.SaveLocalGraph, which also
// takes fileMu via Config.LocalFileMu.
// saveBodyReader returns the request body ready for JSON decoding,
// transparently gunzipping when the editor sent Content-Encoding:
// gzip (brain#25c: full-document bodies compress ~8.7x, and the
// hosted server's byte cap made large maps unsaveable — compression
// is the stopgap until the delta protocol lands). The byte limit is
// enforced on the DECOMPRESSED stream: capping the wire bytes would
// bound the upload, not the memory the decode then holds.
func saveBodyReader(w http.ResponseWriter, r *http.Request, limit int64) (io.Reader, error) {
	if r.Header.Get("Content-Encoding") != "gzip" {
		r.Body = http.MaxBytesReader(w, r.Body, limit)
		return r.Body, nil
	}
	gz, err := gzip.NewReader(r.Body)
	if err != nil {
		return nil, err
	}
	return io.LimitReader(gz, limit), nil
}

func handleSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	// Cap the body: json.Decode on an unbounded reader lets any client on
	// the bind address (0.0.0.0 with --host) drive the process to OOM with
	// one large POST — the decode holds the whole document, then serialize
	// + atomic-write hold more copies. maxSaveBytes is generous for real
	// maps (the largest fixtures are <200 KiB) while keeping RAM bounded.
	body, err := saveBodyReader(w, r, maxSaveBytes)
	if err != nil {
		http.Error(w, "bad gzip body: "+err.Error(), 400)
		return
	}
	// Save-mode dispatch (brain#25c). No header = full document, the
	// path below, byte-for-byte as it always was. `delta1` = delta
	// body. Any OTHER value is refused rather than treated as a full
	// save: decoding a delta-shaped body as a Graph silently yields an
	// EMPTY document (encoding/json ignores unknown fields), and
	// "saving" that would wipe the map — so an unknown mode fails
	// closed, and the client's non-2xx fallback resends without the
	// header.
	switch mode := r.Header.Get(flowgo.SaveModeHeader); mode {
	case "":
		// full-document save, unchanged below
	case flowgo.SaveModeDelta1:
		handleDeltaSave(w, r, body)
		return
	default:
		http.Error(w, "unsupported save mode: "+mode, 400)
		return
	}
	var g graph.Graph
	if err := json.NewDecoder(body).Decode(&g); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	// The editor stamps its per-page session id on every save. It rides
	// down to the live-events fan-out, which skips the session that
	// caused the change — that's what stops a tab reloading its own
	// edit back over itself. An absent header just means "anonymous
	// writer": everyone hears about it, which is the safe default.
	if err := flowgo.SaveLocalGraphFrom(g, r.Header.Get(sessionHeader)); err != nil {
		// A rejected payload is the client's fault, not the disk's —
		// SaveLocalGraph refuses graphs whose ids or labels can't be
		// written down without corrupting the file.
		if errors.Is(err, flowgo.ErrInvalidGraph) {
			http.Error(w, err.Error(), 400)
			return
		}
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set(revisionHeader, strconv.FormatUint(flowgo.Revision(), 10))
	w.WriteHeader(204)
}

// handleDeltaSave applies an `X-Flowgo-Save: delta1` body (brain#25c).
// body is already gzip-transparent and byte-capped by saveBodyReader.
//
// Status contract (the client treats any non-2xx as fall-back-to-
// full-save): 409 = revision conflict or no document to apply against
// — resend as a full save, which cannot conflict; 400 = malformed
// delta or a result that cannot be written to a .flowgo file; 204 =
// applied, with the new revision echoed exactly like a full save so
// the client can base its next delta on it without another /state
// round trip.
func handleDeltaSave(w http.ResponseWriter, r *http.Request, body io.Reader) {
	var d flowgo.Delta
	if err := json.NewDecoder(body).Decode(&d); err != nil {
		http.Error(w, "bad delta body: "+err.Error(), 400)
		return
	}
	// The base-revision request header is the canonical contract (the
	// hosted server reads ONLY it, as an opaque token) and wins over
	// the body's `base` when present. Here the token space is this
	// process's numeric revision counter; a token that doesn't parse
	// is from some other server's regime and can never match — that
	// is a base conflict, and 409 steers the client to the full save
	// that fixes it, exactly like any stale base.
	if h := r.Header.Get(flowgo.BaseRevisionHeader); h != "" {
		n, err := strconv.ParseUint(h, 10, 64)
		if err != nil {
			w.WriteHeader(409)
			return
		}
		d.Base = n
	}
	rev, err := flowgo.ApplyLocalDeltaFrom(d, r.Header.Get(sessionHeader))
	switch {
	case err == nil:
	case errors.Is(err, flowgo.ErrDeltaConflict):
		// Deliberately bodyless: the one reaction to 409 is a full
		// save, and the client needs no prose to decide that.
		w.WriteHeader(409)
		return
	case errors.Is(err, flowgo.ErrDeltaInvalid), errors.Is(err, flowgo.ErrInvalidGraph):
		http.Error(w, err.Error(), 400)
		return
	default:
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set(revisionHeader, strconv.FormatUint(rev, 10))
	w.WriteHeader(204)
}

// maxMediaBytes caps a single uploaded asset. Images beyond this are
// rejected rather than silently written — a mind-map isn't a photo
// library, and huge inlined assets bloat the working directory.
const maxMediaBytes = 25 << 20 // 25 MiB

// maxSaveBytes caps the /save request body. A .flowgo document is text;
// even a very large hand-built map is a few MiB. The cap exists to stop
// an unauthenticated LAN client (the --host case) from OOMing the host
// with a single oversized POST, not to constrain real use.
const maxSaveBytes = 32 << 20 // 32 MiB

// maxMediaDirBytes caps the total on-disk size of the flowgo-media/
// folder. Uploads are content-addressed (dedup'd), but distinct bytes
// each write a new, never-collected file — without a ceiling a LAN
// client can fill the disk 25 MiB at a time. When the folder is already
// at/over the cap, further uploads are refused.
const maxMediaDirBytes = 512 << 20 // 512 MiB

// contentAddressHexLen is how many hex characters of the sha256 digest
// name a stored asset by (32 hex chars = 128 bits). Short enough to
// keep filenames readable, long enough that collisions between two
// DIFFERENT uploads (which would silently serve one visitor's image
// under a URL an attacker chose the bytes for) aren't a practical
// concern — the previous 16-char/64-bit truncation left a birthday
// bound low enough to be worth tightening even though nothing here
// currently depends on the name being unguessable.
const contentAddressHexLen = 32

// handleMediaUpload accepts a raw image body and writes it into the
// flowgo-media/ folder under a content-addressed name:
// sha256(bytes)[:contentAddressHexLen] + ext. Identical uploads
// collapse to one file (dedup). Responds {"src":"flowgo-media/<name>"}
// — the relative path the editor stores in the .flowgo file.
//
// The stored type is decided from the ACTUAL BYTES (http.
// DetectContentType), never the client-supplied Content-Type header:
// a client can label any bytes however it likes, and honouring that
// label would let mislabeled content (most importantly an SVG-with-
// <script> declared as image/png) land on disk and later be served
// back under an extension/Content-Type that doesn't match what it
// actually is.
func handleMediaUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", 405)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxMediaBytes)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusRequestEntityTooLarge)
		return
	}
	if len(data) == 0 {
		http.Error(w, "empty body", 400)
		return
	}
	sniffed := http.DetectContentType(data)
	// DetectContentType appends "; charset=..." for text-ish types
	// (which is exactly how SVG bytes come back — text/xml or
	// text/plain — since it has no magic-byte signature of its own);
	// strip that before the map lookup.
	if i := strings.IndexByte(sniffed, ';'); i >= 0 {
		sniffed = strings.TrimSpace(sniffed[:i])
	}
	ext, ok := mediaExtByType[sniffed]
	if !ok {
		http.Error(w, "unsupported image type: "+sniffed, http.StatusUnsupportedMediaType)
		return
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:])[:contentAddressHexLen] + ext

	mediaMu.Lock()
	defer mediaMu.Unlock()
	dir := mediaDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		http.Error(w, "mkdir media: "+err.Error(), 500)
		return
	}
	dst := filepath.Join(dir, name)
	if _, err := os.Stat(dst); os.IsNotExist(err) {
		// New (non-dedup) asset: refuse if the folder is already at its
		// ceiling, so a LAN client can't fill the disk one upload at a
		// time. Dedup hits (dst exists) skip this — they add no bytes.
		used, err := dirSize(dir)
		if err != nil {
			http.Error(w, "stat media dir: "+err.Error(), 500)
			return
		}
		if used+int64(len(data)) > maxMediaDirBytes {
			http.Error(w, "media storage full", http.StatusInsufficientStorage)
			return
		}
		if err := os.WriteFile(dst, data, 0644); err != nil {
			http.Error(w, "write media: "+err.Error(), 500)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"src": mediaDirName + "/" + name})
}

// handleMediaGet serves a stored asset. The filename is sanitized to a
// bare base name so a crafted path (../, absolute, nested) can't escape
// the media folder.
func handleMediaGet(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/"+mediaDirName+"/")
	// Reject anything that isn't a simple filename living directly in
	// the media folder — no separators, no traversal, no empties.
	if rest == "" || rest != filepath.Base(rest) || strings.Contains(rest, "..") {
		http.Error(w, "bad media path", 400)
		return
	}
	full := filepath.Join(mediaDir(), rest)
	f, err := os.Open(full)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	if ct, ok := mediaTypeByExt[strings.ToLower(filepath.Ext(rest))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	// Content-addressed names are immutable, so caching is safe and cheap.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeContent(w, r, rest, info.ModTime(), f)
}

// migrateFileToCurrentFormat parses the file and, when its canonical
// serialization differs from the bytes on disk (legacy box/boxsize/
// boxshape spellings, `hexagons on`, formatting drift), rewrites it
// once with the current binary's version stamped. Returns whether a
// rewrite happened. Runs before the HTTP server starts, so no file
// mutex is needed (mirrors the --hexagon seeding block above).
func migrateFileToCurrentFormat(path string) (bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	g, err := graph.Parse(string(data))
	if err != nil {
		return false, err
	}
	if graph.Serialize(g) == string(data) {
		return false, nil
	}
	// Rewriting anyway — stamp the writer honestly, exactly like a
	// normal /save would. Atomic (temp+rename) so a crash during the
	// one-shot migration can't leave a half-rewritten map.
	g.Version = resolveVersionString()
	if err := flowgo.AtomicWriteFile(path, []byte(graph.Serialize(g))); err != nil {
		return false, err
	}
	return true, nil
}

// presetSeed renders the named embedded preset as the initial file
// content for a new map: parse (so a malformed preset fails loudly
// here, not with a broken editor), stamp the running binary's version
// over whatever version the preset was authored with, and re-serialize
// so the on-disk file is byte-normal for this binary.
func presetSeed(name, version string) (string, error) {
	raw, ok := flowgo.Preset(name)
	if !ok {
		return "", fmt.Errorf("unknown preset")
	}
	g, err := graph.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("embedded preset failed to parse: %v", err)
	}
	g.Version = version
	return graph.Serialize(g), nil
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func die(format string, a ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", a...)
	os.Exit(1)
}

func printUsage(w *os.File) {
	fmt.Fprintf(w, `flowgo — browser-based mind-map editor backed by a plain-text file.

Usage:
  flowgo <file.flowgo>             open the editor (binds 127.0.0.1 only)
  flowgo <name>                    open <name>.flowgo, creating it if missing
  flowgo new                       create a map with a random humanized name (e.g. solid_frontend.flowgo)
  flowgo <name|new> --host         bind 0.0.0.0 (reach from outside this machine/container)
  flowgo <name|new> --hexagon      set the FILE's default shape to hexagon (defaultshape 1):
                                   double-click adds fixed-size, edge-snapping hexagons
  flowgo <name|new> --preset <p>   seed a NEW map from an embedded preset (errors if the
                                   file already exists). Available: %s
  flowgo serve [flags]             public mode: multi-workspace MCP + share-via-webhook
                                   (run 'flowgo serve --help' for flags)
  flowgo upgrade                   download the latest release and replace this binary
  flowgo version                   print version info
  flowgo help                      show this message
`, strings.Join(flowgo.PresetNames(), ", "))
}

func resolveVersionString() string {
	if version != "dev" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		if v := info.Main.Version; v != "" && v != "(devel)" {
			return strings.TrimPrefix(v, "v")
		}
	}
	return "dev"
}

func compactVersion() string {
	v := version
	var rev string
	dirty := false
	if info, ok := debug.ReadBuildInfo(); ok {
		if v == "dev" && info.Main.Version != "" && info.Main.Version != "(devel)" {
			v = info.Main.Version
		}
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				if len(s.Value) > 12 {
					rev = s.Value[:12]
				} else {
					rev = s.Value
				}
			case "vcs.modified":
				if s.Value == "true" {
					dirty = true
				}
			}
		}
	}
	if rev == "" {
		return v
	}
	suffix := ""
	if dirty {
		suffix = "+dirty"
	}
	return v + " (" + rev + suffix + ")"
}

func printVersion(w *os.File) {
	v := resolveVersionString()
	var rev, when string
	modified := ""
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, s := range info.Settings {
			switch s.Key {
			case "vcs.revision":
				rev = s.Value
			case "vcs.time":
				when = s.Value
			case "vcs.modified":
				if s.Value == "true" {
					modified = "+dirty"
				}
			}
		}
	}
	fmt.Fprintf(w, "flowgo %s", v)
	if rev != "" {
		short := rev
		if len(short) > 12 {
			short = short[:12]
		}
		fmt.Fprintf(w, " (%s%s", short, modified)
		if when != "" {
			fmt.Fprintf(w, ", %s", when)
		}
		fmt.Fprintf(w, ")")
	}
	fmt.Fprintln(w)
}
