# Repo-wide recipes; .github/justfile composes the CI job bodies as `gha::` recipes.

mod gha '.github'

default:
    @just --list

# CI suites: required core matrix and post-merge browser job; excludes canaries.
ci: (gha::core) (gha::browser)

# Full pre-commit gates, including local consumer smokes (docs/consumers.md).
gates: version-guard-local fmt-check build test-rust test-protocol test-runtime test-wasi test-sockets-node test-ct-runner test-bundle test-version-guard publish-check test-npm examples test-translate conformance sched-seeds shells browsers smoke-tls smoke-c0

# Fast sanity: builds + native tests + type-checks, no suites.
check: fmt-check build test-rust
    cd protocol && deno task check
    cd runtime && deno task check
    cd wasi && deno task check
    cd ct-runner && deno task check

# Runtime formatting; generated files are excluded by runtime/deno.json.
fmt-check:
    cd runtime && deno fmt --check

# ----- builders ---------------------------------------------------------------

build:
    cargo build --workspace

# The workspace release profile stays unchanged for native testgen/bindgen builds.
# Build the tested/shipped translator wasm with size tuning scoped to this build.
shim:
    CARGO_PROFILE_RELEASE_OPT_LEVEL=z \
    CARGO_PROFILE_RELEASE_LTO=fat \
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
    CARGO_PROFILE_RELEASE_PANIC=abort \
    CARGO_PROFILE_RELEASE_STRIP=symbols \
    cargo build -p translator-shim --target wasm32-unknown-unknown --release
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm translator/translator_shim.wasm

# Guest components for runtime/ct-runner tests; optional wasmtime smoke when installed.
fixtures:
    ./examples/build.sh

# Build guest components and run the self-checking embedder examples.
examples: shim
    ./examples/hello-world/run.sh
    ./examples/kitchen-sink/run.sh

# Translation CLI/package tests: envelope loading and mismatched-pair refusal.
test-translate: shim
    deno test --allow-read --allow-write=/tmp --allow-run tools/translate/translate_test.ts
    cd translator && deno task check && deno task test

# Generate harness/generated/ before runtime tests, which otherwise skip corpus cases.
corpus:
    cd harness && deno task gen

# ----- core suites ------------------------------------------------------------

test-rust:
    cargo test -p translator-shim -p bindgen -p testgen
    # Drift check: wasmtime-environ, wit-parser, and testgen's wast must stay
    # on the same wasm-tools release train (docs/architecture.md §4.1, §9).
    dupes=$(cargo tree -e normal -p translator-shim -p bindgen -p testgen --prefix none \
        | grep -E '^(wasmparser|wit-parser|wasm-encoder|wast) v' | awk '{print $1, $2}' | sort -u \
        | awk '{print $1}' | sort | uniq -d); \
    if [ -n "$dupes" ]; then \
        echo "drift: multiple versions found for: $dupes" >&2; \
        exit 1; \
    fi

test-runtime: shim fixtures corpus
    cd runtime && deno task check && deno task test

# Golden update rules: runtime/tests/conventions/support.ts and contracts/embedder-api.md.
# Focused host-ABI golden suite (also included in test-runtime).
test-conventions: shim fixtures
    cd runtime && deno test --allow-read=..,/tmp --allow-write=/tmp --allow-env=POLYENGINE_SCHED_SEED tests/conventions/

# Protocol vocabulary tests; no build artifacts required.
test-protocol:
    cd protocol && deno task test

test-wasi:
    cd wasi && deno task test

# Sockets on pinned Node, complementing test-wasi's Deno node-compat coverage.
test-sockets-node:
    deno run -A tools/shell/fetch.ts node-pinned
    deno bundle --platform browser --format esm -o wasi/tests/dist/node_smoke.mjs wasi/tests/node_smoke.ts
    .shell-cache/node-pinned/bin/node wasi/tests/dist/node_smoke.mjs

test-ct-runner: shim fixtures
    cd ct-runner && deno task test

# Bundling creates a distinct runtime graph; entry query strings share dependencies.
# Release-bundle shape, execution and cross-copy tests.
test-bundle: shim
    deno test -A tools/release-bundle/

# Version-guard unit tests with injected effects; no network or repository state.
test-version-guard:
    deno test -A tools/version-guard/

