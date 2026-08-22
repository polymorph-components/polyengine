# The orchestration surface: repo-wide recipes here, the CI job bodies in
# .github/justfile (the `gha` module) — each CI job runs exactly one
# `gha::` recipe, so `just ci` is exactly CI. Recipe bodies are the exact
# commands (AGENTS.md "Gates" maps onto them 1:1); comments that used to
# live on workflow steps live on the recipes now.

mod gha '.github'

default:
    @just --list

# The canary lanes are findings-only crons (`gha::canary`, `gha::canary-arm`).
# Exactly the CI jobs: the required `core` matrix + the post-merge `browser` job.
ci: (gha::core) (gha::browser)

# Includes the consumer smokes CI cannot run (they need the polymorph
# checkouts; docs/consumers.md).
# The full pre-commit pass (AGENTS.md "Gates"): everything.
gates: build test-rust test-protocol test-runtime test-wasi test-sockets-node test-ct-runner test-bundle publish-check test-npm examples test-translate conformance sched-seeds shells browsers smoke-tls smoke-c0

# Fast sanity: builds + native tests + type-checks, no suites.
check: build test-rust
    cd protocol && deno task check
    cd runtime && deno task check
    cd wasi && deno task check
    cd ct-runner && deno task check

# ----- builders ---------------------------------------------------------------

build:
    cargo build --workspace

# The translator shim wasm: every Deno suite below loads this artifact.
# Size-tuned (S0's figures: ~1.8 MB raw / ~0.5 MB gzip, vs 3.8 MB stock
# release): the shim is a shipped asset (issue #16), so the wasm build opts
# into z/lto/abort via scoped env vars — the workspace [profile.release]
# stays stock so testgen/bindgen keep fast builds and fast corpus runs.
# Semantics are untouched (same crate, same deps); the conformance gate is
# the check that matters and runs on this artifact.
shim:
    CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
    CARGO_PROFILE_RELEASE_LTO=fat \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_PANIC=abort \
    CARGO_PROFILE_RELEASE_STRIP=symbols \
    cargo build -p translator-shim --target wasm32-unknown-unknown --release
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm translator/translator_shim.wasm

# wasmtime CLI is optional in build.sh (smoke run only when present).
# Guest fixture components (examples/guests/build/, gitignored): the
# runtime e2e suites and ct-runner's fixture tests need them.
fixtures:
    ./examples/build.sh

# The consumer-facing embedder examples (examples/README.md): build each
# guest component and run its self-checking host. These double as living
# documentation of the embedder API — CI runs them so they cannot rot.
examples: shim
    ./examples/hello-world/run.sh
    ./examples/kitchen-sink/run.sh

# Build-time translation CLI (tools/translate, embedder-api A4): translate
# to an envelope, reconstitute artifacts without a translator, verify the
# mismatched-pair refusal.
test-translate: shim
    deno test --allow-read --allow-write=/tmp --allow-run tools/translate/translate_test.ts
    cd translator && deno task check && deno task test

# Rehearsal finding: 20 runtime e2e tests self-skip when it is absent —
# generation must precede the runtime suite (318/0/3 with; 298/0/23 without).
# The conformance corpus (harness/generated/).
corpus:
    cd harness && deno task gen

# ----- core suites ------------------------------------------------------------

test-rust:
    cargo test -p translator-shim -p bindgen -p testgen

test-runtime: shim fixtures corpus
    cd runtime && deno task check && deno task test

# The brand vocabulary (contracts/embedder-api.md amendment A9): dependency-
# free, so this is the one Deno suite that needs no build artifacts at all.
test-protocol:
    cd protocol && deno task test

test-wasi:
    cd wasi && deno task test

# The sockets fragment on REAL pinned Node (the whole test-wasi
# suite exercises the same node-builtins backend under Deno's node-compat;
# this lane covers the genuine platform). `deno bundle` resolves the
# workspace imports into one self-contained ESM file; tests/dist/ is
# gitignored.
test-sockets-node:
    deno run -A tools/shell/fetch.ts node-pinned
    deno bundle --platform browser --format esm -o wasi/tests/dist/node_smoke.mjs wasi/tests/node_smoke.ts
    .shell-cache/node-pinned/bin/node wasi/tests/dist/node_smoke.mjs

test-ct-runner: shim fixtures
    cd ct-runner && deno task test

# The embedder-bundle release-asset gate (polyengine-embedder.mjs:
# build + shape checks for tools/release-bundle/entry.ts).
# `dual_copy_test.ts` rides here because the bundle IS the second runtime copy
# (amendment A9 / issue #83): it is the only way to get two genuinely distinct
# copies in one process — query-string cache-busting does not, since relative
# imports below the entry resolve to the same cached modules.
test-bundle: shim
    deno test -A tools/release-bundle/

