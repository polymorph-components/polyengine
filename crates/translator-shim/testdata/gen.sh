#!/bin/sh
# Regenerate the .wasm test components from their WAT sources.
#
# Requires wasm-tools (spike used 1.247.0). Note `wasm-tools parse` only
# converts text to binary; validation is done by the translator itself
# (wasmparser 0.258 via the pinned wasmtime-environ git rev, see root
# Cargo.toml) and, as a cross-check, by native wasmtime 47:
#
#   wasmtime compile testdata/trivial.wasm
#   wasmtime compile -W component-model-async=y testdata/async-linked.wasm
#
# (wasm-tools 1.247's own `validate --features component-model,cm-async` also
# passes, but its validator predates the async-function-type requirement that
# wasmparser 0.258 enforces, so it is not the authority here.)
#
# Fixtures whose syntax is newer than the installed CLI (e.g. `relend-borrow`,
# which uses `(dtor (core func ...))`) are generated from the pinned `wat`
# crate instead:
#
#   cargo run -p translator-shim --example emit-testdata -- <name>
set -e
cd "$(dirname "$0")"
for f in trivial linked async-lift async-linked imports imported-resource error-context; do
  wasm-tools parse "$f.wat" -o "$f.wasm"
  echo "generated $f.wasm"
done
