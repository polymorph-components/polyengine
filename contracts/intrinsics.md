# Contract: Host Intrinsics

The runtime supplies core-Wasm imports for FACT adapters and canonical builtins.
The translator records these requirements in the plan; the implementation lives
in `runtime/src/intrinsics/`.

The pinned `wasmtime-environ` enums define the calling convention:
`fact::Import` for adapter imports and `component::Trampoline` for host
trampolines. The shim rejects variants it cannot represent. Component Model
semantics remain governed by the pinned spec and `definitions.py`, subject to
[architecture §1](../docs/architecture.md#1-goals)'s named exception.

## Universal semantics

1. **Suspension belongs to the task machinery.** A synchronous intrinsic returns
   directly. A blocking intrinsic returns a scheduler-controlled Promise through
   `WebAssembly.Suspending`; its JS body returns before Wasm suspends. No
   ordinary JS frame may span the suspended Wasm stack. See
   [architecture §5](../docs/architecture.md#5-the-jspi-frame-rule-load-bearing-constraint).
2. **Trap and capability failures differ.** Guest violations raise `Trap`.
   Unsupported operations raise capability errors and must not satisfy
   conformance trap assertions. Component Model traps must be uncatchable, but
   this runtime's JS exceptions do not fully provide that guarantee: a guest
   `try_table catch_all` can catch a host trap. Adapter exception barriers
   preserve the original diagnostic through `HostTrapState`; they do not
   eliminate the limitation.
3. **Instance invariants are runtime obligations.** JSPI does not enforce
   `may_leave`, borrow scopes, or task exclusivity. Reentrance into a live
   instance is valid. Entry refusal is the runtime's per-instance poisoning
   policy, not a spec reentrance rule; it preserves the same-instance exemption
   for destructor self-drops. See
   [architecture §6](../docs/architecture.md#6-concurrency-the-core-deliverable).

## A. FACT adapter imports

Wasmtime's `fact_import_to_core_def` maps every adapter import to a `CoreDef`.
The runtime receives trampolines, context intrinsics, or ordinary core
functions, memories, and flags globals; it never consumes `fact::Import`
directly. `modules[].intrinsics` records import names and resolved categories.

- **Instance flags:** a mutable i32 `WebAssembly.Global`, initially 1,
  represents `may_leave` as a 0/1 boolean, not a bitmask.
- **Traps:** each `runtime.trap<N>` is a nullary import. Its plan declaration
  carries the pinned wasmtime trap discriminant. Known trap codes use
  wasmtime-compatible diagnostic text for the conformance corpus; unknown codes
  retain their numeric identity.
- **Blocking:** a sync-typed function may call an async function or blocking
  builtin. The scheduler applies the reference's actual-blocking and deadlock
  rules; adapters must not reject the call eagerly merely because the callee
  could block.
- **Resource borrows:** transfer registers a lender on the current call scope,
  including re-lending an already borrowed handle and same-instance rep fast
  paths. A lend prevents own transfer or drop until its scope ends.
- **Resource handle types:** validate against the source resource-table
  identity, then create the destination handle with its destination table
  identity. Tables may share resource origin and destructor metadata without
  being interchangeable inside the guest. Stream/future operations check their
  endpoint's local element type; boundary transfers compare underlying origins
  and retag the endpoint for the receiving component.
- **Unwind:** a failed call releases the lenders it registered, including
  non-poisoning capability failures. The host boundary restores `may_leave`
  according to entry identity: it excludes the host entry's own instance and
  skips global restoration during a nested guest destructor call. This is not a
  general filter on sibling poison state. FACT call scopes are activation-local
  so interleaved tasks cannot release each other's lends.
- **Destructive removal:** validation follows handle removal, as in the
  reference. If a removed stream/future end fails validation, local unwind
  retires it; a later table walk cannot find it. Successful transfers do not
  retire their shared state. Peer notification failure must neither replace the
  original trap nor skip drop observers.
- **Nested exception barriers:** trap trampolines re-record the pending host
  trap before throwing, preserving its cause through outer barriers.
- **Transcoding:** the plan records `op`, source/destination memory indices, and
  `from64`/`to64`. Wasmtime's libcalls define the partial-progress protocol; the
  composed lift/lower must still follow the Component Model string rules. All
  twelve operations are implemented for memory32. The shim's
  `fact_string_limits` correction enforces the pinned reference's source-byte
  limit before guest realloc; its dependency-pattern guards and encoding-matrix
  tests must be reviewed when upgrading environ.

## B. Host trampolines (`Trampoline` enum)

Implemented groups are host import lowering; resource new/rep/drop and transfer;
transcoding; backpressure; task return/cancel; waitable sets and join; subtask
drop/cancel; stream/future operations; error contexts; context get/set; and
thread yield. Other explicit thread builtins are representable in the plan but
unsupported by the runtime.

Trampolines are materialized on first reference during instantiation.
Unsupported referenced kinds fail then with a capability diagnostic; unused
entries do not prevent instantiation. A supported blocking operation may still
require JSPI at call time. The runtime's `createTrampoline` switch is the
current implementation inventory; [plan-format.md](plan-format.md) defines the
wire representation.

## Manifest

The plan carries the full `trampolines` table and each adapter's categorized
import list in `modules[].intrinsics`. Import resolution must either supply the
declared operation or report its missing capability; silently omitting an import
is not permitted.

## JSPI integration constraints (empirically derived)

The tests in `runtime/tests/jspi/` pin the engine behavior these rules rely on.

1. **Explicit activation attribution.** Wasm resumes in a microtask outside the
   JS frame that initiated suspension. The runtime retains an explicit
   activation claim across that interval so context access and builtins refer to
   the correct task/thread. This works without platform async-local storage.
   Attribution probes need a second import call after resumption.
2. **Resolution is not thread exit.** `task.return` delivers a value while a
   producer may remain alive. Return the value once the required activation
   bookkeeping has settled; keep background threads available for later
   scheduling. Waiting for every producer thread to exit can deadlock the
   consumer of the returned stream or future. Call scopes therefore cannot be
   assumed to nest inside one host export invocation.
3. **One resumption decision at a time.** Resolving a suspension schedules Wasm
   on a later microtask. A synchronous drain must not schedule another
   activation while the first activation's claim is outstanding.
4. **Plain-value returns still incur a JSPI hop.** A `Suspending` import that
   returns a value does not resume Wasm synchronously (`fastpath_hop_test.ts`).
   FACT async-call startup waits for the callee to become determinate: resolved,
   finished, or parked at a scheduler condition. Cancellation's determinacy
   predicate is stricter: resolution alone does not end its JSPI-hop wait. Async
   lowering must not become a synchronous wait for its result.
5. **Settled tails precede new scheduling.** Promise settlement is tagged
   eagerly. Drivers service completed activation bookkeeping before making
   another scheduling decision, and must not deliver the same settlement twice.
   A driver's completion verdict is latched rather than recomputed after another
   driver has changed store state.

## Suspendability classification (current state)

Auto-detection selects JSPI when supported and required by the plan or a marked
host import. Explicit `jspi: false` forces the plain path. Copy builtins are
classified by their sync/async form; cancellation forms follow their own flags.
Tests exercise the same corpus under both modes where applicable.

- Async-call startup and cancellation may need determinacy parks across the JSPI
  hop. Wrapping an import as `Suspending` also marks its importer suspendable:
  even a plain return requires a `promising` entry. This propagation must not
  eagerly wrap FACT pass-through callees that can otherwise finish
  synchronously.
- Marked `suspending()` host imports park using recorded settlement and a
  scheduler readiness predicate. Result lowering runs at resume time under the
  activation claim. Unmarked sync imports returning Promises raise `NeedsJspi`;
  the runtime never infers the mark from a returned value.
- WASI's marked blocking declarations select JSPI even when a particular call
  completes immediately. The plain fast path applies to sync-only plans with no
  marked imports, not to every call that happens not to wait.
- The async `subtask.cancel` determinacy park is a named non-atomicity
  divergence. The synchronous form still waits for **resolution**, never merely
  a STARTED event. Copy-cancel completion superseding is the separate CM-3
  exception. Both are documented in architecture §6.
