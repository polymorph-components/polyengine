# Contract: Host Intrinsics v0

Everything the TS runtime must provide to wasm it did not author: (A) imports
of FACT-generated adapter modules, and (B) host trampolines referenced from
the plan (`CoreDef::Trampoline` / `lower-import`). Producers of the
requirement: the translator shim (per-plan manifest). Implementor: the runtime
(`runtime/src/intrinsics/`).

Status: **v0.3** (amended post-M0, post-M1, and at the CM#705 pin advance —
see amendment sections).

Sources of truth (pinned `wasmtime-environ 47.0.3`):
- (A) `wasmtime_environ::fact::Import` — every import FACT can emit.
- (B) `wasmtime_environ::component::Trampoline` — every host trampoline the
  plan can reference.
The shim must fail translation with a clear error if it encounters a variant
not yet representable in the plan (never silently drop).

## Universal semantics

1. **Synchronous, non-suspending.** Every intrinsic and trampoline body runs
   to completion in JS and returns. JS frames here are compatible with JSPI
   because they complete before any suspension occurs (docs/architecture.md §5). An
   intrinsic that needs to wait is a design error — waiting belongs to the
   task core.
2. **Traps** are thrown as the runtime's `ComponentTrap` and must not be
   catchable by guest code (they propagate through wasm as JS exceptions).
3. **Reentrance/state rules** (instance flags, `task_may_block`,
   enter/exit bookkeeping) implement the Component Model invariants — the
   engine (JSPI) will not enforce them for us.

## A. FACT adapter imports

Import-module namespaces observed in generated adapters (spike, S0):
`sync`, `async`, `transfer`, `transcode`, `callee`, `post_return`, `m<N>`
(memories), `f<N>` (funcs), `flags`, `runtime`, `instance`, `callback`.

By `fact::Import` variant — implementation obligations:

| Variant | Obligation (v0) |
|---|---|
| `CoreDef` wiring (callee funcs, memories, instance flags globals, `TaskMayBlock` global) | resolved from plan `CoreDef` encoding; flags are real `WebAssembly.Global(i32, mutable)` per component instance; `task-may-block` is one runtime-managed mutable global |
| `Trap` | throw `ComponentTrap` |
| `EnterSyncCall` / `ExitSyncCall` | sync-call task bookkeeping (task core; degenerate-case implementation in M0: assert-and-count) |
| `Transcode` (all ops: copies + utf8/utf16/latin1 conversions) | TextEncoder/TextDecoder + typed-array copies against the adapter-referenced memories; op enumeration follows `fact::Transcode` |
| `ResourceTransferOwn` / `ResourceTransferBorrow` | handle-table moves between component instances (M1, resources milestone) |
| `PrepareCall` / `SyncStartCall` / `AsyncStartCall` | task-core call protocol (M2; sync fixtures may hit `PrepareCall`+`SyncStartCall` earlier — implement as sync task bracket) |
| `FutureTransfer` / `StreamTransfer` / `ErrorContextTransfer` | async handle moves (M2) |

## B. Host trampolines (`Trampoline` enum)

Grouped by milestone at which the runtime must stop instantiate-failing them:

- **M0**: `LowerImport` (host function call through descriptor-IR lift/lower),
  `ResourceDrop` (sync path incl. dtor call rules of docs/architecture.md §7 — needed as
  soon as resources fixtures run, may slip to M1), `TaskReturn` (needed by
  any callback-ABI guest; M0 hello is sync — instantiate-fail is acceptable
  until M2 if unreferenced).
- **M1**: `ResourceNew`, `ResourceRep`, `Transcoder` (trampoline form).
- **M2 (task core)**: `BackpressureInc/Dec`, `TaskReturn`, `TaskCancel`,
  `WaitableSetNew/Wait/Poll/Drop`, `WaitableJoin`, `ThreadYield`,
  `SubtaskDrop/Cancel`, `Stream*`, `Future*`, `ErrorContext*`, `ContextGet/Set`.

(The authoritative variant list is the enum itself; this table asserts the
schedule, not the inventory. The shim emits the full typed list into
`plan.json` `trampolines`; the runtime's coverage assertion at instantiate
time is what keeps this table honest.)

