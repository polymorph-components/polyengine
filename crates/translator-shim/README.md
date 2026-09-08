# translator-shim

The `wasmtime-environ` component frontend compiled as a native Rust library and
a wasm32 translator. It validates components, resolves linkage, synthesizes
FACT fused adapters, and emits **plan format 5**. The
[plan contract](../../contracts/plan-format.md) owns the schema;
[architecture](../../docs/architecture.md) explains the frontend/runtime split.
Dependency pins live in the root `Cargo.toml` and `Cargo.lock`.

## Translation output

The artifact set is `plan.json` plus `adapters/<static-module-index>.wasm`.
Embedded core modules remain slices of the original component, so consumers
must retain that component binary too.

The wasm C ABI returns one JSON envelope:

| Field | Meaning |
| --- | --- |
| `plan` | Plan object, including component identity and producer metadata |
| `adapters[i].file` | Artifact path matching the plan's module entry |
| `adapters[i].wasm` | Adapter bytes encoded as padded standard base64 |
| `error` | Error envelope only: human-readable failure message |
| `errorDetail` | Error envelope only: `{phase, message, detail}` |

Success and error fields are alternative envelope shapes. The runtime decoder
is [`loadEnvelope`](../../runtime/src/plan/loader.ts). Serialization and adapter
generation are deterministic for a fixed input and toolchain; native tests
compare repeated translations byte-for-byte.

## Validation and corrections

[`src/error.rs`](src/error.rs) separates three outcomes:

| Phase | Meaning | Conformance rejection evidence? |
| --- | --- | --- |
| `validation` | Input rejected by the configured frontend or embedded core-body validation | Yes, within that feature configuration |
| `unsupported` | Accepted frontend output cannot be represented by this translator | No |
| `internal` | Translation or adapter-correction invariant failed | No |

Malformed binary and type-invalid input share `validation`; callers must not
infer a finer distinction from message text. Validation is feature-configured:
`features()` in `src/lib.rs` enables the async extensions and other supported
proposals, but deliberately leaves `CM_VALUES` disabled to avoid unsupported
component value/start paths in the pinned frontend. A feature-disabled rejection
does not establish that the component is invalid under every spec feature set.

Wasmtime's frontend defers core function-body validation to its compiler.
`validate_function_bodies` runs those validators here: invalid embedded bodies
are `validation` errors, while invalid FACT-generated bodies are `internal`
errors. Imported core-module instantiation/re-export and GC canonical options
are examples of unsupported mappings; static core-module exports are represented.

[`fact_string_limits::correct`](src/fact_string_limits.rs) corrects the pinned
FACT generator's pre-realloc string checks to limit **source bytes** to
`2^28 - 1`, rather than destination width or retry-allocation size. It rewrites
only generated adapters, never embedded guest modules. The correction checks
the dependency pin and expected instruction/control-flow shapes, preserves
module length, and validates the corrected module. Drift is an internal error,
not a validation verdict. The integration regression is
[`fact_string_source_limits_test.ts`](../../runtime/tests/fact_string_source_limits_test.ts).

## APIs and tools

- `translate(&[u8]) -> Result<Translation, TranslateError>` returns a plan and
  adapter bytes.
- `to_envelope_json(&Translation)` serializes successful output;
  `translate_to_envelope(&[u8])` returns a success or structured error envelope.
- The wasm exports are `ts_alloc`, `ts_translate`, and `ts_dealloc`; pointer
  ownership and lengths are documented at `cabi` in [`src/lib.rs`](src/lib.rs).
  This is a trusted pointer ABI, not a guarantee that arbitrary pointers or
  upstream aborts can be converted to JSON errors.
- [`dump-plan`](examples/dump-plan.rs) inspects a component's plan;
  [`emit-testdata`](examples/emit-testdata.rs) builds fixtures with the pinned
  `wat` parser; [`suite-inventory`](examples/suite-inventory.rs) inventories
  translation results from a generated WAST corpus.

From the repository root:

```sh
just shim
cargo test -p translator-shim
deno run --allow-read crates/translator-shim/driver.ts
cargo run -p translator-shim --example dump-plan -- component.wasm --full
```

`just shim` builds the size-tuned wasm artifact and copies it into the translator
package. Some native tests skip when guest fixtures are missing; `just fixtures`
builds that corpus. The standalone smoke driver uses the checked-in `testdata/`
fixtures by default. For the full translation/runtime path, use
`just test-runtime` and `just conformance`.
