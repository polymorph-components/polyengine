# Upstream findings: WebAssembly/component-model

Spec-repository findings and local dispositions. Runtime semantic exceptions
link here from [architecture §1](docs/architecture.md#1-goals). Entries are
not authorization to file publicly; no filing is claimed without a link.

Current checks below use the local `third_party/component-model` pin
`7c676115e93cd7d54c1732d95c54c6a3de7c5ae0`. Historical observations name their
source snapshot separately. Spec paths are relative to `design/mvp/` unless
otherwise stated. Prefer function references over line numbers when rechecking.

Status: `DRAFT` (unfiled finding), `FILED` / `PR` (linked upstream record),
`RESOLVED` (absent at the pin), or a named local disposition.

---

## CM-1: vestigial `$async?` immediate on `canon resource.drop` in CanonicalABI.md

**Status:** RESOLVED at the current pin by upstream commit `dff1181`
([#698](https://github.com/WebAssembly/component-model/pull/698)). No filing needed.

### Evidence

The original `73b7ad5` template included `$async?` despite the synchronous
Explainer grammar and `canon_resource_drop` implementation. The current
`CanonicalABI.md` template is `(canon resource.drop $rt (core func $f))`,
matching both. `canon_resource_drop` uses synchronous canonical options and
a synchronous function type; destructors may not block their implicit thread.

---

## CM-2: `canon_backpressure_set` is dead code in definitions.py

**Status:** RESOLVED by upstream commit `1c42aeb02`
([#690](https://github.com/WebAssembly/component-model/pull/690)); the function
is absent at the current pin. No filing needed.

### Evidence

At `73b7ad5`, `definitions.py` still defined `canon_backpressure_set`, but
the grammar and CanonicalABI.md exposed only `backpressure.inc` and
`backpressure.dec`. The unused block also caused the repository's
`canonical-abi/diff.py` consistency check to fail. #690 removed it.

---

## Filing checklist (per finding)

1. Obtain operator authorization before filing in a foreign repository.
2. Recheck against upstream `main`, not only our pin, and search for duplicates.
3. If filed, record the upstream link and status here.
4. On resolution, record the resolving commit and review local workarounds.

## Out of scope (tracked elsewhere, listed so they aren't lost)

- **wasm-tools parser/validator version skew:** older CLI releases rejected
  corpus syntax accepted by the pinned `wast`/`wasmparser` crates. The
  translator's wasmparser performs implementation validation; the spec remains
  the semantic authority. `crates/testgen` uses
  the pinned release train rather than a separately installed CLI parser.
  See [architecture §4](docs/architecture.md#4-architecture) and §9.
- **wasmparser name case-folding:** historical probes recorded in
  [polyengine#238](https://github.com/polymorph-components/polyengine/issues/238)
  found method/static and interface-name collisions accepted where the
  Explainer's name canonicalization rejects them. The August 2026 probes
  covered wasmparser 0.251/0.252/0.256; a September toolchain-bump note cited
  upstream `test/nyi.txt` for 0.258, not a fresh reproduction. Neither upstream
  status nor the current translator behavior is established by those snapshots.
  Re-run the issue's probes before proposing enforcement or an upstream filing.
  The current `harness/src/xfail.ts` separately retains `validation/kebab.json`
  exclusions under `name-rules-nyi`, linked to
  [polyengine#248](https://github.com/polymorph-components/polyengine/issues/248).

## CM-3: `cancel_copy` returns a stale COMPLETED where wasmtime reports CANCELLED

**Status:** DRAFT, unfiled. This is the approved corpus exception in
[architecture §1](docs/architecture.md#1-goals), reversible if upstream
adjudicates otherwise. The current pin still returns the pending payload
unchanged in `cancel_copy`.
**Found:** 2026-08-08, implementing the stream copy protocol.

### Evidence

`definitions.py` `cancel_copy`:

```python
e.state = CopyState.CANCELLING_COPY
if not e.has_pending_event():
    e.shared.cancel()
    ...
code,index,payload = e.get_pending_event()
return [payload]
```

When the end already has an armed-but-**undelivered** event, the pending event
is returned verbatim. For a stream write that was partially satisfied by a
rendezvous, that event is `COMPLETED | (count << 4)` (armed by `on_copy` in
`stream_copy`), so a subsequent `stream.cancel-write` reports COMPLETED.

The recorded wasmtime source comparison is against **47.0.3**,
`runtime/component/concurrent/futures_and_streams.rs:4004`:

```rust
match (code, event) {
    (ReturnCode::Completed(count), Event::StreamWrite { .. })
        => ReturnCode::Cancelled(count),
    (ReturnCode::Dropped(_) | ReturnCode::Completed(_), _) => code,
    ...
}
```

An undelivered **stream** `Completed(count)` becomes `Cancelled(count)`;
`Dropped` is unchanged, and a **future** `Completed` is unchanged.

The official suite asserts wasmtime's answer, not the reference's:
`test/async/big-interleaving-test.wast` writes 8, reads 4, then cancels the
write without polling and expects `0x42` (`CANCELLED | 4<<4`). Under the
reference's rule the answer is `0x40`. This no-poll write cancellation is
still present at the current pin. The neighboring test first polls the
write completion, then starts and cancels another read; it does not exercise
the disputed pending write event. The evidence is at lines 1520-1531
(no-poll write cancellation) and 1504-1518 (poll/read cancellation).

### Why wasmtime looks right

The original rationale favored CANCELLED for an unobserved partial write.
That intuition is not semantic proof; the approved exception rests on the
corpus/source evidence above, subject to upstream adjudication.

### Suggested change

In `cancel_copy`, when the pending event is a stream `COMPLETED`, deliver
`CANCELLED` with the same progress count.

---

## CM-4: `sync-streams.wast:145` overfits wasmtime's scheduler — entry-status timing is not normative

**Status:** ADJUDICATED locally as a schedule-dependent test assertion, not
a reference-semantics defect (2026-08-10). The original patch targeted
`73b7ad5`; upstream #705 subsequently rewrote the assertion. No current
upstream defect or filing is established by that patch. The local follow-up
record is [polyengine#15](https://github.com/polymorph-components/polyengine/issues/15).

Historical evidence (mechanism notes, experiment patches, trace and verify
script) is preserved at `4f3351f:exams/wasmtime-exclusivity/`.

- The instance-entry gate lasts for the whole core invocation, including
  mid-frame parks. The reference, CanonicalABI.md and surveyed wasmtime
  implementation agreed; the initial release-at-resolution interpretation
  was wrong and was withdrawn.
- Entry-status timing is scheduler policy. The reference decided eagerly
  and returned STARTING in the recorded scenario; wasmtime drained queued
  work first and returned STARTED. The old test's hard STARTED assertion
  distinguished conforming schedules, not gate semantics.
- Polyengine holds the gate for the invocation and defers entry while
  runnable work remains (`Store.hasRunnableWork`, `createAsyncStartCall`,
  `runtime/tests/entry_deferral_test.ts`). The latter is a non-normative
  scheduler choice, not the CM-3 semantic exception.

Any renewed upstream proposal must reproduce the issue against the current
test. The historical proposal was to accept STARTING or STARTED, waiting for
the SUBTASK event when necessary; neither the gate rule nor
`test_callback_interleaving` needed changing.

---

## NOTE-1: several official async tests assume the deterministic profile

**Status:** Historical NOTE, not a current defect claim.

The August 2026 seeded-scheduling investigation found
`async-calls-sync.wast` assertions tying each subtask's value to its index.
That order depends on `DETERMINISTIC_PROFILE`: when backpressure clears,
multiple waiters become ready and the reference's `Store.tick` can choose
among them. Recheck individual fixtures before extending this observation
to the current corpus. Seeded-scheduling exclusions must identify the
schedule-dependent assertion rather than treating a host order as normative.

---

## CM-5: `SharedFutureImpl.drop`'s pending-buffer assert looks internally inconsistent

**Status:** RESOLVED at the current pin by upstream commit `4acb0de`
([#708](https://github.com/WebAssembly/component-model/pull/708)). No filing needed.
**Found:** 2026-08-10, stream/future conformance review (polyengine#84/#98).

### Evidence

The original `SharedFutureImpl.drop` asserted that `pending_buffer` was a
`WritableBuffer` (a parked reader). A writable future cannot drop before
delivery, and a busy readable end cannot drop itself, so the reachable
pending side is instead a writer whose reader dropped first.

Both current `definitions.py` and CanonicalABI.md assert
`isinstance(self.pending_buffer, ReadableBuffer)`, matching that writer-side
buffer. This is the correction proposed by the original finding.

### polyengine disposition

`runtime/src/task/streams.ts` `SharedFutureImpl.drop` omits the assertion.
Instance-poisoning teardown also permits an unwritten writer to die and
traps its reader, an extension outside guest-reachable reference drop paths.
That teardown distinction remains; the upstream pending-buffer assertion
is no longer a defect.

### Suggested upstream fix

None outstanding for this finding; #708 corrected the assertion.