## Manifest

`plan.json` carries, per adapter module, its full import list categorized by
the table in §A (`modules[].intrinsics`), and the full `trampolines` table.
The runtime asserts coverage at instantiate time and reports *which
milestone's* obligations are missing — "this component needs the M2 task
core" is a feature, not a crash.

## Open items (v0)

- Exact `Transcode` op inventory to implement in M0/M1 (drive from fixtures:
  utf8 copies first; the full matrix is already reference-tested in
  `runtime/src/cabi/strings.ts`).
- `UnsafeIntrinsic` (`CoreDef` variant): **resolved at M2 phase 1** — now
  wire-represented per plan-format.md v1 amendments; the four
  `context-{get,set}-i32-{0,1}` symbols are implemented (per-thread storage),
  the 17 raw-host-memory symbols are refused at instantiate time.

## v0.1 amendments (post-M0 reality)

1. **§A collapses into CoreDef wiring.** `translate/adapt.rs`
   (`fact_import_to_core_def`) folds *every* `fact::Import` into
   instantiation-argument `CoreDef`s — the runtime never sees `fact::Import`
   directly. Intrinsic-like imports arrive as `CoreDef::Trampoline` entries
   (Trap, Enter/ExitSyncCall, Transcoder, ResourceTransfer*, PrepareCall,
   *StartCall, *Transfer) or plain wiring (callee funcs, memories, flags
   globals, task-may-block). The per-adapter manifest is import-names ×
   resolved args, categorized — which is exactly what the shim emits.
2. **Instance flags decided** (was an open item): one
   `WebAssembly.Global(i32, mutable, initial 1)` per component instance
   serves as both the FACT-visible flags global and host-side `may_leave`;
   FACT 47 reads/writes it as a plain 0/1 boolean (no bitmask).
   `may_enter` is host-only state, not in the global.
3. **`task-may-block` initial value = 1** (sync tasks may block).
4. **`Trap` carries an i32 code.** v0.1 maps all codes to `ComponentTrap`;
   enumerate codes later for diagnostics.
