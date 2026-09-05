# polyengine — references

Canonical links contributors (human or agent) are likely to need. Versioned
links are pinned to the versions this repo pins; re-pin them together with
the dependency.

## Component Model spec (submodule: `third_party/component-model`)

- Explainer (text format, grammar, validation):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/Explainer.md
- Canonical ABI (lift/lower, options, built-ins, invariants):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
- **Executable CABI reference** (the tie-breaking authority for runtime
  semantics):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/canonical-abi/definitions.py
  — with `run_tests.py` and `diff.py` alongside
- Binary format: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Binary.md
- Concurrency model (0.3 tasks/streams/futures):
  https://github.com/WebAssembly/component-model/blob/main/design/mvp/Concurrency.md
- WIT: https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md
- Shared-nothing linking: https://github.com/WebAssembly/component-model/blob/main/design/mvp/Linking.md
- Official WAST suite: https://github.com/WebAssembly/component-model/tree/main/test
- User-facing CM documentation: https://component-model.bytecodealliance.org/
- Our upstream findings tracker:
  [upstream-component-model-repo-findings.md](../upstream-component-model-repo-findings.md)

## JSPI and engine support

- JSPI proposal Overview (the frame rule lives in "Restriction"):
  https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
- V8 JSPI introduction: https://v8.dev/blog/jspi
- Engine feature matrix: https://webassembly.org/features/ (data:
  https://github.com/WebAssembly/website/blob/main/features.json)
- V8 wasm code caching (the URL/HTTP-cache anchoring facts in
  [architecture.md §10](architecture.md)):
  https://v8.dev/blog/wasm-code-caching
- Stack-switching proposal (JSPI's core-wasm sibling, context only):
  https://github.com/WebAssembly/stack-switching

## wasmtime internals (pinned: wasmtime-environ **49.0.0-dev+4675ee1**, a git rev of `main`)

- Source at the pinned rev:
  https://github.com/bytecodealliance/wasmtime/tree/4675ee16b703b33948073a5ff6b961367371e7a1/crates/environ/src
  — notably `component::{Translator, Component, GlobalInitializer, CoreDef,
  Trampoline, CanonicalOptions}` and `fact::Import`. FACT: `src/fact.rs`
  (+ `src/fact/`), component translation: `src/component/`
- FACT design note ("polyfill for the component model in JS environments" is
  an intended consumer):
  https://github.com/bytecodealliance/wasmtime/blob/4675ee16b703b33948073a5ff6b961367371e7a1/crates/environ/src/component/translate/adapt.rs
- Wasmtime component wast tests (supplementary corpus):
  https://github.com/bytecodealliance/wasmtime/tree/main/tests/misc_testsuite/component-model

## Toolchain crates (pinned versions in lockfiles)

- wasm-tools repo (CLI + crates): https://github.com/bytecodealliance/wasm-tools
- `wast` crate (component-aware wast parsing, used by testgen):
  https://docs.rs/wast/
- `wasmparser` (0.258.x — must match wasmtime-environ): https://docs.rs/wasmparser/
- `wasm-encoder`: https://docs.rs/wasm-encoder/
- `wit-parser` (bindgen input): https://docs.rs/wit-parser/
- wit-bindgen (guest toolchain, pinned **0.60.0**):
  https://github.com/bytecodealliance/wit-bindgen — `generate!` macro docs:
  https://docs.rs/wit-bindgen/0.60.0/wit_bindgen/macro.generate.html
- wit-bindgen runtime tests (compat corpus):
  https://github.com/bytecodealliance/wit-bindgen/tree/main/tests

## JS platform specifics

- WebIDL `USVString` conversion (our string-lowering semantics):
  https://webidl.spec.whatwg.org/#idl-USVString
- `String.prototype.toWellFormed` (ES2024):
  https://tc39.es/ecma262/#sec-string.prototype.towellformed
- `TextEncoder.encodeInto`:
  https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder/encodeInto
- `TextDecoder` labels (note: "latin1" label decodes windows-1252, hence the
  hand-rolled latin1 in `runtime/src/cabi/strings.ts`):
  https://encoding.spec.whatwg.org/#names-and-labels
- `FinalizationRegistry` (resource backstop — read the caveats):
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry
- Explicit resource management / `using` (TS 5.2+, `Symbol.dispose`):
  https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html
- WebAssembly JS API spec: https://webassembly.github.io/spec/js-api/
- Deno runtime docs (workspaces, `deno test`, `--v8-flags`):
  https://docs.deno.com/runtime/
