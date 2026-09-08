#!/usr/bin/env bash
# Build the guest component and run the host. Same pipeline as
# examples/build.sh, scoped to this directory: cargo core module ->
# `wasm-tools component new` -> validate -> run host.ts under Deno.
#
# Prerequisite: `just shim` from the repo root. Published packages include the shim.
set -euo pipefail
cd "$(dirname "$0")"

export CARGO_TARGET_DIR="$PWD/guest/target"
(cd guest && cargo build --release --target wasm32-unknown-unknown)

mkdir -p build
wasm-tools component new \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/example_kitchen_sink.wasm" \
  -o build/kitchen-sink.component.wasm
wasm-tools validate --features component-model,cm-async build/kitchen-sink.component.wasm

deno check host.ts
deno run --allow-read=build host.ts