# Uses git tags or JSR for the last cut, without GitHub/PR context or env access.
# Checks lockstep, monotonicity and published protocol bytes; goldens are advisory.
# Label-free working-tree version checks.
version-guard-local:
    deno run --allow-net=jsr.io --allow-run --allow-read=. tools/version-guard/check.ts local

# Live labels can change after CI without rerunning it; release checks remain necessary.
# --allow-run stays broad in both guard recipes: Deno rejects allowlisted spawns
# when dynamic-linker environment variables such as LD_LIBRARY_PATH are set.
# PR version/label checks; no-op without PR_NUMBER.
version-guard-pr:
    deno run --allow-net=jsr.io --allow-run --allow-read=. --allow-env tools/version-guard/check.ts pr

# Auth/version conflicts require real publishing; --allow-dirty allows pre-commit checks.
# JSR package/type/export validation without upload.
publish-check: shim
    deno publish --dry-run --allow-dirty

# Build npm packages, including the translator wasm asset; output is gitignored.
npm-build: shim
    deno run -A tools/npm-build/build.ts

# Cross-package imports must stay dependencies, not inlined copies.
# Test npm package exports, declarations and guest execution on pinned Node.
test-npm: npm-build fixtures
    deno run -A tools/shell/fetch.ts node-pinned
    .shell-cache/node-pinned/bin/node tools/npm-build/smoke.mjs
    # Verify --version stamps only the lockstep four, not protocol; no install.
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

# Bun is findings-only (required: false); infrastructure failures still gate.
# Pinned shell lanes: SpiderMonkey/Node on both Linux arches, JSC on x64 only, plus Bun.
shells:
    just shell-lane sm-pinned
    @if [ "$(uname -m)" = "x86_64" ]; then just shell-lane jsc-pinned; else echo "jsc-pinned: skipped (no arm64 channel)"; fi
    just shell-lane node-pinned
    just shell-lane bun-pinned

# The Deno canary probe (V8-trailing-edge d8-lane substitute; findings-only).
deno-canary *args:
    deno run -A tools/shell/deno-canary.ts {{args}}

# CI adds --with-deps for system libraries.
# Provision Chromium/Firefox in .browser-cache/, the lane driver's default.
browsers-install *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} chromium firefox

# Provision best-effort WebKit; its bundled Linux libraries target Ubuntu 24.04.
browsers-install-webkit *flags:
    PLAYWRIGHT_BROWSERS_PATH=$PWD/.browser-cache deno run -A npm:playwright@1.62.1 install {{flags}} webkit

# Expectations: harness/browser/expectations/; launch.ts enables Firefox's JSPI pref.
# One browser lane: Chromium/Firefox required, WebKit best-effort.
browser-lane lane *args: shim corpus
    deno run -A tools/browser/run-lane.ts {{lane}} {{args}}

# All realms use the same per-engine expectations to detect realm-specific failures.
# Browser conformance and OPFS gates across page, worker and shared-worker realms.
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

# --realm worker|shared-worker selects a worker instead of the default page.
# Real OPFS: descriptor tests and fs-probe guest I/O through the JSPI parking kernel.
smoke-opfs lane *args: shim fixtures
    deno run -A tools/browser/opfs-smoke.ts {{lane}} {{args}}

# ----- consumer smokes + exams (polymorph checkouts; docs/consumers.md) -------

# Translate and execute polymorph-tls suites from read-only consumer artifacts.
smoke-tls: shim
    deno run --allow-read --allow-env=POLYMORPH_ROOT,WOSH_ROOT tools/smoke-tls/run.ts --exec

# The consumer smoke legs (tools/smoke-c0/).
smoke-c0: shim
    cd tools/smoke-c0 && deno task leg1 && deno task leg2 && deno task leg3 && deno task leg4

# `with-jco` prepares and adds the jco comparison (bench/boundary/README.md).
# Manual host-boundary benchmark, not a gate; results are machine-relative.
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

# Release artifacts in the repo root: the tested shim, embedder bundle and SHA256SUMS.
release-artifacts: shim
    cp target/wasm32-unknown-unknown/release/translator_shim.wasm polyengine-translator-shim.wasm
    deno run -A tools/release-bundle/build.ts --out polyengine-embedder.mjs
    sha256sum polyengine-translator-shim.wasm polyengine-embedder.mjs > SHA256SUMS
