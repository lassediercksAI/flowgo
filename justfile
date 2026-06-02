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
dev file=default_file:
    @command -v docker >/dev/null || { echo "docker not found — install Docker"; exit 1; }
    FLOWGO_FILE="{{file}}" docker compose up --build

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
    pnpm exec vite build
    pnpm exec vite build --watch >/tmp/flowgo-vite.log 2>&1 &
    VITE_PID=$!
    GO_PID=
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
    # which silently restarts `go run` on the next tick.
    shutdown() {
        trap - INT TERM EXIT
        cleanup
        exit 130
    }
    trap cleanup EXIT
    trap shutdown INT TERM

    start_go() {
        [[ -n "${GO_PID}" ]] && kill "$GO_PID" 2>/dev/null || true
        wait "$GO_PID" 2>/dev/null || true
        echo "── restarting flowgo ──────────────────────────────────"
        # --host (bind 0.0.0.0) so the forwarded host port reaches us.
        # FLOWGO_NO_OPEN is baked into the image so the binary doesn't
        # try to xdg-open from a container that has no browser.
        go run ./cmd/flowgo "$file" --host &
        GO_PID=$!
        touch "$marker"
    }

    start_go
    while :; do
        sleep 0.5
        changed=0
        while IFS= read -r f; do
            if [[ "$f" -nt "$marker" ]]; then changed=1; break; fi
        done < <(find . \( -name '*.go' -o -path './pkg/flowgo/dist/index.html' \) -not -path './node_modules/*' 2>/dev/null)
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

# Type-check the TypeScript without emitting.
typecheck:
    pnpm exec tsc --noEmit
