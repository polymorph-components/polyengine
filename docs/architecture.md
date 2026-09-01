# polyengine — architecture and design decisions

A WebAssembly Component Model host built on the JS `WebAssembly` API, targeting
JSPI-capable engines. Primary development against Deno; conformance runs
against browsers. Aims for Component Model feature parity and compatibility
with wasmtime and wit-bindgen. **0.3.0 concurrency is the core deliverable.**

This document records the architecture and the decisions made, with rationale.
Section numbers **§1–§11 are stable** — they are cited from code comments and
contracts throughout the repo. Related documents:

- [`consumers.md`](consumers.md) — the polymorph adoption track (jco replacement)
- [`references.md`](references.md) — canonical upstream links
- [`../contracts/`](../contracts/) — versioned interface contracts
- [`../AGENTS.md`](../AGENTS.md) — the development protocol
- open work: the [issue tracker](https://github.com/polymorph-components/polyengine/issues)

---

## 1. Goals

- **Concurrency is the point.** Existing hosts already run non-async
  components fine; this project exists to be a first-class host for Component
  Model 0.3.0 concurrency — `async` lift/lower, tasks/subtasks,
  `stream`/`future` — mapped natively onto the JS event loop and JSPI.
  Sync-only operation is a supported subset, not a destination.
- Load, link, and run Component Model binaries (`.wasm` components) at runtime
  on stock JS engines, using only the JS `WebAssembly` API.
- Component Model feature parity with wasmtime, tracked against the official
  spec ([WebAssembly/component-model]).
- Compatibility with wasmtime-built and wit-bindgen-built guest components,
  sync and async alike, made executable via imported conformance/test
  suites. componentize-go output is a named second guest toolchain
  (consumer-driven, [consumers.md](consumers.md)): callback-ABI async lifts +
  async-lowered imports from Go's patched runtime — a differently-shaped
  exerciser of the same ABI.
- **Adoption target: replace jco as the JS host for the polymorph
  component family and experiment-mosh** ([consumers.md](consumers.md)).
  Their JS-host legs were blocked on structural jco defects in exactly this
  project's core territory (0.3 concurrency). They have no external
  dependents, so embedder conventions co-evolve with them — designed against
  real consumers, not in the abstract.
- **"Parity" means functional parity, not behavioral identity.** The bar is:
  the same feature set, spec-conforming behavior, and wasmtime/wit-bindgen
  guests running correctly. Where the spec sanctions a range of behaviors,
  this host may — and does — diverge from wasmtime's choices (deterministic
  FIFO scheduling per §6; deterministic NaN profile; JS-native host value
  shapes; per-instance poisoning, §6). Wasmtime-identical observable
  behavior is adopted only where (a) something external forces it — the
  official suite's `assert_trap` matches message text, which is de facto
  wasmtime wording — or (b) it is free by construction (the translation
  frontend *is* wasmtime-environ, §4). Behavior mandated by the
  spec/reference (e.g. the borrow-lending traps, per definitions.py) is spec
  conformance, not wasmtime-matching, even when wasmtime exhibits it too.
  The tie-breaking authority for semantic questions is the spec +
  `definitions.py`, with wasmtime as corroborating evidence — never the
  other way around. **One bounded exception** (operator decision): where
  `definitions.py` contradicts the spec repo's *own wast corpus* and
  wasmtime implements the corpus side, the corpus semantics — as wasmtime
  actually implements it, verified against wasmtime source or trace, not as
  inferred from the test alone — is adopted as the working assumption. Each
  such case must be a named finding in
  `upstream-component-model-repo-findings.md` (currently CM-3 only) and
  flips back if upstream adjudicates the other way. Bare wasmtime behavior
  with no corpus backing never supersedes the reference. Guard before
  invoking the exception: a corpus assertion counts as semantic authority
  only if it is **schedule-independent** — a test that two conforming
  scheduler policies answer differently pins a policy, not semantics, and
  is an upstream test defect rather than a conflict.
- TypeScript throughout the JS side: the runtime, the harness, and all
  generated bindings.
- A performance story that can get fast later without rearchitecting.

## 2. Non-goals

- **WASI implementations in the core.** `wasi:*` host packages are out of
  scope for the runtime itself; the finish line is Component Model support,
  demonstrated with custom WIT worlds. Two sanctioned carve-outs, both
  outside the core: WASI interface *shapes* are first-class design inputs
  to the embedder conventions ([consumers.md](consumers.md)) — they are the
  ecosystem's most important interfaces and the conventions must serve them
  well — and a WASI provider *package* (`wasi/`, `@polyengine/wasi`; a
  separate deliverable with consumer-driven scope: p2 cli/io/clocks/random
  baseline + p3 clocks, plus à la carte network fragments the default
  `wasi()` merge never carries — p3 `wasi:sockets`
  (`@polyengine/wasi/sockets`: UDP, TCP client + listener; one
  node-builtins backend serving Deno via its stable node compat and real
  Node, [#4](https://github.com/polymorph-components/polyengine/issues/4))
  and the fetch-backed `wasi:http@0.3` outbound client
  (`@polyengine/wasi/http`, riding the `@0.3` track like the rest of the
  package; a `version` override keys exact ids for guests pinned to
  pre-consolidation rc snapshots)).
- **Componentizing JS/TS.** Guests are components built by external toolchains
  (Rust + wit-bindgen is the reference). No embedded-JS-engine work.
- **jco compatibility or reuse.** Ignored entirely — including at the
  embedder-API level: we do not emulate jco's host conventions (thrown
  bare `{tag, val}` payloads, its `Stream` objects, transpile-time async
  enumerations); consumers port to our conventions
  ([consumers.md](consumers.md)). Where we need prior art we take it from
  wasmtime; where jco's conventions have known footguns (documented
  defensively by the polymorph host modules themselves), we fix rather than
  inherit. Replacing jco for the named consumers is a goal (§1); *being* jco
  is not.
