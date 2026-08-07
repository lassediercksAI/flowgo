#!/usr/bin/env bash
# Fail if the committed editor bundle is stale.
#
#   scripts/check-dist-fresh.sh     (run AFTER `pnpm build`)
#
# pkg/flowgo/dist/index.html is build output that is also committed,
# because pkg/flowgo/state.go embeds it with //go:embed — `go build`
# has to work without a node toolchain. Nothing kept the committed copy
# honest: ci.yml used to run
#
#     git diff --exit-code -- dist/index.html
#
# against a path that has not existed since the bundle moved under
# pkg/flowgo/. git treats an unmatched pathspec as an empty diff, so the
# step exited 0 forever and the gate silently did nothing (brain#273).
#
# The sibling repo's copy of the same artifact drifted months stale
# under exactly that non-gate — 194 KB committed against a 271 KB fresh
# build of the already-pinned version, missing 0.3.14's edge labels.
# Nobody noticed because its Docker build regenerates the file, so
# production was always correct and only local `go build` saw the rot.
# The same masking applies here: `just dev` rebuilds the bundle, so a
# stale committed copy only ever bites someone who builds without it.
#
# The bundle is byte-reproducible — verified identical across node 20
# and node 25, macOS-arm64, linux/amd64 and linux/arm64 — so a plain
# byte comparison is a safe gate and will not flake.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

dist=pkg/flowgo/dist/index.html

# Guard against the original bug: if the artifact moves again, this
# must fail loudly rather than quietly pass on a path that no longer
# resolves. Both conditions matter — the file has to exist on disk AND
# be tracked, or "no diff" means "nothing to diff", not "up to date".
if [ ! -f "$dist" ]; then
    echo "ERROR: $dist does not exist. Did the vite outDir move, or was 'pnpm build' skipped?" >&2
    echo "       If the artifact moved, update \$dist in $0 — a check aimed at a" >&2
    echo "       dead path passes silently, which is the exact bug this script exists for." >&2
    exit 1
fi
if ! git ls-files --error-unmatch "$dist" >/dev/null 2>&1; then
    echo "ERROR: $dist is not tracked by git, so there is nothing to compare against." >&2
    echo "       Either it moved (update \$dist in $0) or it was removed from the index." >&2
    exit 1
fi

if git diff --quiet -- "$dist"; then
    echo "✓ $dist is up to date with src/editor/"
    exit 0
fi

committed=$(git show "HEAD:$dist" | wc -c | tr -d ' ')
rebuilt=$(wc -c < "$dist" | tr -d ' ')

cat >&2 <<EOF
╭──────────────────────────────────────────────────────────────────────╮
│ STALE COMMITTED BUILD ARTIFACT                                       │
╰──────────────────────────────────────────────────────────────────────╯

$dist does not match a fresh build of src/editor/.

    committed: $committed bytes
    rebuilt:   $rebuilt bytes

To fix, run this and commit the result:

    pnpm build        (or: just build-frontend)

THIS IS NOT HARMLESS, even if everything you tried worked fine.

The bundle is regenerated on the fly by the paths most people exercise
— \`just dev\` runs \`vite build --watch\`, and downstream flowgo-website
rebuilds it from source inside Docker on every image build. So a stale
committed copy breaks nothing you are likely to look at, and produces
no user-visible symptom at all.

What it does break is \`go build\` / \`go run\` without a frontend build
first: that embeds whatever bytes are committed here. Stale bytes mean
you are running a months-old editor while believing you are running
current source, with nothing to tell you the two differ. That is
exactly how the downstream copy of this artifact reached 194 KB against
a 271 KB fresh build, silently missing a whole release's features
(brain#273). Regenerate it in the same PR as the source change.
EOF
exit 1