# The JSR publish checks (public-API type check, slow types, export and
# import analyzability, config validation) — `deno task check` covers
# none of them, so they only fired at publish time on main before this
# gate. Needs the shim: @polyengine/translator ships translator_shim.wasm
# (statically imported by shim_asset_deno.ts). Registry-side failures
# (scope auth, version conflicts) still only manifest on a real publish.
# --allow-dirty because this is a PRE-commit gate (the dirty check
# protects uploads; there is no upload here).
# JSR publish verification, no upload (`deno publish --dry-run`).
publish-check: shim
    deno publish --dry-run --allow-dirty

# The npm distribution of the five JSR packages (tools/npm-build/build.ts).
# Needs the shim: @polyengine/translator carries translator_shim.wasm as a
# packaged asset on the npm side too. Output is gitignored.
npm-build: shim
    deno run -A tools/npm-build/build.ts

# The npm distribution's gate: pack the built packages, install them as a
# consumer would, then run the pipeline for real (translate + instantiate a
# guest) and type-check the SHIPPED .d.ts from outside. Catches what
# `publish-check` cannot — npm `exports` subpaths, dependency edges, tarball
# file lists — and above all pins the single-copy property: cross-package
# imports must be npm dependencies, never inlined source (embedder-api A9).
# Runs under the PINNED Node (tools/shell/pins.json), like test-sockets-node.
test-npm: npm-build fixtures
    deno run -A tools/shell/fetch.ts node-pinned
    .shell-cache/node-pinned/bin/node tools/npm-build/smoke.mjs
    # Stamp-path leg: a throwaway build with `--version` proves the
    # prerelease stamp (release.yml's pre-<shorthash> path) hits the
    # lockstep four exactly while leaving protocol on its own manifest
    # version (A10). No packing/install — fast. Output goes under
    # .shell-cache, never the repo's npm/ dir, and is removed after.
    rm -rf .shell-cache/npm-stamp-check
    deno run -A tools/npm-build/build.ts --version 9.9.9-pre.gtest --out .shell-cache/npm-stamp-check
    deno run -A tools/npm-build/stamp_check.ts .shell-cache/npm-stamp-check 9.9.9-pre.gtest
    rm -rf .shell-cache/npm-stamp-check

# The harness task chains corpus generation and the shim check itself.
# The official CM conformance suite, Deno lane.
conformance:
    cd harness && deno task conformance

# Scheduler-order sensitivity (docs/architecture.md §6) — spec-allowed
# nondeterminism; FIFO when POLYENGINE_SCHED_SEED is unset.
# The affected suites re-run under seeded-shuffle scheduling.
sched-seeds: shim fixtures corpus
    cd runtime && POLYENGINE_SCHED_SEED=1 deno task test
    cd runtime && POLYENGINE_SCHED_SEED=4242 deno task test
    cd harness && POLYENGINE_SCHED_SEED=1 deno task conformance

# ----- engine lanes -----------------------------------------------------------

# Pinned lanes (sm-pinned, jsc-pinned) are required gates — a deviation
# exits 1; sha256-verified fetches (tools/shell/pins.json). Nightly/trunk
# lanes (sm-nightly, jsc-trunk) are findings-only — exit 0 even with
# deviations; 2 is reserved for infrastructure failure.
# One engine-shell lane: fetch (cached), then run.
shell-lane lane *args: shim corpus
    deno run -A tools/shell/fetch.ts {{lane}}
    deno run -A tools/shell/run-lane.ts {{lane}} {{args}}

# JSC has no arm64 channel (jsc-built-products is x86_64-only), so its
# lane guards on the arch and skips cleanly elsewhere. node/bun publish
# both linux arches, so those lanes run everywhere; bun-pinned is
# findings-only (expectation carries `required: false` — deviations print
# and exit 0, only infrastructure failures gate) until it has a track
# record, then promote.
# The per-push pinned shell gates: sm-pinned + node-pinned (+ bun-pinned,
# findings-only) everywhere; jsc-pinned on x64.
shells:
    just shell-lane sm-pinned
    @if [ "$(uname -m)" = "x86_64" ]; then just shell-lane jsc-pinned; else echo "jsc-pinned: skipped (no arm64 channel)"; fi
    just shell-lane node-pinned
    just shell-lane bun-pinned

# The Deno canary probe (V8-trailing-edge d8-lane substitute; findings-only).
deno-canary *args:
    deno run -A tools/shell/deno-canary.ts {{args}}

# The repo-local cache is what run-lane.ts expects
# (PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache — cache THAT path in CI,
# not ~/.cache/ms-playwright). CI passes --with-deps for system
# libraries; locally a plain `just browsers-install` usually suffices.
# One-time browser provisioning (chromium + firefox) into .browser-cache/.
browsers-install *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} chromium firefox

# WebKit stays non-blocking until it has a track record (issue #11): the
# lane's expectation overlay encodes JSC's missing multi-memory, and GH's
# ubuntu-24.04 matches the ABI playwright's WebKit wants (no library
# staging expected).
browsers-install-webkit *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} webkit

