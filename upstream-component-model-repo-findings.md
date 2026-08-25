# Upstream findings: WebAssembly/component-model

Single source of truth for issues and PRs we file (or intend to file) against
the [WebAssembly/component-model] repository. Anything upstream-worthy
discovered during development gets an entry **here**, not a note in the design
docs — docs/architecture.md links here instead. Findings against *other* repos (wasm-tools,
wasmtime, wit-bindgen) do not belong in this file; see "Out of scope" at the
bottom.

All file/line references are against the submodule pin at
`third_party/component-model` — currently **`73b7ad5`**. Re-verify line
numbers before filing if the submodule has been bumped.

Status legend: `DRAFT` (not yet filed) → `FILED #n` / `PR #n` → `RESOLVED`.

---

## CM-1: vestigial `$async?` immediate on `canon resource.drop` in CanonicalABI.md

**Status:** DRAFT — proposed as a one-line docs PR
**Found:** 2026-08-08, while answering "are dtors allowed to block?"

### Evidence

- `design/mvp/CanonicalABI.md:4013` shows the canonical-definition template as
  `(canon resource.drop $rt $async? (core func $f))`.
- The Explainer grammar has no async immediate:
  `design/mvp/Explainer.md:1539` — `(canon resource.drop <typeidx> (core func <id>?))`.
- The reference implementation has no async parameter:
  `canonical-abi/definitions.py:2319` — `def canon_resource_drop(rt, i)`,
  hardcoding `CanonicalOptions(async_ = False)` and a sync `FuncType`.
- The prose four paragraphs below the template is explicit that drops are
  synchronous: *"Because the type, lifting and lowering are all non-`async`,
  the destructor may not block."* (CanonicalABI.md ~4046).

Earlier 0.3 drafts had an async variant of `resource.drop`; the `$async?` in
the wat template is a leftover from its removal.

### Proposed fix

Docs PR deleting `$async?` from the template at CanonicalABI.md:4013.

### Draft PR description