- **Pre-JSPI engines.** No JSPI fallback path for the stackful/blocking
  forms. (The callback ABI — what wit-bindgen and componentize-go actually
  emit — needs no JSPI at all, so the effective floor for consumer workloads
  is "any modern engine"; JSPI is required only for sync-blocking forms.)

## 3. Compatibility targets

Floor for the JSPI-dependent forms: engines supporting JSPI (proposal is
**phase 4**; minor API drift is still possible — it changed once already when
the `Suspender` object was removed).

| Engine | JSPI status | Role |
|---|---|---|
| Deno ≥ 2.3.2 | on by default | primary dev target |
| Chrome/Chromium ≥ 137 | on by default | browser lane (exact Deno parity) |
| Firefox | flag: `javascript.options.wasm_js_promise_integration` | browser lane (pref flipped by the driver) |
| Safari / WebKit | JSPI works unflagged on WPE 26.5; JSPI + multi-memory both present in Safari Technology Preview; stable-Safari status: [#11](https://github.com/polymorph-components/polyengine/issues/11) | browser lane; pinned build capped by JSC's missing multi-memory — implemented and default-on in WebKit trunk (webkit-2342+ rolls reach effective parity; #11) |
| Node | on by default ≥ 26 | pinned runtime lane (`node-pinned`, v26.x: exact Deno parity, no flags; required gate). Node 24 LTS deliberately not laned: flag-gated JSPI (`--experimental-wasm-jspi`) whose older V8 13.6 vintage deviates on 2 corpus commands — see `harness/shell/expectations/node-pinned.ts` |
| Bun | on by default (1.3.x, vendored JSC) | pinned runtime lane (`bun-pinned`, findings-only until a track record): exact Deno parity under `BUN_JSC_useWasmMultiMemory=1` (driver-set; stock bun ships multi-memory off) — see `harness/shell/expectations/bun-pinned.ts` |

Notes:

- Deno and Chrome share V8, so Firefox and WebKit provide the real engine
  diversity. SpiderMonkey JSPI is clean over the full corpus; JSC's JSPI
  works unflagged, but the pinned JSC build lacks multi-memory, the actual
  WebKit-lane cap (the CABI routinely needs >1 memory per core module;
  default-on in WebKit trunk, #11). Engine trap-message wording differences
  are normalized in the harness matcher, never in the runtime
  (`TRAP_MESSAGE_EQUIVALENTS`, harness/src/runner.ts) — with them
  reconciled, Firefox and trunk WebKit run at exact Deno-lane parity.
- The node/bun lanes add **embedding** coverage, not engine coverage (V8 and
  JSC are already exercised above): module loading, event-loop integration,
  and runtime I/O quirks — e.g. node's pooled `Buffer`, whose pool-backed
  `.buffer` must never reach WebAssembly APIs (`tools/shell/host-node.mjs`).
- **Type reflection (js-types) is phase 3 and flagged everywhere** — function
  signatures are not available from `WebAssembly.Module.imports()`. The
  architecture below sidesteps this (the translator emits all type
  information), but no design may assume type reflection exists.
- CSP: compiling from bytes requires `wasm-unsafe-eval`. The runtime
  requires nothing beyond that — **a design invariant, not a default**
  ([#8](https://github.com/polymorph-components/polyengine/issues/8)): no
  code path may require full `unsafe-eval`. The specialized-JS executor is
  emission-only (§8) — a deploy-time AOT step or a server-side first-load
  cache import — never runtime `eval`/`new Function`.
- The runtime core is platform-neutral by contract (§4.3), pinned by
  `runtime/tests/platform_purity_test.ts` — no `node:*` builtins, no Deno
  APIs.

## 4. Architecture

One deterministic pipeline, run either at first load (and cached) or ahead of
time — "AOT" and "runtime linking" are the same code executed at different
moments.

```
                       Rust (compiled to wasm32, runs everywhere)
                     ┌──────────────────────────────────────────┐
 component.wasm ───► │ translator = wasmtime-environ (validate,  │
                     │ resolve linkage) + FACT (fused adapters)  │
                     │ + shim (stable output format)             │
                     └──────────────┬───────────────────────────┘
                                    │ artifacts (bytes, content-addressed)
                                    ▼
        ┌────────────────────────────────────────────────────┐
        │ plan: instantiation ops, type tables, CABI          │
        │       descriptors, required-intrinsics list         │
        │ core modules: byte ranges sliced from the component │
        │ adapter modules: FACT-generated core wasm           │
        └──────────────┬─────────────────────────────────────┘
                       │
                       ▼            TypeScript (platform-neutral)
        ┌────────────────────────────────────────────────────┐
        │ runtime: plan executor, host-boundary lift/lower,   │
        │ resource tables, intrinsics, instance-state rules,  │
        │ JSPI trampolines, 0.3 task scheduler (core)         │
        └────────────────────────────────────────────────────┘

 wit/*.wit ──► bindgen (Rust, wit-bindgen-core) ──► typed TS bindings
                                   (verified against the plan at instantiate())
```

### 4.1 Translator: wasmtime's frontend compiled to wasm

We reuse wasmtime's "decide what to do" layer, which is separable from its
"do it" layer and has no native-code dependency:

- `wasmtime-environ`'s component translator: parsing, validation, subtyping,
  and resolution of the component's linking structure into a flat
  instantiation plan.
- `wasmtime-environ::fact` (FACT): generates **fused adapters** — the glue for
  cross-component calls (canonical-ABI lift composed with lower) — **as plain
  core wasm modules** via `wasm-encoder`.

Why this is the cornerstone decision:

- **Wasmtime compatibility by construction.** We inherit wasmtime's
  interpretation of the spec for the largest correctness surface (validation,
  types, adapter semantics) and turn "compat with wasmtime" into a version pin.
- **It solves the JSPI stack-purity problem (§5) by construction** — all
  cross-component call paths are wasm, never JS.
- **It removes the hardest codegen** (flattening, param spilling, string
  transcoding, resource transfer, post-return) from our scope.

Constraints and mitigations:

- `wasmtime-environ` is an **internal, unstable API**. Mitigation: a thin Rust
  **shim** crate owns the dependency and maps environ's output into our own
  stable plan format. Wasmtime churn is confined to the shim. Pin wasmtime and
  wasm-tools versions; upgrade deliberately (the staged bump is
  [#1](https://github.com/polymorph-components/polyengine/issues/1)).
- FACT adapters import **host intrinsics** (string transcoders,
  `resource-transfer-own/borrow`, enter/exit bookkeeping, trap). The TS
  runtime implements this contract — specified in
  **[contracts/intrinsics.md](../contracts/intrinsics.md)** — and the shim
  emits the required-intrinsics list per component so the contract is explicit
  at translation time, not discovered at instantiation. These intrinsics are
  synchronous JS calls that return before any suspension can occur —
  compatible with the JSPI frame rule.
- The translator ships as a **plain core wasm module** with a bytes-in/bytes-out
  ABI (no components-all-the-way-down bootstrap).
- Size: 1.66 MiB size-tuned (~0.5 MiB gzip), sub-ms steady-state translation;
  multi-MB consumer components translate in tens of ms. Being a real static
  asset ≥ 128 kB, browsers code-cache the translator itself well — the most
  expensive fixed cost of the pipeline is the part engines already handle.

### 4.2 Plan format

Specified in **[contracts/plan-format.md](../contracts/plan-format.md)**.
Summary of the fixed decisions:

- Defined by us, versioned, **operational content only**: instantiation ops,
  core-module slice ranges, adapter module references, canonical-ABI
  descriptors for host-boundary functions, type tables, required intrinsics,
  resource-type metadata (dtor references).
- **No WIT-level fidelity** (no docs, no feature gates, no aliasing
  structure) — bindings generation reads WIT source instead (§9). This keeps
  the format small and stable.
- Encoding: JSON (the simplest thing that round-trips); revisit only if
  measurable.
- Deterministic: identical inputs (component bytes, translator build, flags)
  produce identical artifacts. This is what makes caching trivial (§10).

### 4.3 TS runtime

Platform-neutral core (dependencies: `WebAssembly` JS API, `TextEncoder`/
`TextDecoder`, Promises — nothing else; pinned by
`runtime/tests/platform_purity_test.ts`). Responsibilities:

1. Plan executor: compile sliced core modules and adapters, instantiate in
   plan order, wire imports/exports.
2. Host boundary: lift/lower per CABI descriptors (§8), `realloc`/
   `post-return` handling.
3. Resource machinery: slab handle tables, own/borrow tracking (`num_lends`,
   borrow invalidation at call return), dtor invocation (§7), FACT intrinsic
   implementations.
4. Instance-state rules: `may_leave` enforcement and poisoned-instance
   refusal — **JSPI enforces no Component Model invariant for us**; the
   state discipline is ours and must hold while suspended. (The spec has no
   reentrance gate — reentrance into a live instance is valid; the only
   entry refusal is the poisoned-corpse divergence, §6.)
5. Task scheduler (§6): the 0.3 task/thread model is the runtime's core
   structure, not an add-on — waitable sets, streams/futures, callback-ABI
   event dispatch, backpressure, cancellation. Sync calls are the degenerate
   case: a task driven to resolution before the call returns, exactly as in
   the reference implementation.

Above the raw boundary sits the **embedder conventions layer**
(`runtime/src/embedder/`, governed by
[contracts/embedder-api.md](../contracts/embedder-api.md)): camelCase facades,
branded `ComponentException`s, resources as classes in both directions, `Stream`/
`Future` handles over web-native producers, and semver-canonical import
resolution matching the spec + wasmtime's `NameMap`.

## 5. The JSPI frame rule (load-bearing constraint)

From the JSPI spec ([js-promise-integration Overview]):

> Only WebAssembly computations may be suspended: **only WebAssembly frames may
> be active between the call to a `promising` function and any call to a
> `Suspending` wrapped import** — a JS frame in between traps.

Consequences baked into this design:

- **Host boundary JS glue is safe.** A `Suspending`-wrapped import's JS runs to
  completion and returns a Promise; suspension happens after it returns, so
  host-side lift/lower in JS never sits on the suspended stack.
- **Cross-component glue must be wasm.** A JS adapter between components A and
  B would trap the moment anything below it suspends. FACT adapters keep those
  stacks pure wasm — this is why §4.1 is the cornerstone.
- **Component exports invoked from JS** that may transitively suspend must be
  entered through `WebAssembly.promising` trampolines. This includes
  JS-initiated resource drops (§7).
- **Guest-initiated cross-component dtor calls** route through generated wasm
  (direct funcref call in the adapter/intrinsic path), not a JS bounce.

## 6. Concurrency (the core deliverable)

Existing hosts handle non-async components adequately; 0.3.0 concurrency is
why this project exists. The runtime is therefore designed around the 0.3
task model **from day one** — sync-only operation falls out as the degenerate
case, exactly as in the reference implementation (`definitions.py`, where
`canon_lift` always creates a Task/Thread and the sync path is a driving loop
over the same structures). This ordering was deliberate: retrofitting the task
model onto a sync-first runtime is the rearchitecting we were not allowed to
need. (It is also, empirically, the rearchitecting jco is stuck in — see
[consumers.md](consumers.md).)

Mapping the reference model onto the web platform:

| Reference concept | Implementation |
|---|---|
| `Thread` (suspendable computation) | wasm activation entered via `WebAssembly.promising` |
| `Thread.wait_until` / blocking | call to a `Suspending` import returning a scheduler-controlled Promise |
| resume | scheduler resolves that Promise (event-loop turn) |
| scheduler | JS event loop + explicit ready queues; cooperative, matching the CM model — no preemption exists or is needed |
| `Waitable` / `WaitableSet` | host-side event structures; `wait` = suspension (stackful) or the callback return-code protocol (stackless) |
| callback ABI | no suspension at all: the scheduler invokes the callback export with events |
| sync `canon_lift` driving loop | same scheduler: pump ready threads until resolved, with the spec's deadlock trap |
| `Subtask`, backpressure, cancellation | direct ports of the reference structures |

JSPI's three roles, precisely:

1. **Stackful async lifts** (no-callback `async`) — the guest blocks mid-stack.
2. **Blocking sync lowers** — a caller waiting on an unresolved subtask
   (`thread.wait_until(subtask.resolved)` in the reference).
3. **Sync guests over async host imports** — falls out of the same mechanism;
   a useful capability, not a separate deliverable.

The callback ABI needs no JSPI (stackless by design). Empirical confirmation
(reconfirmed by every consumer artifact): wit-bindgen emits **exclusively
callback-ABI async lifts**, and componentize-go likewise — running real async
guests requires the task core, not JSPI.

Determinism: the reference scheduler makes explicitly nondeterministic
choices (`random.choice` over ready threads). **Decided:** deterministic
FIFO ready-queue by default; a seeded-shuffle mode (`POLYENGINE_SCHED_SEED` env
var) exercises the spec-allowed nondeterminism in tests, verified across
seeds. Documented at `runtime/src/task/scheduler.ts`. A load-bearing
architectural rule: **one driver per store** — concurrent `driveAsync` loops
can double-resume threads; between export calls the two fallback drivers
stand down whenever an export-call driver is live (the invariant and its
benignity argument are documented at the site in
`runtime/src/exec/boundary.ts`). There are exactly three drivers: export
calls, the host-activity pump (embedder stream/future operations landing
between calls), and the settlement pump, which services host-import
settlements that land while the store is driver-idle. The settlement pump is
what gives background tasks host-driven liveness between export calls (a
task parked on a waitable set whose pending host call is a clock resumes at
settlement time); wasmtime only delivers such wakeups while the embedder
dwells in `run_concurrent`, but a JS host's event loop is always dwelling,
so polyengine makes it unconditional.

Named divergence ([#92](https://github.com/polymorph-components/polyengine/issues/92)):
**the async form of `subtask.cancel` is not atomic under jspi.** The
reference built-in returns `[BLOCKED]` with no suspension; polyengine parks the
caller on a determinacy wait so the BLOCKED/resolved answer matches the
reference's synchronous-delivery outcomes across the engine's mandatory
microtask hop (jspi pin (j), pinned by `cancellable.wast`). While parked,
other ready threads of the store may run, so sibling-task effects can become
observable across the single built-in call — a reordering *within* the
reference's own `Store.tick` freedom, taken one built-in early; every
interleaved sibling was already at a block point. Rationale and mechanics at
the site (`runtime/src/intrinsics/async_builtins.ts`, the determinacy park
in `createSubtaskCancel`); regression pinned across seeds by
`runtime/tests/cancel_bracket_race_test.ts`.

**Host-import cancellation resolves promptly by default.** The reference
leaves a host callee's `on_cancel` to the embedding (`Store.invoke`,
definitions.py line 572); wasmtime hosts hand back a future whose drop *is*
cancellation. A JS Promise offers no such channel, so polyengine's lowered
host imports answer with the reference's prompt-cancel shape —
`on_cancel = () => on_resolve(None)` — resolving the subtask
CANCELLED_BEFORE_RETURNED and discarding the promise's eventual settlement
(never lowered, rejections unreported, deregistered from deadlock
accounting). This is a reference-legal host behavior, not a divergence; the
per-declaration `deferCancel()` brand (contracts/embedder-api.md
§"Functions and async") restores run-to-completion for imports with commit
points. The host operation itself is never interrupted — only delivery is
cancelled. `abortable()` closes that gap for hosts that can be stopped: a
marked import receives a fresh `AbortSignal` appended after its
WIT-declared parameters on every call, and the runtime aborts it a
microtask after the discard — never synchronously inside
`canon_subtask_cancel`, so a host abort listener never runs inside a live
guest activation. Whatever settlement the abort provokes (typically an
`AbortError` rejection) arrives with the subtask already resolved and lands
on the resolved-subtask guards, discarded like any other late settlement.

Named divergence ([#173](https://github.com/polymorph-components/polyengine/issues/173)):
**per-instance poisoning is polyengine's only entry refusal.** A trap that
escapes a guest activation marks the instance's corpse
(`poisonedInstances`); every entry site refuses a marked instance
permanently, naming the original trap
([#145](https://github.com/polymorph-components/polyengine/issues/145)).
The reference has no instance-level trap state at all and wasmtime kills
the whole store on trap, so per-instance corpse semantics — sibling
instances of the same instantiation stay usable — is purely this runtime's
choice, pinned by `builtin-trap-poisons-instance.wast`'s substring
expectations and the runtime poisoning suites. The same-instance exemption
(`caller === callee` passes vacuously) is preserved in the refusal guard
for the dtor self-drop path. There is no reentrance gate besides this:
the spec removed `may_enter`/`entering_set`
([CM#705](https://github.com/WebAssembly/component-model/pull/705)), and
reentrance into a live instance — host-mediated or otherwise — is simply
valid.

## 7. Canonical ABI decisions

Authority: [CanonicalABI.md] and its executable reference
(`design/mvp/canonical-abi/definitions.py`). Where the host has freedom, we
decide deliberately and document here.

- **Strings.** Component strings are USV sequences; JS strings are WTF-16.
  Lowering a JS string with lone surrogates uses WebIDL `USVString`
  replacement semantics (U+FFFD). Guest→host lift via `TextDecoder`;
  host→guest lower via `TextEncoder.encodeInto` directly into guest memory.
  `latin1+utf16` is implemented in the v1 interpreter (wit-bindgen guests
  themselves use utf8).
- **Numbers.** `u64`/`s64` ↔ `BigInt`; everything else ↔ `number`.
  `list<u8>` ↔ `Uint8Array` (copy; views into guest memory are never
  exposed — with one deliberate, scoped exception: the `stream<u8>`
  direct-access sessions of contracts/embedder-api.md §"Streams and
  futures" hand the callback a view over the peer guest's landing zone or
  unread bytes, valid only for that synchronous callback, so an external
  byte mover's last hop can BE the one ABI copy). Both directions are bulk
  copies: lift via a `Uint8Array` slice, lower via `Uint8Array.set`
  (issue #54 — the per-element interpreted store cost ~45 ns/byte and
  capped host→guest byte traffic at ~22 MB/s). Stream payload copies share
  these paths, and u8 stream chunks stay `Uint8Array` through host buffers
  too, so a host-side stream read costs exactly the one rendezvous copy.
  Lists of the other flat element types (bool, s8, u16–u64/s16–s64,
  f32/f64) keep their plain-array host shapes but also copy bulk, through
  TypedArray views with the deterministic profile's NaN canonicalization
  preserved in both directions (issue #67); the platform's
  little-endianness is a named assumption checked once, with the DataView
  per-element path as the big-endian fallback. `char` stays per-element
  (its lift is per-element USV validation).
- **Memory views** are re-acquired after any call that can grow memory
  (`ArrayBuffer` detach on `memory.grow`).
- **Resources.** Host-facing handles are classes with `Symbol.dispose`
  (TS `using`), an explicit `[Symbol.dispose]()`/`drop()`, and a
  `FinalizationRegistry` backstop for leaks. (Backstop-vs-teardown ordering
  policy: open, [#10](https://github.com/polymorph-components/polyengine/issues/10).)
- **Destructors.** Per spec (CanonicalABI.md §`canon resource.drop`): the dtor
  is a core function `[rep] -> []`, invoked as a normal **non-async**
  cross-component call — *"the destructor may not block. However, the
  destructor may spawn a cooperative thread that does."* Dtor entry into a
  live instance is valid; a poisoned implementing instance refuses (§6
  divergence, with the same-instance exemption preserved for self-drops),
  and a trapping dtor poisons the **implementing** instance
  (`runtime/src/cabi/handles.ts` `callDtorGated`).
  Host policy:
  - CM-level blocking in a dtor → deterministic trap (falls out of general
    sync-task rules).
  - Host-import latency is invisible to CM semantics; a dtor calling a
    `Suspending` host import is legal but needs a suspension-legal stack:
    JS-initiated drops (`using`, FinalizationRegistry) enter via a `promising`
    trampoline (`ResourceTypeInfo.dtorHost`, wired by the executor in jspi
    mode for suspension-capable dtors — a non-suspendable dtor keeps the
    exact synchronous path, avoiding the promising microtask hop's
    one-turn entered window; the async entry bracket is held until the
    activation settles, tracked in `pendingHostCalls`). **Known
    limitation**: a *guest*-initiated drop reaches the dtor through a JS
    trampoline frame, not the §5 pure-wasm funcref path — a Suspending
    import under it is a deterministic JSPI frame-rule trap, not a
    supported suspension. The pure-wasm dispatch path is future machinery;
    until then §5's "guest-initiated dtor calls route through generated
    wasm" is aspiration, not description.
  - Host-held own handles carry lend tracking mirroring `num_lends`
    ([#86](https://github.com/polymorph-components/polyengine/issues/86)):
    drop/GC-backstop defer while lent; a backstop dtor trap poisons the
    implementing instance and lands on the host-failure channel (never
    `catch {}`-swallowed).
  - Upstream spec findings related to drops and backpressure are tracked in
    [upstream-component-model-repo-findings.md](../upstream-component-model-repo-findings.md),
    the single source for component-model issue/PR filing. Implementation is
    sync-only drop regardless of upstream timing.
- **Component `value` imports/exports** (the component-level `value`
  definition feature): wasmtime doesn't implement them; excluded from parity
  scope. Note the official suite's `test/values/` directory is **not** this
  feature — it is plain canonical-ABI value-passing tests (`canon lift` with
  memory options) and is fully in scope.
- **Reentrance**: the spec has no reentrance gate; the only entry refusal is
  the poisoned-instance divergence (§6, enforced per §4.3 item 4).

## 8. Performance strategy

Requirement: not critical now; must become fast **without rearchitecting**.

- **Cross-component calls are already the fast path**: FACT adapters, pure
  wasm, no JS in the hot path. Nothing to do later.
- **Host boundary** has two executors over one IR — specified in
  **[contracts/descriptor-ir.md](../contracts/descriptor-ir.md)**:
  - The shim emits **CABI descriptor tables** (a compact ops IR per function).
  - v1: a generic interpreter walks descriptors. CSP-clean, everywhere.
    This is what ships today; it has been fast enough for every consumer
    gate so far.
  - v2 (when a gap is measured — gated on
    [#17](https://github.com/polymorph-components/polyengine/issues/17), not the calendar;
    [#8](https://github.com/polymorph-components/polyengine/issues/8)): a generator from the
    same descriptors to specialized JS **modules** — emission-only, never
    `eval`/`new Function` (§3's CSP invariant). One mechanism, two
    invocation times: a deploy-time AOT step, or — on server hosts
    (Deno/Node, no CSP) — first-load emission into a cache directory and
    `import()`; pre-warming and freezing that cache *is* the AOT step.
    Browsers running dynamically-loaded components stay on the interpreter.
    The generated-module contract is AOT-shaped from day one (explicit
    linking context; no closure capture of live runtime state) so both
    invocation times share one artifact. Two executors over one IR double
    as a differential-testing oracle — exercised by importing emitted
    modules, i.e. the production delivery mechanism itself.
- Disciplines adopted from the start because they're hard to retrofit: slab
  handle tables; no per-call closure/object allocation on hot paths; view
  reuse with grow-aware invalidation; `encodeInto` for strings.
- Future options, noted not planned: JS string builtins (now widely shipped)
  for string-heavy host boundaries. Deploy-time unbundling (real URLs per
  module → engine code-cache hits) is a packaging concern independent of the
  executor choice and lives on the caching track (§10,
  [#7](https://github.com/polymorph-components/polyengine/issues/7)).

## 9. Bindings generation

- A Rust CLI crate (`crates/bindgen`) built on **wit-bindgen-core**, consuming
  `wit_parser::Resolve` + `WorldId`. **WIT source is the input** — the plan
  cannot reproduce high-fidelity bindings (docs are lost in binaries, feature
  gates are resolved away, aliasing is flattened) and the
  bindings-before-any-component workflow requires WIT anyway.
- Output: TypeScript — typed world/interface APIs, `.d.ts`, resource classes
  (`using`-compatible), JSDoc from WIT doc comments, honoring
  `@since`/`@unstable` gates.
- Generated bindings import the runtime through a configurable base
  (`--import-base`), defaulting to the versioned JSR specifier
  `jsr:@polyengine/runtime@^<runtime/deno.json version>` (derived at build
  time, never hand-written). A path or URL base addresses files
  (`{base}/{module}/mod.ts`); a bare or registry base addresses package
  exports (`{base}/{module}`) — `--import-base --help` states the rule and
  its scheme fallback in full. The in-repo fixtures use the relative base
  `../../../src` so `deno check` stays offline and on this checkout's source.
- Host-facing value conventions (error model, stream/future wrappers,
  variant/option/result shapes, resource classes, module-per-interface
  authoring) are governed by the embedder conventions contract
  (**[contracts/embedder-api.md](../contracts/embedder-api.md)**). Bindgen
  also emits host-side types for **import worlds** (what an embedder must
  provide), not only export-side facades — the consumers' host modules
  ([consumers.md](consumers.md)) are the reference consumers of that surface.
- **Skew protection, the wasmtime way**: the generator embeds a canonical
  structural digest of the expected world into the bindings
  ([contracts/digest.md](../contracts/digest.md)); `instantiate()` verifies it
  against the loaded component's types (already computed by the translator)
  and fails fast with a useful diff. Compile-time fidelity from WIT; load-time
  truth from the binary.
- Secondary, degraded mode: bindings from a component binary via its decoded
  types (structure only, no docs). For third-party components; never primary.
- Guest-side bindings are stock wit-bindgen (Rust et al.) — that toolchain is
  the compatibility target, exercised by its own runtime tests (§11).
- Version pinning: wit-parser/wasm-tools pinned to the same versions as the
  translator's wasmtime, so WIT feature resolution matches.

## 10. Caching

Two independent layers; nothing may *depend* on the second.

1. **Artifact cache (ours, bytes only).** `runtime/src/cache/` —
   content-addressed by `(component sha256, translator build hash, features)`;
   deterministic translation makes this trivial. Storage: Cache API in
   browsers (`webCache`), a cache directory in Deno (`dirCache`). Skips the
   translation stage on reload. The plan is stored, never the component bytes
   (the plan slices the component by offset; whoever holds the cache key
   already holds the bytes).
2. **Engine code caches (opportunistic).** Chrome's wasm code cache is keyed
   by URL but anchored to the **HTTP resource cache entry** (invalidation via
   304/200 semantics + V8 version), applies only to
   `compileStreaming`/`instantiateStreaming`, and only to modules **≥ 128 kB**
   after full tier-up. Consequences:
   - Service-worker-**synthesized** responses get streaming *compilation* but
     no persistent code cache (no HTTP cache entry to anchor to). Same
     conclusion in Firefox (alt-data on HTTP cache entries). Safari: no
     persistent wasm code cache known.
   - FACT adapters are kilobytes — under the threshold, never code-cached
     anyway. Only large sliced core modules matter; recurring cost is
     re-tier-up CPU, not startup latency (Liftoff is fast).
   - If a deployment has a build step: run the translator there (same wasm,
     under Deno) and publish artifacts at real URLs → full engine caching with
     zero tricks. Optionally warm via service-worker install-time
     `compileStreaming` of those real URLs.
   - Empirical verification of the code-cache behavior is open:
     [#7](https://github.com/polymorph-components/polyengine/issues/7).

Trust boundary (recorded lean, not yet forced by anything): trust locally-run
translation; never trust artifacts that did not come from the local cache
keyed by component hash. The runtime re-validates plan structure at load
(strict `formatVersion`, schema checks) but does not re-verify that artifacts
faithfully derive from the component bytes. Consequence for embedders — write
access to a cache root is worth about what write access to the component files
is worth: see [security.md](security.md) "The artifact cache is a trust input",
which carries the pre-warmed read-only-cache recipe.

No cache failure may fail a translation
([#196](https://github.com/polymorph-components/polyengine/issues/196)): a
`get`/`put`/self-heal-eviction failure — an unwritable root included — degrades
to a fresh translation, reported only through `translateCached`'s opt-in
`onCacheError`. That is what makes a read-only cache root a usable deployment
rather than a crash. The public `evict()` still throws for explicit callers.

## 11. Conformance and testing

There is no single official conformance suite; the corpus is assembled:

| Source | What | How used |
|---|---|---|
| [WebAssembly/component-model] `test/` | official, growing WAST suite: `binary/`, `validation/`, `linking/`, `resources/`, `values/`, `async/` | git submodule; primary gate, all directories in scope. Independent check on the wasmtime-frontend reuse. |
| same repo, `design/mvp/canonical-abi/definitions.py` + `run_tests.py` | executable CABI reference | lift/lower edge-case tests ported to TS unit tests (`runtime/tests/`) |
| wit-bindgen runtime tests | guest programs exercising bindings | Rust guests, sync and async (wit-bindgen + `wasm-tools component new`), run against our host = the executable wit-bindgen-compat claim (`examples/guests/`) |
| wasmtime `tests/misc_testsuite/component-model/` | engine-grade wast corpus | supplementary coverage |
| polymorph conformance matrices (webcrypto/websocket/webrtc/tls, driven by polymorph-test) | per-interface implementation×environment conformance suites over real WIT surfaces | consumer lane ([consumers.md](consumers.md)): `ct-runner` executes them |
| experiment-mosh gates + minimized repros (`compose-async-tdz`) | composed 3-component client: mixed sync/async exports, background pumps, resources re-exported across interfaces, componentize-go guest | strongest known real-workload exercisers — this family surfaced ≥5 distinct jco defect classes no WAST corpus expresses (`tools/smoke-c0/`) |

Harness pipeline: an offline Rust step (`crates/testgen`) converts `.wast`
into JSON commands + `.wasm` binaries — the core-spec `wast2json` model. It
uses the `wast` crate directly (the pinned wasm-tools CLI's bundled parser
predates current suite syntax; owning the emitter also lets us tag every
artifact `core` vs `component`, which the harness needs since V8 cannot even
validate component binaries). The TS harness executes the JSON identically
under `deno test` and in browsers (`tools/browser/run-lane.ts`: static
server + automated Chromium / Firefox-with-pref / WebKit, with per-lane
expectation overlays and stale-delta detection) — and directly under engine
*shells* and server runtimes (`tools/shell/run-lane.ts`: SpiderMonkey `js`,
JSC `jsc`, and node/bun via a host preamble; same classification machinery,
no browser). Because the corpus is engine-shaped, the per-push/PR engine
gates are the **pinned shell lanes** (`sm-pinned` = the Firefox-release
shell matching the browser lane, `jsc-pinned` = a sha256-mirrored trunk
build, `node-pinned` = the node ≥ 26 runtime; `bun-pinned` rides along
findings-only until it has a track record; `tools/shell/pins.json`);
browser lanes run post-merge, verifying the embedding and shipped-channel
configs and gating the prerelease. Trunk/nightly shells and a Deno-canary
probe run weekly as findings-only canaries (`.github/workflows/canary.yml`)
with a capability-probe preamble that surfaces wasm-proposal landings
(multi-memory, GC, EH, memory64, …) before the corpus exercises them.

Also planned: differential testing of the interpreter vs emitted
specialized-JS modules (§8, [#8](https://github.com/polymorph-components/polyengine/issues/8));
differential fuzzing
against native wasmtime with `wasm-smith`-generated components
([#9](https://github.com/polymorph-components/polyengine/issues/9)).

Epistemic note: because our frontend *is* wasmtime's, wasmtime-derived tests
partly test wasmtime against itself — weight the official suite and
definitions.py ports accordingly. And passing suites is necessary, not
sufficient: the consumer workloads found real defects that no WAST corpus
expresses — which is why the in-repo smoke legs (`just smoke-tls`,
`just smoke-c0`) are kept as gates, and the consumers' own matrices as
high-yield sanity checks ([consumers.md](consumers.md)).

## 12. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| wasmtime internal API churn (`wasmtime-environ` is internal/unstable) | medium, recurring | shim isolation + version pinning; upgrades are deliberate events ([#1](https://github.com/polymorph-components/polyengine/issues/1)) |
| JSPI phase-4 drift | medium | small trampoline surface, centralized; track proposal |
| Safari: stable-channel JSPI status unverified | accepted | floor is explicit; JSPI unflagged on WPE 26.5, and Safari Technology Preview carries JSPI + multi-memory — stable channel is the remaining gap ([#11](https://github.com/polymorph-components/polyengine/issues/11)); callback-ABI consumers don't need it |
| JSC/SpiderMonkey engine gaps | medium | Deno-first dev; file upstream. SpiderMonkey JSPI is clean over the full corpus (pref-flipped); **JSC's real gap was missing multi-memory** (capped the WebKit lane — the CABI routinely needs >1 memory per module), not JSPI. Resolved in WebKit trunk: default-on from the webkit-2342 playwright roll, lane at effective parity there ([#11](https://github.com/polymorph-components/polyengine/issues/11)) |
| Testing wasmtime-with-wasmtime blind spots | medium | official suite + definitions.py ports as independent checks; consumer suites as real-workload sanity checks |
| Testing-toolchain format skew: testgen assembles with `wast` 255 while the shim validates with wasmparser 0.252 (wasmtime-47 pin) — the 0.253–0.255 window re-arited 🧵 thread opcodes (byte-level desync) | low, bounded | known 5-entry xfail set; exits on the wasmtime bump ([#1](https://github.com/polymorph-components/polyengine/issues/1)); testgen cannot downgrade (suite text syntax needs `wast` ≥255) |
| CSP variance in embedders | low | baseline needs only `wasm-unsafe-eval` — an invariant, no path may require full `unsafe-eval` (§3); specialized JS is emission-only, deploy-time or server-side cache import ([#8](https://github.com/polymorph-components/polyengine/issues/8)) |
| Consumer coupling churn: 7+ downstream repos tracking pre-1.0 plan/contract formats | medium | caret-honest registry releases ([#16](https://github.com/polymorph-components/polyengine/issues/16)): still 0.x/unstable, compatible within a minor line, breaking changes bump the minor — consumers couple by caret; `pre-<shorthash>` prerelease artifacts (exact pins) and git refs track `main` between releases; strict formatVersion equality already fails loud |
| Consumer scope creep pulling WASI implementations into the core | medium | the wasi package is a separate deliverable with consumer-driven scope; §2 non-goal stands |
| Host-boundary perf vs jco's generated JS (v1 interpreter) | low-medium | translation throughput measured (multi-MB components in tens of ms); cutover benches tracked with [#8](https://github.com/polymorph-components/polyengine/issues/8) |

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model
[CanonicalABI.md]: https://github.com/WebAssembly/component-model/blob/main/design/mvp/CanonicalABI.md
[js-promise-integration Overview]: https://github.com/WebAssembly/js-promise-integration/blob/main/proposals/js-promise-integration/Overview.md