# chromium and firefox are required (chromium expects exact Deno-lane
# parity; the firefox driver sets the JSPI pref itself — shipped-channel
# config, unlike the jsshell); webkit is best-effort per
# docs/architecture.md §3/§12 (issue #11).
# One browser lane (chromium / firefox / webkit).
browser-lane lane *args: shim corpus
    deno run -A tools/browser/run-lane.ts {{lane}} {{args}}

# The post-merge browser gates. The worker / shared-worker rows (issue
# #129) run the SAME corpus / battery inside those realms, judged against
# the SAME per-engine expectations: any delta at all is a realm leak (a
# Window-only dependency creeping into the runtime), and the failure names
# the realm. The first consumer topology (polyvisor G5) hosts the engine
# in a shared worker, so those rows gate here rather than surfacing as a
# consumer-side mystery.
browsers:
    just browser-lane chromium
    just browser-lane chromium --realm worker
    just browser-lane chromium --realm shared-worker
    just browser-lane firefox
    just browser-lane firefox --realm worker
    just browser-lane firefox --realm shared-worker
    just smoke-opfs chromium
    just smoke-opfs chromium --realm worker
    just smoke-opfs chromium --realm shared-worker
    just smoke-opfs firefox
    just smoke-opfs firefox --realm worker
    just smoke-opfs firefox --realm shared-worker

# filesystem-web against the REAL Origin Private File System (the unit
# suite runs an in-memory fake — Deno has no navigator.storage): the
# direct descriptor battery plus the fs-probe guest parking through
# A14/JSPI over real async storage. tools/browser/opfs-smoke.ts.
# `--realm worker|shared-worker` (issue #129) runs the battery inside that
# realm — the OPFS × JSPI-parking × worker-realm intersection the first
# consumer (polyvisor G5) actually ships.
smoke-opfs lane *args: shim fixtures
    deno run -A tools/browser/opfs-smoke.ts {{lane}} {{args}}

# ----- consumer smokes + exams (polymorph checkouts; docs/consumers.md) -------

# Translate all eight targets, then execute the suites.
# polymorph-tls conformance under polyengine (issue #18).
# (--allow-env: tools/smoke-c0/common.ts reads POLYMORPH_ROOT at module
# scope since the wosh rename; the leg tasks always had it via deno task.)
smoke-tls: shim
    deno run --allow-read --allow-env=POLYMORPH_ROOT,WOSH_ROOT tools/smoke-tls/run.ts --exec

# The C0 smoke legs (tools/smoke-c0/REPORT.md).
smoke-c0: shim
    cd tools/smoke-c0 && deno task leg1 && deno task leg2 && deno task leg3 && deno task leg4

# The host-boundary microbench (bench/boundary/README.md): calls/sec per
# ABI shape for the CURRENT tree, on plain node (callback + jspi) and
# deno. Manual instrument, not a gate — numbers are box-relative; the
# committed README carries the baseline and the issues it feeds (#8,
# #54; #17's record). `just bench-boundary with-jco` adds the incumbent
# jco lane (npm tree + transpile, prepared on first use).
bench-boundary *jco: shim
    #!/usr/bin/env bash
    set -euo pipefail
    (cd bench/boundary/guest && cargo build --release --target wasm32-wasip2)
    deno run -A tools/release-bundle/build.ts --out bench/boundary/polyengine-embedder.local.mjs
    if [ "{{jco}}" = "with-jco" ]; then
        cd bench/boundary
        [ -d node_modules ] || npm ci --no-audit --no-fund
        node jco-transpile.mjs transpile guest/target/wasm32-wasip2/release/boundary_bench_guest.wasm \
            --name bench -I async -o generated
        cd ../..
        node bench/boundary/sweep.mjs polyengine-embedder.local.mjs \
            ../../target/wasm32-unknown-unknown/release/translator_shim.wasm --with-jco
    else
        node bench/boundary/sweep.mjs polyengine-embedder.local.mjs \
            ../../target/wasm32-unknown-unknown/release/translator_shim.wasm
    fi


# ----- release ----------------------------------------------------------------

# The standard shim (what every suite runs against), the size-tuned
# variant (flags per crates/translator-shim/README.md — reproduces the
# published size figures without editing the workspace manifest), the
# embedder bundle, and SHA256SUMS — all written to the repo root. NOTE:
# the size-tuned build leaves the MIN shim in target/; rerun `just shim`
# before running test suites locally afterwards.
# The release artifacts, exactly as the release workflow publishes them.
# Since the shim recipe adopted the size tuning (#58), the tuned build IS
# the artifact every suite runs against, and the former separate "min"
# variant is redundant — one shim, tested and shipped identically.
release-artifacts: shim
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm polyengine-translator-shim.wasm
    deno run -A tools/release-bundle/build.ts --out polyengine-embedder.mjs
    sha256sum polyengine-translator-shim.wasm polyengine-embedder.mjs > SHA256SUMS