> CanonicalABI.md's canonical-definition template for `resource.drop` still
> shows an `$async?` immediate. The Explainer grammar, the validation text,
> and `canon_resource_drop` in definitions.py all define `resource.drop` as
> unconditionally synchronous (and the surrounding prose says "the destructor
> may not block"). This looks like a leftover from the removal of async
> drops; this PR removes the stale immediate from the template.

### Filing notes

- Removal history: #578 removed the `async` immediate from `resource.drop`
  (Explainer grammar, Binary.md opcode `0x07`, the `option<subtask>` prose);
  #646 then forbade async ABI options on sync-typed functions entirely —
  current dtor text ("may not block; may spawn a cooperative thread that
  does") dates from there.
- The `$async?` immediates on `stream.cancel-read/write` /
  `future.cancel-read/write` a few sections down (~L4744-4747) are still
  correct — the fix is deleting the one token at :4013 only.
- Still present at upstream `main` (re-checked 2026-08-14). A standalone
  pre-tracker draft of this finding (`upstream-issue-stale-async-drop.md`)
  was retired into this entry; see git history if the fuller prose is wanted.

---

## CM-2: `canon_backpressure_set` is dead code in definitions.py

**Status:** RESOLVED upstream, independently — no filing needed. Upstream
commit `1c42aeb02` ("Remove TODO from tests, remove stale backpressure.set
definition", PR [#690]) deleted the block from definitions.py; verified
absent at `main` 2026-08-14. Our runtime's annotations referencing the dead
code (`runtime/src/intrinsics/async_builtins.ts`, `intrinsics/mod.ts`,
`runtime/README.md`) came out with the submodule bump to `4142913`
(2026-08-17), which also rebased the runtime's definitions.py line
citations across the deleted block (−7).
**Found:** 2026-08-08, during the canonical-ABI reference-test port

[#690]: https://github.com/WebAssembly/component-model/pull/690

### Evidence

- `canonical-abi/definitions.py:2366-2371` contains a
  `### 🔀 canon backpressure.set` section defining
  `canon_backpressure_set(flat_args)`.
- Neither prose document knows it: the CanonicalABI.md TOC and body document
  only `canon backpressure.{inc,dec}` (CanonicalABI.md:46, and the section the
  TOC points to), and the Explainer grammar defines only
  `(canon backpressure.inc ...)` / `(canon backpressure.dec ...)`
  (Explainer.md:1543-1544; prose at 1706).
- Because no grammar production exists, `canon_backpressure_set` is
  **unreachable from any component** — dead code from the
  `backpressure.set` → `backpressure.{inc,dec}` transition.
- The repo's own consistency checker fails on exactly this:
  `python3 canonical-abi/diff.py` reports 4 content differences, all of them
  the `canon_backpressure_set` block (definitions.py:2180-2183 in diff.py's
  code-block numbering vs CanonicalABI.md jumping straight to
  `canon_backpressure_inc`), and exits with
  *"Error: Differences found between definitions.py and CanonicalABI.md."*

(The formerly-proposed removal PR is exactly what upstream #690 did,
including making `diff.py` pass again; the draft text was dropped from this
entry on resolution — see git history.)

---

## Filing checklist (per finding)

1. Re-verify evidence against current `main` (not just our submodule pin).
2. Search existing issues/PRs for duplicates.
3. File; record the number and flip the status line here.
4. On resolution: bump the submodule, note the resolving commit here, and
   remove any workaround/annotation in our code that referenced the finding.

## Out of scope (tracked elsewhere, listed so they aren't lost)

- **wasm-tools CLI 1.247 `json-from-wast` parser lag** (15/59 suite files
  parse; current `wast` crate parses 59/59): version-skew, resolved on our
  side by owning the emitter (`crates/testgen`, docs/architecture.md §11). Only worth
  upstream traffic (bytecodealliance/wasm-tools) if still true at a current
  CLI release.
- **wasmparser 0.252 requires async function types for async lifts; wasm-tools
  1.247's validator predates the rule**: spec-tracking drift between released
  versions, not a component-model repo defect. Handled by docs/architecture.md §4.1/§9
  version-pinning discipline (the translator's wasmparser is the single
  validation authority).
- **wasmparser skips case-folding when comparing `[method]`/`[static]` and
  interface names** (candidate bytecodealliance/wasm-tools issue; found
  2026-08-22 validating our #185, extended 2026-08-25; fix tracked on our side
  as #238): Explainer.md §Name Uniqueness requires strongly-unique — lowercase
  acronyms, strip the `[...]` prefix, compare — and explicitly lists
  `[method]foo.BAR` vs `[method]foo.bar` as a validation error. wasmparser
  implements the fold for plain labels (`KebabStr`'s case-insensitive
  `Eq`/`Hash`) but `ResourceFunc` *and* `InterfaceName` derive them on the raw
  string (`src/validator/names.rs`; verified identical in 0.251/0.252/0.256
  and on wasm-tools `main` as of 2026-08-25), so `[method]r.a-b` +
  `[method]r.a-B` in one scope validates, as does `test:i/x-y` + `test:i/x-Y`
  (wasm-tools 1.247 `validate --features component-model`, wasmtime 47
  `compile`, and our translator-shim all accept; plain-label and record-field
  folded collisions are correctly rejected). Searched both upstream trackers
  2026-08-25: no existing issue covers it. Spec-side note: upstream
  WebAssembly/component-model#703 (merged 2026-08-18, after our submodule pin)
  rewrote strongly-unique as canonicalize-then-compare per
  WebAssembly/component-model#702 (non-transitivity); the acronym fold is
  retained and applies to all names — the new invalid-examples list adds
  `[static]foo-BAR.FOO-bar` and `foo:bar/BAZ` — so the divergence conclusion
  is unchanged under both wordings. Re-verify wording/line numbers against
  post-#703 Explainer.md before filing. Consequence for us: spec-invalid
  method/static and interface-name case-collisions can reach the runtime's
  conventions layer — one of the triggers tracked in #185; translator-side
  enforcement is #238. **Deferred 2026-08-25 (operator): parked until the
  wasmtime 49 toolchain bump** — upstream is actively reworking this corner
  post-#703, so re-verify the bundled wasmparser then (probes in #238); if it
  folds, the bump closes #238 and this entry dies, otherwise implement
  shim-side and re-raise the filing question.

[WebAssembly/component-model]: https://github.com/WebAssembly/component-model

## CM-3: `cancel_copy` returns a stale COMPLETED where wasmtime reports CANCELLED

**Status:** DRAFT — candidate upstream issue/PR against `definitions.py`
**Found:** 2026-08-08, implementing the stream copy protocol (M2 phase 2c review)

### Evidence

`definitions.py` `cancel_copy` (line 2652):

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

wasmtime instead supersedes it
(`wasmtime-47.0.3 runtime/component/concurrent/futures_and_streams.rs:4004`):

```rust
match (code, event) {
    (ReturnCode::Completed(count), Event::StreamWrite { .. })
        => ReturnCode::Cancelled(count),
    (ReturnCode::Dropped(_) | ReturnCode::Completed(_), _) => code,
    ...
}
```

i.e. an undelivered **stream** `Completed(count)` becomes `Cancelled(count)`;
`Dropped` is unchanged, and a **future** `Completed` is unchanged.

The official suite asserts wasmtime's answer, not the reference's:
`test/async/big-interleaving-test.wast:1520-1531` writes 8, reads 4, then
cancels the write and expects `0x42` (`CANCELLED | 4<<4`). Under the
reference's rule the answer is `0x40`. The neighbouring test at :1504 does not
disagree — it `poll`s the event first, so the cancel finds nothing pending and
takes the `shared.cancel()` path to CANCELLED either way, which is why only
the no-poll variant exposes the difference.

### Why wasmtime looks right

The guest never observed the completion. Reporting COMPLETED would tell it the
write finished when in fact it was cancelled after copying 4 of 8 elements, and
the count alone cannot distinguish the two.

### Suggested change

In `cancel_copy`, when the pending event is a stream `COMPLETED`, deliver
`CANCELLED` with the same progress count.

---

## CM-4: `sync-streams.wast:145` overfits wasmtime's scheduler — entry-status timing is not normative

**Status:** ADJUDICATED (operator, 2026-08-10) — upstream **test defect**,
not a reference-semantics issue. **Filing kit READY** (2026-08-11, closes
[polyengine#43](https://github.com/polymorph-components/polyengine/issues/43)):
`upstream-issue-sync-streams-schedule-overfit.md` (ready-to-file draft) +
`upstream-sync-streams-schedule-agnostic.patch` (applies at the spec repo
root, verified against 73b7ad5; both arms exercised green through the
polyengine pipeline, FIFO + seeds — see the kit PR for the recipe). Filing
itself tracked by
[polyengine#15](https://github.com/polymorph-components/polyengine/issues/15).
Archived evidence tree (mechanism docs, both experiment patches, trace,
verify script): `4f3351f:exams/wasmtime-exclusivity/`.
**Found:** 2026-08-08 (JSPI flip, M2 exit). **Mechanism corrected:**
2026-08-10 (#44 — the 08-09 analysis wrongly attributed a
release-at-resolution gate to wasmtime). **Runtime migrated:** hold gate +
drain-to-quiescence entry decision, PR #45.

- Gate semantics — held for the whole core invocation, mid-frame parks
  included — are agreed by `definitions.py`, wasmtime, and the
  CanonicalABI.md prose alike; no semantics were ever in conflict. What
  differs is a **scheduler policy**: *when* an async-lowered call's
  STARTING/STARTED status is decided. The reference decides eagerly at
  the call instant (STARTING in the wast scenario, under every schedule
  it can produce); wasmtime defers until work queued ahead of the call
  has drained (STARTED, deterministic under FIFO). Timing is not
  normative: two conforming policies over identical gate semantics give
  two different ABI-visible answers, so the hard STARTED assertion at
  `sync-streams.wast:145` pins wasmtime's policy, not semantics — the
  corpus was co-developed on wasmtime as its runner.
- Proposed upstream fix: make the assertion schedule-agnostic (accept
  STARTING|STARTED; on STARTING, wait for the SUBTASK event, then assert
  as today). Secondary, structural: run the wast corpus against the
  reference in spec-repo CI — today `run_tests.py` is the only CI step,
  so reference↔corpus contradictions have no detector by construction.
- Same class as NOTE-1 below (tests assuming a particular scheduler),
  sharper instance: engine-policy overfit — the reference itself fails
  the assertion deterministically. `definitions.py`, CanonicalABI.md, and
  `test_callback_interleaving` all need **no change**; both previously
  sketched amendments (release-at-resolution; deferred-entry
  normativization) are withdrawn.
- polyengine disposition: hold-lifetime gate = spec conformance;
  drain-to-quiescence entry decision (`Store.hasRunnableWork`, sole
  consumer `createAsyncStartCall`, pinned by
  `runtime/tests/entry_deferral_test.ts`) = deliberate **non-normative
  scheduler policy** — satisfies the suite as written and is order-robust
  under `POLYENGINE_SCHED_SEED` shuffles, unlike wasmtime's FIFO-dependent
  formulation. Legal under any upstream adjudication of the test; no
  flip-back trigger.

---

## NOTE-1: several official async tests assume the deterministic profile

**Status:** NOTE (documentation candidate, not a defect)
**Found:** 2026-08-08 (`async-calls-sync.wast` run-cb, M2 seeded-scheduling
investigation)

`async-calls-sync.wast`'s guest asserts each subtask's returned value equals
its index — an order pinned only by `DETERMINISTIC_PROFILE`
(definitions.py:1373): when backpressure clears, all waiters become ready at
once and the reference's `Store.tick` picks with `random.choice`. A host
exploring the spec's allowed nondeterminism beyond the deterministic profile
fails the guest's own assertion. Worth an upstream doc note on `test/async`
(tests assume the deterministic profile) or making the guests
order-tolerant. Hosts adding seeded-schedule testing should profile-scope
pins for such fixtures (we did).

---

## CM-5: `SharedFutureImpl.drop`'s pending-buffer assert looks internally inconsistent

**Status:** DRAFT — candidate upstream issue against `definitions.py`
**Found:** 2026-08-10, adversarial conformance review of the stream/future
territory (polyengine#84/#98)

### Evidence

`definitions.py:1150` (`SharedFutureImpl.drop`):

```python
if self.pending_buffer:
    assert(isinstance(self.pending_buffer, WritableBuffer))
```

The assert says: if anything is parked on the shared future when an end
drops, the parked side is a *reader* (a future read parks a WritableBuffer
— the buffer the value will be written into). But by the surrounding rules
that state is unreachable from the drop paths:

- a **writable** end may not drop before delivering its value
  (`WritableFutureEnd.drop`, definitions.py:1183-1184 traps unless
  `state == DONE`) — so a drop can never find the *reader* still parked via
  this path with the value undelivered;
- a **readable** end that parked its read is the pending side itself; when
  the reader end drops, `CopyEnd.drop` (definitions.py:1098-1101) traps on
  a busy end before reaching the shared drop;
- and `definitions.py:2614` independently asserts a readable future end can
  never observe DROPPED.

The only guest-reachable pending side at shared-drop time is therefore a
*writer* (pending `ReadableBuffer`, reader dropped first — legal), which is
exactly what the assert rejects. Either the assert is inverted, or it
documents an invariant whose enforcing traps make the guarded branch dead;
in both readings it does not describe reachable states.

### polyengine disposition

polyengine's port omits the assert (`runtime/src/task/streams.ts`,
`SharedFutureImpl.drop`) — its teardown extension (#66/#84) *deliberately*
creates the writer-died-unwritten state for trap-poisoned instances and
resolves it with a reader-side trap, which the assert would spuriously kill.
No behavioral divergence on spec-reachable states.

### Suggested upstream fix

Either delete the assert (the neighboring traps already enforce the real
invariants) or flip it to assert the reachable shape
(`isinstance(self.pending_buffer, ReadableBuffer)`) with a comment naming
the reader-dropped-first case.
