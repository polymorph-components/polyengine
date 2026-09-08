# polyengine — references

Use the checked-in dependency pins when investigating behavior. Links to
upstream `main` show current upstream work, not necessarily this checkout's
semantics. The authority policy, including the sole CM-3 exception, is in
[architecture §1](architecture.md#1-goals).

## Component Model spec (submodule: `third_party/component-model`)

The [submodule](../third_party/component-model/) pins the spec, executable
reference, and WAST corpus used by this checkout. Its principal sources are:

| Source | Purpose |
|---|---|
| [Explainer](../third_party/component-model/design/mvp/Explainer.md) | Text format, types, validation, canonical interface names |
| [Canonical ABI](../third_party/component-model/design/mvp/CanonicalABI.md) | Lift/lower, canonical options, built-ins, state rules |
| [definitions.py](../third_party/component-model/design/mvp/canonical-abi/definitions.py) | Executable semantic reference; use function names rather than line numbers |
| [run_tests.py](../third_party/component-model/design/mvp/canonical-abi/run_tests.py) | Reference tests; [diff.py](../third_party/component-model/design/mvp/canonical-abi/diff.py) compares reference and prose |
| [Binary format](../third_party/component-model/design/mvp/Binary.md) | Component binary encoding |
| [Concurrency](../third_party/component-model/design/mvp/Concurrency.md) | Tasks, streams, futures, and concurrency model |
| [WIT](../third_party/component-model/design/mvp/WIT.md) | Interface language |
| [Linking](../third_party/component-model/design/mvp/Linking.md) | Shared-nothing linking |
| [WAST suite](../third_party/component-model/test/) | Official test corpus |

Current upstream sources are at
[WebAssembly/component-model](https://github.com/WebAssembly/component-model).
The [Component Model book](https://component-model.bytecodealliance.org/)
is introductory documentation, not the semantic tie-breaker.
Local discrepancies belong in
[upstream-component-model-repo-findings.md](../upstream-component-model-repo-findings.md).

## JSPI and engine support

- [JSPI overview](https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md):
  `promising`, `Suspending`, and the restriction on intervening JS frames.
- [V8 JSPI introduction](https://v8.dev/blog/jspi).
- [WebAssembly feature matrix](https://webassembly.org/features/): useful
  context; project coverage is recorded in
  [architecture §3](architecture.md#3-compatibility-targets),
  [browser expectations](../harness/browser/expectations/), and
  [shell expectations](../harness/shell/expectations/).
- [Shell pins](../tools/shell/pins.json): exact tested shell/runtime builds.
- [V8 wasm code caching](https://v8.dev/blog/wasm-code-caching): published
  engine policy, not a portable cache guarantee. See
  [architecture §10](architecture.md#10-caching).
- [Stack-switching proposal](https://github.com/WebAssembly/stack-switching):
  related core-wasm work, not polyengine's current scheduling mechanism.

## wasmtime internals (pinned: wasmtime-environ **49.0.0-dev+4675ee1**, a git rev of `main`)

The revision is declared in [Cargo.toml](../Cargo.toml) and resolved in
[Cargo.lock](../Cargo.lock). Update source links with the pin.

- [Environ at the pinned revision](https://github.com/bytecodealliance/wasmtime/tree/4675ee16b703b33948073a5ff6b961367371e7a1/crates/environ/src):
  component translation and plan structures under `component/`; fused
  adapter generation in `fact.rs` and `fact/`.
- [Adapter translation](https://github.com/bytecodealliance/wasmtime/blob/4675ee16b703b33948073a5ff6b961367371e7a1/crates/environ/src/component/translate/adapt.rs):
  how component linkage is translated into FACT adapters.
- [Component-model tests at the same revision](https://github.com/bytecodealliance/wasmtime/tree/4675ee16b703b33948073a5ff6b961367371e7a1/tests/misc_testsuite/component-model):
  supplementary reference material, not a corpus executed by the current
  project gates or an independent check of the reused frontend.

## Toolchain crates (pinned versions in lockfiles)

[Cargo.toml](../Cargo.toml) and [Cargo.lock](../Cargo.lock) govern the host
toolchain; individual [guest crates](../examples/guests/) pin their own
dependencies (for example, [hello](../examples/guests/hello/Cargo.toml)).
The wasm-tools release train must
agree with the wasmtime frontend.

- [wasm-tools](https://github.com/bytecodealliance/wasm-tools): CLI and
  libraries, including `wasmparser`, `wasm-encoder`, `wit-parser`, `wast`,
  and `json-from-wast`.
- [wasmparser](https://docs.rs/wasmparser/0.258.0/wasmparser/): parsing and validation.
- [wasm-encoder](https://docs.rs/wasm-encoder/0.258.0/wasm_encoder/): core and component binary generation.
- [wit-parser](https://docs.rs/wit-parser/0.258.0/wit_parser/): bindgen's WIT input.
- [wast](https://docs.rs/wast/): WAST parsing; use the version in the lockfile.
- [json-from-wast](https://docs.rs/json-from-wast/): testgen's JSON-command and wasm-artifact conversion.
- [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) and its
  pinned [0.60.0 `generate!` documentation](https://docs.rs/wit-bindgen/0.60.0/wit_bindgen/macro.generate.html):
  guest bindings, distinct from polyengine's host-facing `crates/bindgen`.

## JS platform specifics

- [WebIDL `USVString`](https://webidl.spec.whatwg.org/#idl-USVString) and
  [`String.prototype.toWellFormed`](https://tc39.es/ecma262/#sec-string.prototype.towellformed):
  lone-surrogate replacement during string lowering.
- [`TextEncoder.encode`](https://developer.mozilla.org/en-US/docs/Web/API/TextEncoder/encode):
  the current non-ASCII UTF-8 lowering path in `runtime/src/cabi/strings.ts`.
- [Encoding labels](https://encoding.spec.whatwg.org/#names-and-labels):
  `TextDecoder("latin1")` means Windows-1252, not the CABI's latin1 mapping.
- [`FinalizationRegistry`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/FinalizationRegistry):
  nondeterministic resource backstop, not guaranteed cleanup.
- [Explicit resource management](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html):
  `using` and `Symbol.dispose`.
- [WebAssembly JS API](https://webassembly.github.io/spec/js-api/).
- [Deno documentation](https://docs.deno.com/runtime/).

For deployment authority and cache trust, see [security.md](security.md).