5. **Lazy materialization is the general rule**: trampolines/intrinsics are
   materialized at first *reference during instantiation* — unreferenced
   unsupported kinds never fail, referenced unsupported kinds fail at
   instantiate time with a milestone-aware message. ("Instantiate-time, never
   call-time" is preserved.)

## v0.2 amendments (post-M1)

1. **ResourceTransfer semantics pinned**: `resource-transfer-borrow`
   registers the source handle as a lender on the current sync-call scope
   and increments `num_lends` **unconditionally — borrow handles may be
   re-lent onward** (`definitions.py lift_borrow`/`Subtask.add_lender`; a
   lent handle blocks `resource.drop` until the call returns). Same-instance
   transfers take the rep fast path but still register the lender.
2. **Trap-unwind obligations**: when a trap escapes a FACT sync-call
   bracket, the host must unwind sync-call scopes (releasing lenders) AND
   restore `may_leave` on all component instances — FACT clears it around
   lift/lower and a trap skips its restore; without both unwinds the
   instance is unusable for post-trap re-entry, which this runtime
   deliberately supports. **Scope clarification (2026-08-10, polyengine#91):
   the obligation covers every window that registers lenders, including
   the prepare/start protocol** — `sync-start-call`'s inline lender scope
   and `async-start-call`'s subtask-attached lenders release on every
   non-success exit that does not poison the caller (trap rethrow AND
   capability signals: `NeedsJspi` is expressly non-poisoning and must not
   strand lenders).
3. **Host-trap preservation across nested barriers**: the trap trampoline
   must (re)record the pending trap before every throw, so the specific
   message survives arbitrarily nested adapter exception barriers. Residual,
   documented limitation: our traps are JS exceptions, so a guest
   `try_table catch_all` can observe them mid-flight (wasmtime's are
   unforgeable); full unforgeability would need an out-of-band poison flag.
4. **`Transcoder` trampoline parameters are plan-visible**: `op` (one of the
   12 `Transcode` ops), `from`/`to` runtime-memory indices, `from64`/`to64`.
   Semantics authority is wasmtime's libcalls (partial-progress primitives
   driving FACT's realloc/retry protocol), NOT definitions.py's whole-string
   transcoding model. All 12 ops implemented and reference-tested.
5. **Trap messages align to wasmtime's `Display for Trap` texts** (with the
   `wasm trap: ` prefix where wasmtime uses it) — the official suite asserts
   these strings, and wasmtime-compat is a plan goal.
6. **v0.3 discussion item** (from `values/variants.wast:83`): one
   async-lifted export currently makes a component's sync exports
   unreachable (instantiate-time refusal of `task-return`). The rule is
   correct per #5; a future amendment could permit lazily-trapping
   trampolines for exports the embedder never calls — deliberate
   silent-acceptance tradeoff, not adopted without discussion.

## v0.3 amendments (CM#705 adoption, 2026-08-30)

1. **The reentrance-gate portion of ground rule 3 is withdrawn**
   ([#173](https://github.com/polymorph-components/polyengine/issues/173);
   submodule pin `2f13265`). CM#705 removed `may_enter`, `entering_set`,
   and the `enter_from`/`leave_to` bracket from the reference: no intrinsic
   or trampoline checks or takes a reentrance gate anymore, and reentrance
   into a live instance (host-mediated, dtor, `*-start-call`,
   `enter-sync-call`) is valid. What entry sites still enforce is
   **per-instance poisoning refusal** — a docs/architecture.md §6 named
   divergence, not a reference rule: a trapped instance's corpse refuses
   entry permanently with the recorded cause
   ([#145](https://github.com/polymorph-components/polyengine/issues/145)),
   with the same-instance exemption preserved for dtor self-drops.
   `may_leave`/flags-global behavior (v0.1 amendment 2) is unchanged;
   "`may_enter` is host-only state" there is historical — the state no
   longer exists. The `ComponentInstanceState` model fields
   (`mayEnter`, `parent`, the synthetic root) remain defined but inert
   pending the plan-format amendment that deletes them.

## JSPI integration constraints (M2 phase 3, empirically derived)

Every one of these is pinned by a test under `runtime/tests/jspi/`; they
generalize to any JS host of the 0.3 task model and are the distilled cost
of three debugging rounds.

1. **The `current_thread()` ambient has no free implementation in JS.**
   definitions.py resolves the running task via a thread-local, exact
   because its threads are OS threads. A JSPI host gets resumed in a
   microtask outside every frame it controls. Two working mechanisms, both
   pinned: (h) `AsyncLocalStorage` propagates across a resumption (the
   engine registers its continuation at suspension time, inside the host's
   frame); (i) a resumed activation runs strictly before the host regains
   control, so a single "resuming activation" slot is unambiguous between
   settling a suspension and the host's next turn. The slot mechanism
   needs no async-context support — the safer floor for a browser matrix.
   (Probe discipline: a suspension probe must call the import at least
   TWICE; a single-call fixture has no post-resumption observation point
   and reads indistinguishably from "context lost" — this produced a wrong
   verdict once.)
2. **"Task resolved" and "activation finished" are different events.**
   The reference collapses them (threads run to completion synchronously
   once resolved); a suspending host must model both. A guest may
   `task.return` and keep executing — the wit-bindgen producer pattern.
   Abandoning the activation on resolution leaks task state (exclusive
   thread, table slots); waiting for it deadlocks producers. Required: a
   detached-but-live activation the scheduler keeps servicing after the
   export call returns. Corollary: **audit every piece of host state
   assumed to nest within one export call** — our FACT sync-call bracket
   stack had to become per-task the moment activations could interleave.
3. **Resolve at most one suspension per scheduler turn.** Settling a
   Suspending import's Promise hands control to wasm in a microtask: the
   settling call returns with the activation not yet run. A tight
   `while (tick())` drain — natural for a purely cooperative scheduler —
   overwrites the ambient claim and mis-attributes the first activation's
   built-ins. `tick()` must refuse progress while a claim is live; drains
   must yield to the microtask queue. (Post-flip generalization: this is
   the special case of constraint 5.)
4. **The Suspending "fast path" still suspends** (pin (j),
   `fastpath_hop_test.ts`): a plain-value return from a Suspending import
   does NOT continue the wasm synchronously — the continuation is deferred
   to a microtask. Consequence: a promising-wrapped callee can never
   complete inside the call that entered it, so any caller that must
   observe an eager callee's completion (FACT `async-start-call` reporting
   subtask state) must park until the callee is **determinate**
   (resolved / finished / genuinely scheduler-parked) — never until
   *resolution* (that parks an async caller on its callee, which is
   forbidden by what async lowering means).
5. **Settled-tail atomicity**: between a suspension's settlement and the
   servicing of that activation's continuation ("tail"), no other
   scheduling decision may be made — the reference's synchronous
   run-to-completion resume, reconstructed. Implemented as eager
   settle-tagging (`Store.settled`), tick-refusal while a finished
   activation's bookkeeping is unserviced, and tails-first ordering in
   every driver.

Status: **auto-detection is ON by default** (M2 exit, commit 652c1dc):
all blocking sites lit, per-declaration suspendability classification
(async-form copy built-ins never block; sync forms do; cancel forms per
their own flag), `KNOWN_DIVERGENT` empty, the plain path pinned
zero-cost for sync-only components. One spot where wasmtime supersedes
definitions.py is implemented and tracked upstream: cancel-copy
completion superseding (CM-3). The former second spot — "entry-gating
ending at resolution-plus-block rather than activation end" — was a
mischaracterization of wasmtime corrected on 2026-08-10 (wasmtime holds
the gate for the whole invocation and defers the entry *decision*; see
upstream-component-model-repo-findings.md CM-4 and
[polyengine#43](https://github.com/polymorph-components/polyengine/issues/43), where the
evidence is distilled — exam kit archived at
`4f3351f:exams/wasmtime-exclusivity/`). polyengine's
release-at-resolution rule was **removed the same day**
([#43](https://github.com/polymorph-components/polyengine/issues/43)): the runtime now
implements the hold rule (gate lifetime = the core invocation, pristine
definitions.py shape) plus the deferred entry decision — an async-lowered
call reports STARTING only if the callee is still unstarted after the
callee instance's runnable work is drained to quiescence
(`Store.hasRunnableWork`, consumed by `createAsyncStartCall`'s
determinacy park). Suspendability classification is **unchanged** by the
migration: `async-start-call` was already `Suspending`-wrapped for the
determinacy park, and plain mode provably never needs the drain (without
JSPI a frame cannot park mid-invocation, so a held gate always belongs to
the currently-running activation — the one obstacle a drain cannot
remove); the plain path stays zero-cost for sync-only components.
Host-import lowers joined the suspension classification on 2026-08-10
(embedder-api.md amendment A1): a `suspending()`-marked import is a
genuine blocker — Suspending-wrapped, importer-contaminating (transitive
suspendability, so entries get promising-wrapped per pin (c)), and
evidence for auto-detection — with the park implemented as
`blockCurrentActivation` on the recorded settlement
(`readyFunc`-driven; result lowering deferred to `produce` so realloc
re-entry runs under the resume-time attribution claim, the issue-#24
discipline). The park is the reference's plain non-cancellable
`thread.wait_until(subtask.resolved)` (canon_lower line 2286); the gate
stays held across it (the #43 hold rule). UNMARKED sync-lowered
Promise-returning host functions still degrade to the clean `NeedsJspi`
capability signal in every mode — marking is the embedder's explicit,
per-declaration opt-in, never inferred. The zero-cost-sync-only pin
narrowed when wasi-shims' parking kernel went always-on (embedder-api.md
A5): its marked `block`/`poll` are auto-detection evidence, so any
wasi-consuming component runs jspi mode on JSPI engines — the plain path
stays zero-cost for components that are sync-only AND import no marked
providers (or instantiate with `jspi: false`). Pinned by
`runtime/tests/embedder/suspending_imports_test.ts` (park round trip,
resume-time realloc, pin-(c) start trap, refusal messages) and the
plain-mode guard in `runtime/tests/async_lower_test.ts`.
