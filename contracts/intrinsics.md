# Contract: Host Intrinsics

Everything the TS runtime must provide to wasm it did not author: (A) imports
of FACT-generated adapter modules, and (B) host trampolines referenced from
the plan (`CoreDef::Trampoline` / `lower-import`). Producers of the
requirement: the translator shim (per-plan manifest). Implementor: the runtime
(`runtime/src/intrinsics/`).

Sources of truth (pinned `wasmtime-environ`, git rev in the root `Cargo.toml`):
- (A) `wasmtime_environ::fact::Import` — every import FACT can emit.
- (B) `wasmtime_environ::component::Trampoline` — every host trampoline the
  plan can reference.
The shim must fail translation with a clear error if it encounters a variant
not representable in the plan (never silently drop).

## Universal semantics

1. **Synchronous, non-suspending.** Every intrinsic and trampoline body runs
   to completion in JS and returns. JS frames here are compatible with JSPI
   because they complete before any suspension occurs
   (docs/architecture.md §5). An intrinsic that needs to wait is a design
   error — waiting belongs to the task core.
2. **Traps** are thrown as the runtime's `ComponentTrap` and must not be
   catchable by guest code (they propagate through wasm as JS exceptions).
3. **Instance-state rules** (`may_leave` bookkeeping) implement the
   Component Model invariants — the engine (JSPI) will not
   enforce them for us. The spec has no reentrance gate (CM#705 removed
   `may_enter`/`entering_set`): reentrance into a live instance
   (host-mediated, dtor, `*-start-call`, `enter-sync-call`) is valid. What
   entry sites enforce instead is **per-instance poisoning refusal** — a
   docs/architecture.md §6 named divergence, not a reference rule: a
   trapped instance's corpse refuses entry permanently with the recorded
   cause, with the same-instance exemption preserved for dtor self-drops.

## A. FACT adapter imports

Import-module namespaces observed in generated adapters:
`sync`, `async`, `transfer`, `transcode`, `callee`, `post_return`, `m<N>`
(memories), `f<N>` (funcs), `flags`, `runtime`, `instance`, `callback`.

**Everything folds into CoreDef wiring**: `translate/adapt.rs`
(`fact_import_to_core_def`) folds *every* `fact::Import` into
instantiation-argument `CoreDef`s — the runtime never sees `fact::Import`
directly. Intrinsic-like imports arrive as `CoreDef::Trampoline` entries
(Trap, Enter/ExitSyncCall, Transcoder, ResourceTransfer*, PrepareCall,
*StartCall, *Transfer), `CoreDef::UnsafeIntrinsic` (the `context.{get,set}`
slot save/restore FACT wraps around `realloc` and `post-return`), or plain
wiring (callee funcs, memories, flags globals). The per-adapter manifest is import-names ×
resolved args, categorized — which is exactly what the shim emits.

Pinned decisions:

- **Instance flags**: one `WebAssembly.Global(i32, mutable, initial 1)` per
  component instance serves as both the FACT-visible flags global and
  host-side `may_leave`; FACT 47 reads/writes it as a plain 0/1 boolean (no
  bitmask).
- **`Trap` is one nullary import per trap code** (`runtime.trap<N>`); the
  code is a plan-visible field of the `trap` trampoline (plan-format.md),
  and every code maps to `ComponentTrap` with wasmtime's message text.
- **No eager sync-blocking check in adapters.** wasmtime #14146 removed the
  `task_may_block` global and the static same-instance/ancestor
  `cannot enter component` stub: a sync-typed function may call an
  async-typed function or blocking built-in, and the trap fires only if it
  actually has to block with no runnable thread left (the scheduler's
  deadlock trap, definitions.py `Thread.wait_until`/`switch`). Reentrance is
  allowed except into a trapped instance.
- **ResourceTransfer semantics**: `resource-transfer-borrow` registers the
  source handle as a lender on the current sync-call scope and increments
  `num_lends` **unconditionally — borrow handles may be re-lent onward**
  (`definitions.py lift_borrow`/`Subtask.add_lender`; a lent handle blocks
  `resource.drop` until the call returns). Same-instance transfers take the
  rep fast path but still register the lender.
- **Trap-unwind obligations**: when a trap escapes a FACT sync-call
  bracket, the host must unwind sync-call scopes (releasing lenders) AND
  restore `may_leave` on all component instances — FACT clears it around
  lift/lower and a trap skips its restore; without both unwinds the
  instance is unusable for post-trap re-entry, which this runtime
  deliberately supports. The obligation covers every window that registers
  lenders, including the prepare/start protocol — `sync-start-call`'s
  inline lender scope and `async-start-call`'s subtask-attached lenders
  release on every non-success exit that does not poison the caller (trap
  rethrow AND capability signals: `NeedsJspi` is expressly non-poisoning
  and must not strand lenders).
- **Host-trap preservation across nested barriers**: the trap trampoline
  must (re)record the pending trap before every throw, so the specific
  message survives arbitrarily nested adapter exception barriers. Residual,
  documented limitation: our traps are JS exceptions, so a guest
  `try_table catch_all` can observe them mid-flight (wasmtime's are
  unforgeable); full unforgeability would need an out-of-band poison flag.
- **`Transcoder` trampoline parameters are plan-visible**: `op` (one of the
  12 `Transcode` ops), `from`/`to` runtime-memory indices, `from64`/`to64`.
  Semantics authority is wasmtime's libcalls (partial-progress primitives
  driving FACT's realloc/retry protocol), NOT definitions.py's whole-string
  transcoding model. All 12 ops implemented and reference-tested.
