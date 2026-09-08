# polyengine — architecture and design decisions

polyengine loads WebAssembly Component Model binaries on the JS
`WebAssembly` API. A wasm32 translator produces a linking plan and fused
adapters; a platform-neutral TypeScript runtime executes the plan, handles
the host ABI, and schedules Component Model tasks.

Section numbers and headings are stable because code and contracts link
to them. The [contracts](../contracts/) specify interfaces;
[security.md](security.md) describes trust boundaries;
[consumers.md](consumers.md) covers downstream integration; and
[references.md](references.md) records upstream sources and dependency pins.

## 1. Goals

- Load, link, and execute component binaries at runtime on JavaScript
  engines, or consume artifacts translated at build time.
- Support Component Model 0.3 concurrency: async lift/lower, tasks and
  subtasks, streams, futures, backpressure, and cancellation. Sync calls
  use the same task machinery.
- Run guests from external toolchains, including Rust/wit-bindgen and
  componentize-go, and composed workloads from the polymorph family.
- Pursue functional parity with the Component Model feature set supported
  by wasmtime, tested against the spec and guest workloads. This is a
  compatibility target, not a claim that every feature is implemented or
  that passing tests proves conformance. Coverage and gaps are in §11.

**Semantic authority.** The Component Model spec and its executable
reference, `third_party/component-model/design/mvp/canonical-abi/definitions.py`,
break ties. Wasmtime is corroborating evidence, not an overriding
authority. Reusing its frontend reduces duplicated implementation; it
does not prove the shim, runtime, or their integration correct.

**Parity is functional, not behavioral identity.** Where the spec permits
choices, this runtime may differ from wasmtime: deterministic FIFO
scheduling, deterministic NaNs, and JS-native host value shapes. It also
has named divergences (§6). The conformance harness accommodates
engine-specific trap wording; diagnostic text is not the public API.

**One bounded exception (operator decision):** when `definitions.py` conflicts with the spec
repository's own WAST corpus and wasmtime implements the corpus side, the
corpus semantics may be adopted as a working assumption. This requires
verification against wasmtime source or a trace, a named finding in
[upstream-component-model-repo-findings.md](../upstream-component-model-repo-findings.md),
and reversal if upstream adjudicates otherwise. Currently this applies
only to CM-3. A schedule-dependent assertion cannot invoke the exception:
if two conforming schedulers can answer differently, the assertion pins a
policy rather than semantics. Wasmtime behavior alone is insufficient.

## 2. Non-goals

- **WASI in the runtime core.** Providers live in the separate
  `@polyengine/wasi` package. Its default `wasi()` merge supplies captured
  CLI I/O, clocks, entropy, and empty filesystem preopens. Real filesystem,
  host stdio, sockets, and outbound HTTP providers are explicit opt-ins.
  WASI interface shapes still inform the embedder API.
- **Componentizing JS/TS.** Guests are binaries from external toolchains;
  this project does not embed a JS engine into components.
- **jco API compatibility.** Consumers use the conventions in
  [contracts/embedder-api.md](../contracts/embedder-api.md), not jco's
  host value shapes or transpilation options.
- **A JSPI fallback for stackful/blocking forms.** Callback-ABI async
  execution does not itself need JSPI. A callback-ABI guest can still need
  it when it calls a blocking sync import. Missing engine capabilities
  are reported, not emulated.

## 3. Compatibility targets

Core-wasm features and JSPI are separate requirements. For example, FACT
adapters may require multi-memory even when guest async calls use the
callback ABI. JSPI is needed for stackful async lifts and suspending sync
lowers (§5–§6).

