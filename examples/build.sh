#!/usr/bin/env bash
# Builds the Rust guest fixture corpus into WebAssembly components.
#
# Pipeline per guest (see README.md):
#   1. cargo build --release --target wasm32-unknown-unknown
#      (pure computational reactors: no WASI imports, so no wasip1 adapter)
#   2. wasm-tools component new   core module -> component
#   3. wasm-tools validate        (component-model; + cm-async for async-probe)
#   4. wasm-tools component wit   print the component's world (round-trip sanity)
#
# Outputs land in guests/build/ (gitignored). All guest crates share
# guests/target/ as a cargo target dir so common deps compile once.
#
# Optional smoke run at the end if `wasmtime` is on PATH.

set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
BUILD_DIR=guests/build
export CARGO_TARGET_DIR="$PWD/guests/target"

GUESTS="hello values resources async-probe yield-only context-user backpressure-probe stream-echo stream-pass future-user future-import resource-stream tcp-echo http-fetch test-suite fs-probe net-probe cancel-import"

# Most guests are pure computational reactors on wasm32-unknown-unknown;
# fs-probe and net-probe build for wasm32-wasip2 ON PURPOSE — std::fs /
# std::net through wasi-libc is the linkage under test, and the wasip2
# target emits a finished component (no `component new` step).
target_for() {
  case "$1" in
    fs-probe|net-probe) echo "wasm32-wasip2" ;;
    *) echo "$TARGET" ;;
  esac
}

# wasm-tools validation features per guest (component-model always on;
# CM 0.3 async guests additionally need the cm-async feature).
features_for() {
  case "$1" in
    async-probe|yield-only|context-user|backpressure-probe|stream-echo|stream-pass|future-user|future-import|resource-stream|tcp-echo|http-fetch|test-suite|cancel-import)
      echo "component-model,cm-async" ;;
    *) echo "component-model" ;;
  esac
}

mkdir -p "$BUILD_DIR"

for guest in $GUESTS; do
  echo "==== $guest"
  tgt=$(target_for "$guest")
  (cd "guests/$guest" && cargo build --release --target "$tgt")
  core="$CARGO_TARGET_DIR/$tgt/release/guest_${guest//-/_}.wasm"
  out="$BUILD_DIR/$guest.component.wasm"
  if [ "$tgt" = "wasm32-wasip2" ]; then
    cp "$core" "$out" # already a component (see target_for)
  else
    wasm-tools component new "$core" -o "$out"
  fi
  wasm-tools validate --features "$(features_for "$guest")" "$out"
  echo "---- $out ($(wc -c <"$out") bytes), world:"
  wasm-tools component wit "$out"
done

if command -v wasmtime >/dev/null 2>&1; then
  echo "==== smoke run ($(wasmtime --version))"
  check() { # check <expected> <component> <invoke-expr>
    got=$(wasmtime run --invoke "$3" "$BUILD_DIR/$2")
    if [ "$got" != "$1" ]; then
      echo "FAIL: $2 $3 -> $got (expected $1)" >&2
      exit 1
    fi
    echo "ok: $2 $3 -> $got"
  }
  check '"Hello, smoke!"' hello.component.wasm       'greet("smoke")'
  check '18446744073709551615' values.component.wasm 'echo-u64(18446744073709551615)'
  check 'label("hi")' values.component.wasm          'echo-variant(label("hi"))'
  check '{read, exec}' values.component.wasm         'echo-flags({read, exec})'
  check '0' resources.component.wasm                 'live-counters()'
  # Component Model 0.3 async export (callback ABI): runs on wasmtime 47
  # with default flags; exercises yield suspension + task.return.
  check '42' async-probe.component.wasm              'wait-then-double(21)'
  check '3' yield-only.component.wasm                 'yield-n-times(3)'
  check '6' context-user.component.wasm               'interleave(4)'
  check '5' backpressure-probe.component.wasm         'toggle-around-yield(5)'
  echo "smoke run OK"
else
  echo "(wasmtime not found; skipping smoke run)"
fi

echo "==== all guests built and validated"