- **Trap messages align to wasmtime's `Display for Trap` texts** (with the
  `wasm trap: ` prefix where wasmtime uses it) — the official suite asserts
  these strings, and wasmtime-compat is a plan goal.

## B. Host trampolines (`Trampoline` enum)

The authoritative variant list is the enum itself; the shim emits the full
typed list into `plan.json` `trampolines`, and the runtime's coverage
assertion at instantiate time is what keeps the implemented set honest.
Implemented: `LowerImport` (host function call through descriptor-IR
lift/lower), `ResourceDrop` (incl. the dtor call rules of
docs/architecture.md §7), `ResourceNew`, `ResourceRep`, `Transcoder`, and
the task-core set — `BackpressureInc/Dec`, `TaskReturn`, `TaskCancel`,
`WaitableSetNew/Wait/Poll/Drop`, `WaitableJoin`, `ThreadYield` (the other
`Thread*` built-ins are plan-representable but unimplemented, refused at
instantiate time),
`SubtaskDrop/Cancel`, `Stream*`, `Future*`, `ErrorContext*`,
`ContextGet/Set`.

**Lazy materialization is the general rule**: trampolines/intrinsics are
materialized at first *reference during instantiation* — unreferenced
unsupported kinds never fail, referenced unsupported kinds fail at
instantiate time with a message naming the missing capability
("instantiate-time, never call-time", with the `PendingCapability`
carve-out of plan-format.md's executor obligations).

Open discussion item (from `values/variants.wast:83`): one async-lifted
export makes a component's sync exports unreachable (instantiate-time
refusal of `task-return`). The rule is correct per the loud-failure
policy; a future change could permit lazily-trapping trampolines for
exports the embedder never calls — a deliberate silent-acceptance
tradeoff, not adopted without discussion.

## Manifest

`plan.json` carries, per adapter module, its full import list categorized by
the table in §A (`modules[].intrinsics`), and the full `trampolines` table.
The runtime asserts coverage at instantiate time and reports which
capability is missing — "this component needs the task core" is a feature,
not a crash.

## JSPI integration constraints (empirically derived)

Every one of these is pinned by a test under `runtime/tests/jspi/`; they
generalize to any JS host of the 0.3 task model.

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
   and reads indistinguishably from "context lost".)
2. **"Task resolved" and "activation finished" are different events.**
   The reference collapses them (threads run to completion synchronously
   once resolved); a suspending host must model both. A guest may
   `task.return` and keep executing — the wit-bindgen producer pattern.
   Abandoning the activation on resolution leaks task state (exclusive
   thread, table slots); waiting for it deadlocks producers. Required: a
   detached-but-live activation the scheduler keeps servicing after the
   export call returns. Corollary: **audit every piece of host state
   assumed to nest within one export call** — the FACT sync-call bracket
   stack is per-task because activations interleave.
3. **Resolve at most one suspension per scheduler turn.** Settling a
   Suspending import's Promise hands control to wasm in a microtask: the
   settling call returns with the activation not yet run. A tight
   `while (tick())` drain — natural for a purely cooperative scheduler —
   overwrites the ambient claim and mis-attributes the first activation's
   built-ins. `tick()` must refuse progress while a claim is live; drains
   must yield to the microtask queue. (The special case of constraint 5.)
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

## Suspendability classification (current state)

Auto-detection is **ON by default**: all blocking sites lit,
per-declaration suspendability classification (async-form copy built-ins
never block; sync forms do; cancel forms per their own flag),
`KNOWN_DIVERGENT` empty, the plain path pinned zero-cost for sync-only
components.

- One spot where wasmtime supersedes definitions.py is implemented and
  tracked upstream: cancel-copy completion superseding
  (upstream-component-model-repo-findings.md CM-3).
- Task-exclusivity gating implements the hold rule (gate lifetime = the
  core invocation, the pristine definitions.py shape) plus a deferred
  entry *decision*: an async-lowered call reports STARTING only if the
  callee is still unstarted after the callee instance's runnable work is
  drained to quiescence (`Store.hasRunnableWork`, consumed by
  `createAsyncStartCall`'s determinacy park). `async-start-call` is
  `Suspending`-wrapped for the determinacy park; plain mode provably never
  needs the drain (without JSPI a frame cannot park mid-invocation, so a
  held gate always belongs to the currently-running activation — the one
  obstacle a drain cannot remove), so the plain path stays zero-cost for
  sync-only components.
- Host-import lowers participate in the classification
  (contracts/embedder-api.md §"Functions and async"): a
  `suspending()`-marked import is a genuine blocker — Suspending-wrapped,
  importer-contaminating (transitive suspendability, so entries get
  promising-wrapped per pin (c)), and evidence for auto-detection — with
  the park implemented as `blockCurrentActivation` on the recorded
  settlement (`readyFunc`-driven; result lowering deferred to `produce` so
  realloc re-entry runs under the resume-time attribution claim). The park
  is the reference's plain non-cancellable
  `thread.wait_until(subtask.resolved)` (canon_lower line 2286); the gate
  stays held across it. UNMARKED sync-lowered Promise-returning host
  functions degrade to the clean `NeedsJspi` capability signal in every
  mode — marking is the embedder's explicit, per-declaration opt-in, never
  inferred.
- The wasi package's parking kernel narrows the zero-cost pin: its marked
  `block`/`poll` are auto-detection evidence, so any wasi-consuming
  component runs jspi mode on JSPI engines — the plain path stays
  zero-cost for components that are sync-only AND import no marked
  providers (or instantiate with `jspi: false`).

Pinned by `runtime/tests/embedder/suspending_imports_test.ts` (park round
trip, resume-time realloc, pin-(c) start trap, refusal messages) and the
plain-mode guard in `runtime/tests/async_lower_test.ts`.
