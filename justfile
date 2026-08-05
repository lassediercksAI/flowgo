# Dev tasks for flowgo.
#
# `just dev`  — runs the whole dev stack inside Docker (vite --watch
#               and a polling-restart for the Go server). The host
#               only needs `docker` and `just` — no local go / pnpm.
#               Source is bind-mounted from the repo; node_modules and
#               the pnpm + go caches live in named volumes (see
#               Dockerfile.dev + compose.yaml).
#
#               The container binds 0.0.0.0 and the whole port walk
#               54041–54099 is forwarded to the host, so whichever
#               port flowgo grabs is reachable at http://localhost:<port>
#               (printed on first start).
#
#               File-ownership note: on Linux, dist/index.html and any
#               other files written by the container are root-owned.
#               If that's a problem locally, run
#                 sudo chown -R $(id -u):$(id -g) pkg/flowgo/dist
#               after the container exits.
#
# `just hexagon` — same as `just dev` but the served editor starts
#               with the hexagon setting on (double-click adds
#               fixed-size, edge-snapping hexagons; see --hexagon).
#
# `just build` / `just test` / `just typecheck` still run on the host
# and need local pnpm + go. To run them inside the dev container
# instead, use `docker compose exec dev just <target>`.
#
# Requires (for `just dev`): docker.
# Requires (for build / test / typecheck on host): pnpm, go.

set shell := ["bash", "-cu"]

default_file := "map.flowgo"

default: dev

# Run the dev stack (vite --watch + go poll-restart) inside Docker.
# Detects the host's LAN IP and hands it to the container as
# FLOWGO_DISPLAY_HOST so the URL the server prints is reachable from
# other devices on the network (a phone, another machine), not just
# this box. Docker already publishes the forwarded ports on 0.0.0.0, so
# the LAN route works — only the advertised hostname needed fixing.
# Falls back to localhost when no LAN IP can be found.
dev file=default_file:
    #!/usr/bin/env bash
    set -euo pipefail
    command -v docker >/dev/null || { echo "docker not found — install Docker"; exit 1; }
    lan_ip=""
    # macOS: ipconfig getifaddr on the usual interfaces.
    if command -v ipconfig >/dev/null 2>&1; then
        for ifc in en0 en1 en2; do
            if lan_ip=$(ipconfig getifaddr "$ifc" 2>/dev/null) && [[ -n "$lan_ip" ]]; then break; fi
        done
    fi
    # Linux: first address from `hostname -I`.
    if [[ -z "$lan_ip" ]] && command -v hostname >/dev/null 2>&1; then
        lan_ip=$(hostname -I 2>/dev/null | awk '{print $1}') || true
    fi
    # Linux fallback: source address on the default route.
    if [[ -z "$lan_ip" ]] && command -v ip >/dev/null 2>&1; then
        lan_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}') || true
    fi
    if [[ -n "$lan_ip" ]]; then
        echo "── LAN-reachable: the server will advertise http://$lan_ip:<port> ──"
    else
        lan_ip=localhost
        echo "── no LAN IP found — advertising localhost only ──"
    fi
    FLOWGO_FILE="{{file}}" FLOWGO_DISPLAY_HOST="$lan_ip" FLOWGO_HEXAGON="${FLOWGO_HEXAGON:-}" docker compose up --build

# Re-enters `dev` with FLOWGO_HEXAGON exported so the LAN-IP detection
# and compose wiring stay in one place.
# Dev stack with the hexagon setting on (double-click adds hexagons).
hexagon file=default_file:
    FLOWGO_HEXAGON=1 just dev "{{file}}"

# Stop the dev container and free its forwarded ports.
dev-down:
    docker compose down