| Engine | JSPI / lane policy |
|---|---|
| Deno | Primary development runtime; JSPI enabled by default from 2.3.2 |
| Chrome/Chromium | JSPI enabled by default from 137; browser lane |
| Firefox / SpiderMonkey | Browser driver enables `javascript.options.wasm_js_promise_integration`; pinned shell lane is a required gate |
| WebKit / JavaScriptCore | JSPI works in the pinned WPE browser build, but that build lacks multi-memory. Newer trunk builds support both; stable Safari support remains tracked in [#11](https://github.com/polymorph-components/polyengine/issues/11) |
| Node | Pinned Node 26 lane requires no JSPI flag. The npm package's lower Node floor does not guarantee JSPI; Node 24's flag-gated implementation is not the conformance target |
| Bun | Pinned findings-only lane; driver enables `BUN_JSC_useWasmMultiMemory=1` |

Exact shell versions live in [tools/shell/pins.json](../tools/shell/pins.json).
[Browser](../harness/browser/expectations/) and
[shell](../harness/shell/expectations/) expectations record lane-specific
differences. V8, SpiderMonkey, and JSC provide engine coverage; Node/Bun
also test module loading, I/O, and event-loop integration. These lanes do
not establish support for every release of an engine family.

The runtime does not depend on WebAssembly JS type reflection. The
translator supplies signatures that `WebAssembly.Module.imports()` cannot
provide on the supported baseline.

**CSP invariant:** compiling wasm bytes requires `wasm-unsafe-eval`, not
full `unsafe-eval`. The runtime does not use `eval` or `new Function`.
Any future specialized-JS executor must be emitted as importable modules
(§8), not generated and evaluated inside a browser at runtime. Core
platform neutrality is checked by
`runtime/tests/platform_purity_test.ts`; platform-specific loaders and
WASI backends sit outside it.

## 4. Architecture

Build-time and runtime translation use the same pipeline. Both currently
execute the host boundary through the descriptor interpreter.

```text
component.wasm
    |
    v
wasm32 translator: wasmtime-environ + FACT + translator-shim
    |
    +-- plan: initializers, core-module ranges, types, CABI descriptors,
    |         required intrinsics, resource metadata
    +-- FACT adapter modules
    |
    v
TypeScript runtime + original component bytes
    +-- compile core modules and adapters with WebAssembly APIs
    +-- instantiate and link in plan order
    +-- interpret host-boundary lift/lower
    +-- manage resources, tasks, streams/futures, and JSPI entries

WIT source --> bindgen --> typed TS facade + expected world digest
                                      |
                              checked at instantiation
```

### 4.1 Translator: wasmtime's frontend compiled to wasm

`crates/translator-shim` compiles wasmtime's translation frontend to a
plain core wasm module with a bytes-in/bytes-out ABI:

- `wasmtime-environ` parses and validates components, resolves types and
  linkage, and flattens instantiation into a plan.
- FACT generates fused canonical lift/lower adapters as core wasm. These
  perform cross-component conversion without a JS adapter frame between
  guest calls, allowing suspension on those paths (§5).
- The shim maps environ's internal structures to the versioned
  [plan format](../contracts/plan-format.md).

The frontend and FACT remain upstream dependencies, not a replacement
for runtime conformance testing. FACT calls host intrinsics for operations
including transcoding, resource transfer, state bookkeeping, and traps.
The runtime implements that interface under
[contracts/intrinsics.md](../contracts/intrinsics.md); the plan lists the
required intrinsics. Host-boundary conversion is also this runtime's
responsibility, not FACT's.

**Local FACT correction.** Adapters are not copied verbatim from the
pinned frontend: `crates/translator-shim/src/fact_string_limits.rs`
corrects recognized pre-realloc string guards to enforce the reference's
source-byte limit of `(1 << 28) - 1`, rather than the pinned generator's
destination-width/retry thresholds. Only FACT-generated adapters pass
through this correction; embedded guest modules are untouched. It
preserves module length, validates the result, and rejects unrecognized
guard shapes or an environ revision change. Every frontend pin update
must review whether to retain, revise, or remove this correction. The
producer matrix and drift checks are in
`crates/translator-shim/tests/fact_string_source_limits.rs` and
`runtime/tests/fact_string_source_limits_test.ts`.

`wasmtime-environ` is an unstable internal API. Its git revision and the
matching wasm-tools release train are pinned in [Cargo.toml](../Cargo.toml)
and [Cargo.lock](../Cargo.lock). The shim contains dependency-specific
mapping code; upgrades require integration gates, not just a pin change.

### 4.2 Plan format

[contracts/plan-format.md](../contracts/plan-format.md) defines the wire
format and artifact set:

- JSON with strict format-version checking and structural validation.
- Operational data: initializers, module references, CABI descriptors,
  type tables, required intrinsics, and resource/destructor metadata.
- Core modules referenced by byte ranges in the caller's original
  component; generated adapters supplied separately. The plan does not
  duplicate the component bytes.
- No WIT source fidelity: documentation, source-level aliases, and feature
  gates are not preserved for bindgen (§9).

Identical component bytes, translator build, and feature settings are
expected to produce identical artifacts. That identity supports caching
(§10); it is not an authenticity guarantee.

### 4.3 TS runtime

The runtime core requires only standard web-platform APIs, not
platform-specific APIs. Guarded ambient probes for diagnostics or the
scheduler seed may inspect Deno when available; they are not runtime
requirements. Platform-specific cache backends and asset loaders are
separate concerns. Core responsibilities are:

1. Compile modules, instantiate in plan order, and wire imports/exports.
2. Lift/lower host values from CABI descriptors, including `realloc` and
   `post-return` handling.
3. Maintain resource handle tables, own/borrow transfers, lend counts,
   borrow invalidation, and destructor calls.
4. Enforce Component Model state rules such as `may_leave`, and the
   runtime's poisoned-instance refusal (§6). JSPI enforces none of these
   rules. There is no separate reentrance gate into a live instance.
5. Schedule tasks, threads, waitables, streams/futures, callback events,
   backpressure, and cancellation. Sync calls use tasks too.

The [embedder layer](../runtime/src/embedder/) adapts the raw interpreter
boundary into camelCase facades, branded errors, resource classes,
`Stream`/`Future` handles, and version-canonical import resolution. Its
public behavior is governed by the
[embedder contract](../contracts/embedder-api.md), not the raw boundary.

## 5. The JSPI frame rule (load-bearing constraint)

JSPI suspends wasm computations, not arbitrary JS stacks. Between an
entry through `WebAssembly.promising` and a `WebAssembly.Suspending`
import, an intervening JS frame prevents suspension. See the
[JSPI overview][js-promise-integration Overview].

- Host-boundary glue runs inside the suspending import and returns its
  Promise before suspension. It is not an intervening frame.
- Cross-component ABI adapters are wasm. A JS adapter that calls another
  guest would prevent a later suspension below it.
- JS calls into wasm that may suspend need a `promising` entry. The
  executor also prepares such entries for suspension-capable host-initiated
  resource drops.
- **Guest-initiated destructor calls are a current exception to the
  pure-wasm path:** their dispatch contains a JS frame. They must complete
  synchronously; attempting JSPI suspension traps. Pure-wasm destructor
  dispatch is not implemented (§7).

## 6. Concurrency (the core deliverable)

The task model follows the executable reference's `Store`, `Task`,
`Thread`, and `Subtask` structures. Scheduling is cooperative: the JS
event loop supplies host settlements, and explicit queues determine guest
progress. There is no preemption.

| Reference operation | Runtime mechanism |
|---|---|
| Stackful thread execution | Wasm activation entered through `WebAssembly.promising` |
| Blocking wait | `Suspending` import returning a scheduler-controlled Promise |
| Resume | Scheduler resolves or consumes the relevant settlement |
| Callback ABI | Scheduler invokes the callback export with events; no suspended wasm stack |
| Waitable / waitable set | Host-side event state, consumed by stackful waits or callback return codes |
| Sync `canon_lift` | Drive the task to resolution, retaining the reference's deadlock trap |
| Async `canon_lift` | Exit the driver on idle; an unresolved export Promise stays pending for later progress |

JSPI is used for no-callback stackful async lifts, blocking sync lowers,
and sync guests calling host imports marked `suspending()`. A callback
ABI alone needs no JSPI, but a guest's blocking imports may still require
it. Rust guest fixtures and external Go consumer workloads exercise callback
lifts; the Go integration test skips when its external artifact is absent.

**Scheduling policy.** The default is deterministic FIFO in waiting-list
order, not the time readiness became true; pending events use join order.
Tests can use seeded shuffling through `POLYENGINE_SCHED_SEED` to exercise
spec-permitted scheduling variation. See `runtime/src/task/scheduler.ts`.

**Overlapping drivers.** Concurrent exports may run overlapping
`driveAsync` loops on one store. The invariant is that an activation
consumes a settlement at most once and never resumes from an obsolete
settlement. `runtime/src/exec/boundary.ts` enforces this with synchronous
awaiting-membership removal, memoized Promise tags, Promise-identity
checks, and per-store pending-resumption bookkeeping.

The asynchronous host-activity and host-settlement pumps are fallback
drivers: they stand down cooperatively when another driver is active.
This is not a ban on synchronous pump participation: `HostActivity.pump()`
services settled activations and ticks ready threads before its async
fallback checks driver depth, including while an export driver is live.
Arrival notifications wake parked drivers so they can yield or reconsider their
waits. New host-call registrations also wake incumbent drivers rather
than leaving them parked on an obsolete snapshot of pending work.

**Between-calls progress.** A host import settling can resume background
guest work even with no export call in flight. A task waiting for the
embedder's half of a stream/future remains pending until the embedder
acts. An idle async-typed export may remain pending indefinitely; sync-typed
exports retain deadlock detection. See the
[function contract](../contracts/embedder-api.md#functions-and-async).

**Host-import cancellation.** By default, cancellation resolves the
subtask promptly as `CANCELLED_BEFORE_RETURNED` and discards late Promise
settlements. The result is not lowered, and the discarded call no longer
counts as an outstanding host dependency. This cancels delivery, not the
JS operation. `deferCancel()` instead keeps the import running to
completion; `abortable()` supplies a per-call `AbortSignal`. On discard,
the signal is aborted in a microtask, never inside the guest activation.
These are embedding policies permitted by the reference's host-callee
cancellation hook.

Named differences from the reference or other hosts:

- **Async `subtask.cancel` under JSPI is not atomic**
  ([#92](https://github.com/polymorph-components/polyengine/issues/92)).
  The runtime may park for a determinate cancellation result across the
  engine's mandatory microtask hop. Ready sibling threads can run during
  that park. See `createSubtaskCancel` in
  `runtime/src/intrinsics/async_builtins.ts` and
  `runtime/tests/cancel_bracket_race_test.ts`.
- **Per-instance poisoning**
  ([#173](https://github.com/polymorph-components/polyengine/issues/173)).
  A trap escaping a guest activation permanently poisons that instance;
  later entry names the original cause. Sibling instances remain usable
  unless the trap propagates into them. The reference has no instance-level
  trap state; wasmtime's store-level trap handling is not this policy.
  The same-instance exemption in `entryRefusal` permits destructor
  self-drops. Reentrance into an otherwise live instance is valid.
- **Cancelling an unobserved completed stream copy reports
  `CANCELLED|count`**, preserving the count rather than delivering the
  pending `COMPLETED|count`
  ([#296](https://github.com/polymorph-components/polyengine/issues/296)).
  This is the sole §1 corpus/reference exception,
  [CM-3](../upstream-component-model-repo-findings.md#cm-3-cancel_copy-returns-a-stale-completed-where-wasmtime-reports-cancelled).
  See `takeCancelEvent` in `runtime/src/intrinsics/stream_builtins.ts`.

## 7. Canonical ABI decisions

The [Canonical ABI][CanonicalABI.md] and pinned `definitions.py` govern
lift/lower behavior. Public host shapes are specified in the
[embedder contract](../contracts/embedder-api.md#value-mapping-normative).

**Strings.** Host strings are plain JS strings without encoding provenance.
Lowering treats them as UTF-16 code units and replaces lone surrogates
with U+FFFD (WebIDL `USVString`). UTF-8 and UTF-16 lifts use fatal
`TextDecoder`s; latin1 uses a byte-to-code-point mapping because the
WHATWG `latin1` label means Windows-1252. All three CABI encodings,
including `latin1+utf16`, are implemented.

The current UTF-8 lowering path copies an ASCII prefix directly, then on
non-ASCII input reallocates to the worst-case size, uses
`TextEncoder.encode`, copies the encoded suffix, and shrinks if needed.
UTF-16 uses explicit little-endian encoding; compact strings begin as
latin1 and widen when necessary. There is no `encodeInto` fast path.
See `runtime/src/cabi/strings.ts`.

**Numbers and lists.** `u64`/`s64` use `bigint`; other numeric types use
`number`. NaNs follow the deterministic profile. `list<u8>` uses copied
`Uint8Array`s; other lists retain ordinary array host shapes. Flat numeric
lists use bulk TypedArray paths on little-endian hosts, with NaN
canonicalization and a DataView fallback for big-endian hosts. `char`
requires per-element Unicode scalar validation.

**Memory lifetime.** Views are reacquired after calls that can grow memory.
Ordinary lifted lists never expose guest memory. The explicit
`stream<u8>` direct-access API is the narrow exception: its callback may
access the peer's landing zone or unread bytes only during that
synchronous callback. See
[Streams and futures](../contracts/embedder-api.md#streams-and-futures).

**Resources.** Host-facing handles are classes with `drop()` and
`Symbol.dispose` for explicit disposal, plus a `FinalizationRegistry`
backstop. Finalization is not deterministic cleanup. Host-held owns track
lends; explicit disposal invalidates the wrapper immediately but defers
destruction while lent, as does the backstop. Backstop
failure is reported through the host-failure channel, not swallowed.
Backstop-versus-teardown policy remains tracked in
[#10](https://github.com/polymorph-components/polyengine/issues/10).

**Destructors.** `canon_resource_drop` lifts a core `[rep] -> []`
destructor with synchronous canonical options. The destructor may not
Component-Model-block, though the spec permits spawning an explicit
thread that blocks without preventing the destructor's implicit thread
from returning. This does not imply support for the deferred explicit-thread
built-ins (§11). Both guest- and host-initiated drops of guest resources use
`createDtorEntry` in `runtime/src/exec/boundary.ts`, creating a fresh
synchronous task and implicit thread rather than borrowing the caller's
task. A missing destructor still goes through that lift machinery.

Guest-initiated drops use the synchronous drive and must finish before
returning; thenables are refused. Their JS dispatch frame also prevents
JSPI suspension (§5). Host-initiated drops can use a `promising` entry
for a suspension-capable destructor: host-import latency does not itself
constitute CM blocking. `drop(): void` does not wait for that activation's
tail; the store drives completion, and asynchronous failures surface on
the host-failure channel. The completion Promise is not itself registered
as external host work; genuine host imports register their own waits.

Destructor entry into a live instance is permitted. A trapping destructor
poisons its implementing instance, with propagation able to poison its
caller too. Poisoned-instance refusal retains the same-instance exemption
for self-drops. Host-implemented resources have no guest implementing
instance to enter or poison.

**Component `value` definitions.** Component-level `value` imports/exports
are excluded from the wasmtime parity target because the frontend does not
implement them. The official `test/values/` directory tests ordinary CABI
value passing and remains in scope.

## 8. Performance strategy

The shipping host-boundary executor is the generic CABI descriptor
interpreter, governed by
[contracts/descriptor-ir.md](../contracts/descriptor-ir.md). FACT already
generates wasm adapters for cross-component conversions, but these may
call runtime intrinsics; they are not a guarantee of a JS-free hot path.
Current optimizations include bulk list copies, byte-stream paths, slab
handle tables, and grow-aware memory views. String implementation details
are in §7.

**Future, not implemented:** emit specialized JS modules from the same
descriptors when measurements justify the additional executor
([#8](https://github.com/polymorph-components/polyengine/issues/8),
[#17](https://github.com/polymorph-components/polyengine/issues/17)).
The proposed delivery is deploy-time emission, or server-side emission
into a cache followed by `import()`, never `eval`/`new Function`.
Dynamically loaded browser components would retain the interpreter.
Differential tests between interpreted and emitted execution belong to
that work; they are not a current gate.

Translation time, artifact size, and call throughput depend on component,
engine, and build configuration. There is no universal startup or
throughput bound. Measure the relevant workload before adding another
execution path or changing deployment packaging.

## 9. Bindings generation

`crates/bindgen` reads a WIT file or directory through `wit_parser::Resolve`
and selects a `WorldId`. It emits world/interface types, resource class
declarations, host-provider types, an expected structural world digest,
and a TypeScript instantiation wrapper. Guest-side bindings still come from external toolchains
such as wit-bindgen.

WIT is the source input because component translation does not retain its
source-level fidelity. The current CLI emits a `.ts` file; it does not
offer a separate `.d.ts` or component-binary generation mode. `.d.ts`
files in the npm distribution come from the package build, not this CLI.

WIT documentation/stability-aware output and a degraded binary-input mode
remain design targets, not current CLI capabilities. The latter could
recover structural types but not WIT source documentation.

The generated instantiation wrapper checks its digest against the loaded
plan, then delegates to the runtime, which constructs the facade and
resource classes and adapts values. Generated resource declarations are
not implementations that callers can import as constructors. The digest
check follows [contracts/digest.md](../contracts/digest.md).
This detects structural skew between bindings and component types. It
does not authenticate the plan (§10).

`--import-base` controls runtime imports. A path or URL addresses source
files (`{base}/{module}/mod.ts`); a bare or registry specifier addresses
package exports (`{base}/{module}`). The default JSR range derives from
`runtime/deno.json` at build time. **Development manifests name the next
release**, which may not exist in the registry: use an explicit compatible
released base or the local source when generating from a checkout.
In-repo fixtures use `../../../src`.

The translator and bindgen share a pinned wasm-tools release train.
Host value shapes, import resolution, errors, async behavior, and resource
classes remain governed by the
[embedder contract](../contracts/embedder-api.md).

## 10. Caching

**Artifact cache.** `runtime/src/cache/` stores the plan and FACT adapters,
not the original component bytes. Its key includes the component SHA-256,
translator build hash, and feature settings. `webCache()` uses the Cache
API; `dirCache()` uses a Deno filesystem directory. A hit skips
translation, not core-module compilation or instantiation.

`translateCached` requires a non-null translator `buildHash`, including on
a hit. `Translator.create(bytes)` computes it;
`Translator.fromExports(ns, { buildHash })` accepts a known asset hash.
The packaged loader's Deno wasm-module path currently supplies no hash,
so that translator cannot be used directly with `translateCached`.

Cache I/O failures must not fail an otherwise valid translation:
`translateCached` falls back to fresh translation on `get` failure and
returns fresh artifacts even if `put` fails. Backend self-heal eviction
is best-effort; explicit `evict()` still reports errors.
`onCacheError` reports caught `get`/`put` failures, while backend failures
already converted to misses need not produce a callback. Component
validation failures still propagate. Correctly populated entries can be
read from a read-only cache, with a translator available for misses.

The directory backend preserves validated adapter paths beneath its
`adapters/` directory and creates their parent directories when writing.
Verify actual `fromCache: true` results after prewarming: successful
translation alone does not establish that cache writes succeeded.

**Engine code caches.** These are independent, opportunistic platform
optimizations; correctness and artifact caching do not depend on them.
V8's [published code-cache description](https://v8.dev/blog/wasm-code-caching)
ties persistence to streaming compilation, HTTP cache entries, module
size, and tier-up. Thresholds and policies are engine/version details,
not polyengine guarantees. Synthesized responses or sliced component
bytes should not be assumed to get the same persistent cache behavior as
standalone modules served at real URLs. Deployment-specific verification
is tracked in [#7](https://github.com/polymorph-components/polyengine/issues/7).

**Trust.** Plans and adapters are trusted inputs whether produced locally,
loaded from a cache, or shipped as build artifacts. The runtime checks
structure, format versions, and component-byte identity, but does not
prove that supplied artifacts are what the translator would produce.
Protect them like executable inputs. See
[The artifact cache is a trust input](security.md#the-artifact-cache-is-a-trust-input)
for deployment guidance.

## 11. Conformance and testing

| Source | Coverage |
|---|---|
| Pinned [Component Model][WebAssembly/component-model] `test/` corpus | Binary format, validation, linking, resources, values, and async behavior |
| `definitions.py` and `run_tests.py` | Reference-derived lift/lower tests and fixtures in `runtime/tests/` |
| Rust/wit-bindgen fixtures | Real guest ABI and runtime integration in `examples/guests/` |
| External componentize-go consumer artifacts | `wasi/tests/integration_engine_go_test.ts` skips when the external artifact or shim is absent; consumer smoke tools provide additional external coverage |
| Polymorph conformance suites and consumer smoke gates | Host-provider interfaces, composed components, background tasks, and resource flows; see [consumers.md](consumers.md) |
| `runtime/tests/conventions/` | Committed transcripts of the public host ABI, gated with protocol versioning |

Wasmtime's component-model tests are supplementary reference material
([references.md](references.md)), not an additional corpus executed by the
current generation or gate paths.

`crates/testgen` uses `wast` and `json-from-wast` to convert WAST into JSON
commands and wasm binaries. The TS harness distinguishes core modules
from components by their preambles and executes the commands across Deno,
browsers, engine shells, and server runtimes. Engine trap-message
normalization belongs to `TRAP_MESSAGE_EQUIVALENTS` in
`harness/src/runner.ts`, not the runtime.

Expected failures are classified, not counted as conformance. Known
classes include deferred thread support
([#12](https://github.com/polymorph-components/polyengine/issues/12)),
sync scheduling gaps
([#249](https://github.com/polymorph-components/polyengine/issues/249)),
and upstream-unimplemented features
([#248](https://github.com/polymorph-components/polyengine/issues/248)).
Per-lane overlays distinguish engine limitations from runtime failures.
The current base classification is in [harness/src/xfail.ts](../harness/src/xfail.ts).
Unexpected failures and stale expected failures fail their gate.

The [justfile](../justfile) is the command surface; CI job bodies live in
[.github/justfile](../.github/justfile). Required PR checks use the pinned
shell lanes alongside core tests. Browser lanes run post-merge and gate
prereleases; findings-only lanes do not become required checks merely by
running there. Weekly canaries probe newer runtimes and engine features.
`just gates` adds consumer smoke checks that require external checkouts.

Passing suites is evidence, not proof. Wasmtime-derived tests share code
with the translator; spec-derived tests and independent consumer workloads
cover different failure modes. Native-wasmtime differential fuzzing is
future work ([#9](https://github.com/polymorph-components/polyengine/issues/9)),
as is interpreter-versus-emitted-module testing (§8).

## 12. Risks

| Risk | Current response / limitation |
|---|---|
| Unstable wasmtime frontend API | Pin dependencies, isolate mapping in the shim, and run integration gates on upgrades |
| Engine capability gaps | Explicit per-lane expectations; do not infer stable Safari or older runtime support from trunk results |
| JSPI frame restrictions | Wasm adapters and centralized entry wrapping; guest-initiated suspending destructors remain unsupported |
| Scheduler and shared-frontend blind spots | Seeded scheduling, reference tests, regression fixtures, and consumer gates; none establish exhaustive parity |
| Host-boundary interpreter cost | Measure workloads; specialized-module emission remains future work |
| Pre-1.0 interface churn | Compatible minor-line releases, explicit breaking-version events, and strict plan-format checks |
| Artifact or host-provider authority | Trusted artifacts and explicit capability grants; WASI confinement is not a hostile-guest sandbox ([security.md](security.md)) |
| Resource cleanup timing | Prefer explicit disposal; finalization and teardown ordering have limits (§7) |

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model
[CanonicalABI.md]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
[js-promise-integration Overview]: https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