# Internal: the vite --watch + go polling-restart loop. Intended to run
# INSIDE the dev container (`docker compose up` invokes it as the
# service command). The file to open is passed via the FLOWGO_FILE
# env, set from the host's `just dev <file>` invocation.
_dev-inside:
    #!/usr/bin/env bash
    set -euo pipefail
    file="${FLOWGO_FILE:-map.flowgo}"
    # Platform-aware install: Docker compose's first-create behaviour
    # for a named volume layered on a bind mount can carry the host's
    # macOS-arm64 node_modules into the Linux container, where `pnpm
    # install` then sees node_modules as "up to date" and skips
    # fetching the platform-correct native bindings (rolldown, esbuild,
    # …). Stamping a sentinel with the current OS+arch lets us detect
    # a mismatch and reinstall from scratch. With the pnpm store on a
    # named volume, the rebuild is a hardlink pass — fast.
    sentinel=node_modules/.installed-platform
    want="$(uname -s)-$(uname -m)"
    if [[ ! -f "$sentinel" || "$(cat "$sentinel" 2>/dev/null)" != "$want" ]]; then
        echo "── installing node_modules for $want (sentinel: $(cat "$sentinel" 2>/dev/null || echo none)) ──"
        # `node_modules` itself is the named-volume mount point and
        # can't be unlinked — empty its contents instead, mount stays.
        find node_modules -mindepth 1 -delete 2>/dev/null || true
        pnpm install
        echo "$want" > "$sentinel"
    fi
    # Single vite source for dist/index.html. We deliberately don't
    # run a one-shot `vite build` first because `vite build --watch`
    # already does an initial build — running both touched the file
    # twice and tripped the polling loop into a spurious restart of
    # the server immediately after the first start.
    pnpm exec vite build --watch >/tmp/flowgo-vite.log 2>&1 &
    VITE_PID=$!
    GO_PID=
    BIN=/tmp/flowgo-dev
    dist=pkg/flowgo/dist/index.html
    # Touch a marker after each successful start; on each tick check
    # whether any *.go or dist/index.html is newer than the marker.
    # `-nt` is portable across bash on macOS (BSD) and Linux (GNU).
    marker=$(mktemp -t flowgo-dev.XXXXXX)
    cleanup() {
        [[ -n "${GO_PID}" ]] && kill "$GO_PID" 2>/dev/null || true
        [[ -n "${VITE_PID}" ]] && kill "$VITE_PID" 2>/dev/null || true
        GO_PID=
        VITE_PID=
        [[ -n "${marker}" ]] && rm -f "$marker" || true
    }
    # Trap EXIT for normal exits; trap INT/TERM separately and exit
    # explicitly so Ctrl+C (forwarded by tini as SIGTERM to PID 1)
    # tears down the polling loop. Without the explicit `exit`, bash
    # runs the handler and then resumes after the interrupted `sleep`,
    # which silently restarts the server on the next tick.
    shutdown() {
        trap - INT TERM EXIT
        cleanup
        exit 130
    }
    trap cleanup EXIT
    trap shutdown INT TERM

    # Wait for vite to produce the first dist before launching the
    # Go binary, so the embedded asset exists at compile time. Also
    # wait for its mtime to stop moving — `vite build --watch` can
    # touch dist/index.html more than once during its initial pass
    # (esp. under CHOKIDAR_USEPOLLING), and starting the loop while
    # vite is still writing trips a spurious restart right after the
    # first build.
    echo "── waiting for vite to produce $dist ──"
    while [[ ! -f "$dist" ]]; do sleep 0.2; done
    prev=""
    while :; do
        cur=$(stat -c %Y "$dist" 2>/dev/null || echo "")
        # If stat failed (e.g. file racy-deleted), treat it as still
        # writing — never exit on an empty cur, even when prev is
        # also "" (the initial state), or we'd race past vite's
        # initial build.
        if [[ -z "$cur" ]]; then
            sleep 1.5
            continue
        fi
        if [[ "$cur" == "$prev" ]]; then break; fi
        prev=$cur
        sleep 1.5
    done

    # Build + exec the binary directly. We used to use `go run`, but
    # `go run` builds then forks the actual server as a child —
    # `kill $GO_PID` only reaches the wrapper, leaving the server
    # orphaned and holding port 54041. The next restart then picks
    # 54042 (next free) and you end up with two flowgos running.
    # Building and exec'ing keeps $GO_PID the server's own PID.
    start_go() {
        if [[ -n "${GO_PID}" ]]; then
            kill "$GO_PID" 2>/dev/null || true
            wait "$GO_PID" 2>/dev/null || true
            GO_PID=
        fi
        echo "── building flowgo ────────────────────────────────────"
        if ! go build -o "$BIN" ./cmd/flowgo; then
            echo "── go build failed — leaving previous server (if any) ──"
            return
        fi
        echo "── restarting flowgo ──────────────────────────────────"
        # --host (bind 0.0.0.0) so the forwarded host port reaches us.
        # --hexagon when the host invoked `just hexagon` (flag travels
        # via the FLOWGO_HEXAGON env through compose).
        # FLOWGO_NO_OPEN is baked into the image so the binary doesn't
        # try to xdg-open from a container that has no browser.
        flags=(--host)
        [[ "${FLOWGO_HEXAGON:-}" == "1" ]] && flags+=(--hexagon)
        "$BIN" "$file" "${flags[@]}" &
        GO_PID=$!
        touch "$marker"
    }

    start_go
    while :; do
        sleep 0.5
        changed=0
        while IFS= read -r f; do
            if [[ "$f" -nt "$marker" ]]; then changed=1; break; fi
        done < <(find . \( -name '*.go' -o -path "./$dist" \) -not -path './node_modules/*' 2>/dev/null)
        (( changed )) && start_go
    done

# One-shot frontend build (writes pkg/flowgo/dist/index.html that the library embeds).
build-frontend:
    pnpm install --silent
    pnpm exec vite build

# Build the Go binary with the freshly built frontend embedded.
build: build-frontend
    go build -o flowgo ./cmd/flowgo

# Run both test suites.
test:
    pnpm exec vitest run
    go test ./...

# Perf smoke benchmark (brain #23d): drives the editor render module
# on synthetic stress maps in jsdom and gates on machine-independent
# DOM-operation counts (element creations, selector queries, class
# toggles). Prints a report with informational wall-clock numbers.
# Same suite CI runs; see src/editor/perf/.
perf:
    pnpm exec vitest run --config vitest.perf.config.ts

# Write a synthetic stress map as a .flowgo file for manual
# in-browser profiling (`flowgo stress.flowgo` + devtools):
#   just perf-fixture                      → stress.flowgo, 3400 boxes
#   just perf-fixture big.flowgo 10000     → big.flowgo, 10k boxes
perf-fixture out="stress.flowgo" boxes="3400":
    FLOWGO_PERF_FIXTURE_OUT="{{out}}" FLOWGO_PERF_FIXTURE_BOXES="{{boxes}}" \
        pnpm exec vitest run --config vitest.perf.config.ts fixture-write

# Type-check the TypeScript without emitting.
typecheck:
    pnpm exec tsc --noEmit
