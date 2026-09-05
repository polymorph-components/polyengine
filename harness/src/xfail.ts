// Checked-in triage list: commands known to fail against the current
// runtime, with a reason, so the conformance run's summary distinguishes
// "known, triaged failure" (xfail) from "unexpected regression" (failed).
// Keyed by `{file, line}` — `line` is the command's 1-based source line
// from testgen's JSON (stable across regen: same suite source -> same
// line), which uniquely identifies a command within a file.
//
// Entries here are removed as the runtime gains the capability that makes
// them pass; an xfail entry whose command now PASSES fails the run loudly
// (the stale-xfail detector in tests/conformance_test.ts, a real G7 gate) —
// prune stale entries rather than accumulating masks.

export interface XfailEntry {
  /** relative path under harness/generated/, e.g. "linking/unit.json". */
  file: string;
  /** 1-based source line (`Command.line`) of the failing command. */
  line: number;
  reason: string;
}

export const XFAIL: XfailEntry[] = [
  // (The former `wasmparser/wast pin drift` class, polyengine#152, exited
  // with the wasmtime `main` re-pin: testgen's `wast` and the shim's
  // wasmparser are on the same release train, enforced by `just test-rust`.)
  // --- validation/kebab.json: CM#703/#704 ("name rules" reworks, pulled in
  // by the CM#705 pin advance polyengine#173) added import-name-conflict
  // checks under kebab-case folding (a `foo-bar` import conflicts with
  // `foobar`/`FOOBAR`/`foob-ar`/method-and-static-qualified variants that
  // fold to the same name). This is not pin-drift residue: the file is
  // listed in upstream's own third_party/component-model/test/nyi.txt at
  // the current pin (wasmtime `main`@4675ee1) — wasmtime itself does not
  // implement this check yet, so wasmparser 0.258 accepts all five
  // components as distinct imports. Classed `name-rules-nyi`,
  // https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: upstream nyi.txt).
  // Same gap class already tracked for interface names in
  // upstream-component-model-repo-findings.md (#246/#247). ---
  {
    file: "validation/kebab.json",
    line: 149,
    reason:
      'expected assert_invalid ("import name `foobar` conflicts with ' +
      'previous name `foo-bar`"), but it validated — wasmtime does not ' +
      "implement CM#703/#704's kebab-case name-folding conflict check yet " +
      "(third_party/component-model/test/nyi.txt lists this file); " +
      "name-rules-nyi, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: upstream " +
      "nyi.txt)",
  },
  {
    file: "validation/kebab.json",
    line: 154,
    reason:
      'expected assert_invalid ("import name `FOOBAR` conflicts with ' +
      'previous name `foo-bar`"), but it validated — same name-rules-nyi ' +
      "gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 159,
    reason:
      'expected assert_invalid ("import name `foob-ar` conflicts with ' +
      'previous name `foo-bar`"), but it validated — same name-rules-nyi ' +
      "gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 164,
    reason:
      'expected assert_invalid ("import name `[static]foo-bar.FO-ob-AR` ' +
      'conflicts with previous name `foo-bar`"), but it validated — same ' +
      "name-rules-nyi gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 169,
    reason:
      'expected assert_invalid ("import name `[method]foo-bar.foobar` ' +
      'conflicts with previous name `foo-bar`"), but it validated — same ' +
      "name-rules-nyi gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  // --- validation/max-value-size.json: CM#688 ("max-value-size", pulled in
  // by the CM#705 pin advance polyengine#173) added the elem_size(t, i64) <
  // 2^28 validation rule (CanonicalABI.md#element-size). Not pin-drift
  // residue: this file is also listed in upstream's own
  // third_party/component-model/test/nyi.txt at the current pin — wasmtime
  // itself does not enforce this check yet, so every assert_invalid in
  // this file validates instead of rejecting. Classed `max-value-size-nyi`,
  // https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: upstream nyi.txt).
  // Line 63 is the dispatch-flagged pointer-width-sensitive row
  // (`list string 16777216`, the i32-vs-i64 elem-size boundary): observed
  // behavior on this (presumably 64-bit host) run is identical to the
  // others — wasmparser accepts it outright, not a differing failure mode
  // tied to pointer width. ---
  {
    file: "validation/max-value-size.json",
    line: 25,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — wasmtime does not implement CM#688's elem_size < 2^28 " +
      "check yet (third_party/component-model/test/nyi.txt lists this " +
      "file; single fixed list just over the limit: `(list u8 " +
      "268435456)`); max-value-size-nyi, " +
      "https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: upstream nyi.txt)",
  },
  {
    file: "validation/max-value-size.json",
    line: 31,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25 (fixed list " +
      "whose product exceeds MAX: `(list u64 33554432)`), " +
      "https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 37,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25 (u32-wrap class: " +
      "real byte size is 2^32 but a naive u32 multiply wraps to 0: " +
      "`(list u64 536870912)`), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 43,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25 (compound sum " +
      "exceeds MAX via a tuple), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 48,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25 (compound sum " +
      "exceeds MAX via a record), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 57,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25 (nested fixed " +
      "list), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 63,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-nyi gap as line 25; this is the " +
      "dispatch-flagged pointer-width-sensitive row (`(list string " +
      "16777216)`, the i32-vs-i64 elem-size boundary noted in the wast " +
      "source comment) — observed identically to the other rows on this " +
      "run (wasmparser accepts it outright), https://github.com/polymorph-components/polyengine/issues/248",
  },
  // --- values/post-return.json: post-return.wast:4 ($Tester) declares
  // every async built-in (task.return, thread.yield/INDEX, waitable-set.*,
  // subtask.*, stream.*, future.*) to assert they trap from a post-return
  // function. The task core shipped; the SURVIVING refusal is
  // 'thread-index' — the 🧵 shared-everything-threads class, deferred by
  // https://github.com/polymorph-components/polyengine/issues/12 — so the component still declines at instantiation and all 28
  // assert_traps cascade off 'no current instance'. (Reason strings
  // rewritten after the task core shipped: they previously named it as
  // missing, which would misdirect triage.)
  {
    file: "values/post-return.json",
    line: 202,
    reason:
      "UnsupportedFeatureError: component requires host trampoline " +
      "'thread-index' — post-return.wast:4 declares the full async built-in " +
      "surface incl. 🧵 thread.* built-ins; deferred-threads class, https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: shared-everything threads)",
  },
  {
    file: "values/post-return.json",
    line: 204,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 206,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 208,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 210,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 212,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 214,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 216,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 218,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 220,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 222,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 224,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 226,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 228,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 230,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 232,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 234,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 236,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 238,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 240,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 242,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 244,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 246,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 248,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 250,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 252,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 254,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  {
    file: "values/post-return.json",
    line: 256,
    reason: "same 🧵 thread-index (deferred threads, https://github.com/polymorph-components/polyengine/issues/12) dependency as line 202",
  },
  // post-return.wast:260 uses `context.get`/`context.set`, which wasmtime
  // lowers to `CoreDef::UnsafeIntrinsic` — the CoreDef `unsafe-intrinsic`
  // encoding (contracts/plan-format.md schema) has no wire form for this yet
  // — a known task-scheduler blocker.
  // post-return.wast:334 calls `backpressure.inc`/`backpressure.dec` from a
  // post-return function. NOTE the observed symptom is a *wrong value*
  // ("expected u32 11, got 5"), not an error: the module command fails as a
  // capability skip and the invoke then runs against the previously
  // instantiated component, which also exports `f`. The value mismatch is an
  // artifact of that, not a canonical-ABI bug.
  // --- values/variants.json: GREEN. variants.wast:83's component mixes an
  // async-lifted export (`mix-ret`) with sync ones, reached through FACT
  // adapters; prepare-call / {sync,async}-start-call made it
  // instantiate and run — pinned by runtime/tests/integration/
  // e2e_suite_test.ts ("async-lifted exports instantiate and run"). ---

  // =====================================================================
  // async/ — triage as of streams/futures/error-context support.
  //
  // Streams, futures and error-context are IMPLEMENTED; the entries below no
  // longer describe a missing value type. The dominant remaining class is
  // JSPI: the *synchronous* form of a stream/future copy, of
  // `waitable-set.wait`, and of a cross-component call all block the calling
  // wasm frame, which a stackless runtime cannot do. See
  // runtime/src/intrinsics/stream_builtins.ts `finishCopy`.
  //
  // Historic note (early triage) follows.
  //
  // What now works and is NOT listed here: `trap-on-reenter`,
  // `validate-no-async-abi-for-sync-type` and `validate-no-stream-char` are
  // fully green, and individual commands pass in eight more files.
  //
  // What blocks the rest, in order of weight:
  //   * FACT cross-component async calls (`async-start-call`,
  //     `sync-start-call`) — 49 commands. This phase implements the async ABI
  //     at the *host* boundary; the suite almost always drives async through a
  //     second component, which goes via FACT's adapter intrinsics instead.
  //   * streams / futures — 41 commands (out of this track).
  //   * 166 further commands are *cascades*: once a component instance is
  //     declined at instantiation, every later command against it fails with
  //     "no current instance". They carry the root cause's reason.
  //   * 4 genuine one-off gaps, each with its own entry (trap-message
  //     fidelity, instance poisoning, instantiation-time task context, and one
  //     shim decoder gap).
  // =====================================================================
  // --- async/builtin-trap-poisons-instance.json: root cause: STREAMS ---
  // --- async/cancel-and-exclusive-lock.json: CM#707 "always deliver
  // cancellation as soon as possible" (third_party/component-model commit
  // 1af0b35, pulled in by the CM#705 pin advance polyengine#173) changed
  // when a pending cancellation must be delivered; polyengine's task
  // scheduler still implements the pre-#707 delivery timing, so the
  // cross-instance exclusive-lock scenario this file drives deadlocks
  // instead of the callee observing cancellation. Classed `cm707-cancel`,
  // https://github.com/polymorph-components/polyengine/issues/250.
  //
  // NOTE on hang risk (dispatch warning): this file does NOT wedge the
  // harness. It completes crisply with our OWN "deadlock detected: event
  // loop cannot make further progress" trap rather than looping forever —
  // the pre-#707 runtime deadlock manifests as a clean trap, not a stall.
  // No harness-visible skip mechanism was needed. ---
  {
    file: "async/cancel-and-exclusive-lock.json",
    line: 196,
    reason:
      "expected return, got trap: wasm trap: deadlock detected: event " +
      "loop cannot make further progress — polyengine has not implemented " +
      "CM#707's immediate-cancellation-delivery timing yet, so the " +
      "callee never observes the pending cancellation and the scheduler " +
      "finds no ready thread; cm707-cancel, https://github.com/polymorph-components/polyengine/issues/250",
  },
  // --- async/cancel-stream.json: root cause: STREAMS ---
  // --- async/closed-stream.json: root cause: STREAMS ---
  // --- async/cross-abi-calls.json: root cause: FACT-ASYNC ---
  // --- async/cross-task-future.json: root cause: STREAMS ---
  // --- async/drop-cross-task-borrow.json: root cause: FACT-ASYNC ---
  // --- async/drop-stream.json: root cause: STREAMS ---
  // --- async/drop-waitable-set.json: root cause: FACT-ASYNC ---
  // --- async/during-sync-call-*.json + during-sync-scheduling-candidates.json:
  // all pin 🧵 sync-call-blocking semantics and are built largely from thread
  // built-ins (thread.new-indirect / resume-later / suspend-then-resume /
  // suspend / index / yield-then-promote) — the deferred-threads class,
  // https://github.com/polymorph-components/polyengine/issues/12. (History: at the prior pin these components
  // failed TRANSLATION first, under the now-exited wasmparser/wast
  // pin-drift class — see the EXIT note at the top of this file.) At the
  // current pin every one of these components TRANSLATES and DEFINES
  // fine; the remaining failure is that INSTANTIATING them requires a
  // host trampoline for a thread built-in (`thread-index`,
  // `thread-new-indirect`, ...) that polyengine's executor does not yet
  // implement — a `module`/`module_instance` command reports
  // `pending-capability: instantiate: component requires host trampoline
  // '...'` and is SKIPPED (not failed; no xfail entry needed for it), and
  // every later assert against that instance cascades with "no current
  // instance". `async/during-sync-call-exclusive-resume.json` and
  // `async/during-sync-scheduling-candidates.json` are BRAND NEW files added by
  // the CM#705 pin advance (polyengine#173, third_party/component-model
  // 2f13265) — they did not exist pre-advance, so these are new entries,
  // not renumbered ones. Predicted class from that dispatch was
  // `cm705-sync-sched` (polyengine#249, a semantic scheduling deviation);
  // investigation there found the observed failures were translator-level
  // at the time (the since-exited pin-drift class); the subsequent re-pin
  // resolved that translation gap, uncovering the SAME deferred-threads
  // class (#12) one layer down at instantiation. ---
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 111,
    reason:
      "cascade of line 110 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-new-indirect', " +
      "deferred thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): " +
      "no current instance",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 112,
    reason: "same cascade as line 111, see that entry",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 115,
    reason:
      "cascade of line 114 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-new-indirect', " +
      "deferred thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): " +
      "no current instance",
  },
  // CM#705 (polyengine#173) appended a second component to this file (a new
  // "setup"/"run" pair driven by thread.new-indirect/index/resume-later/
  // suspend) — same deferred-threads mechanism as above, at a fresh offset.
  // Its own module_instance command (line 136) is pending-capability
  // ('thread-new-indirect') and needs no xfail entry (skipped, not failed).
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 206,
    reason:
      "cascade of line 136 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-new-indirect', " +
      "deferred thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): " +
      "no current instance",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 207,
    reason: "same cascade as line 206, see that entry",
  },
  // async/during-sync-call-exclusive-resume.json: BRAND NEW file (CM#705 pin
  // advance, polyengine#173; test/async/during-sync-call-exclusive-resume.wast
  // is 100% new content, not a renumbering of the deleted
  // during-sync-call-no-exclusive-resume.wast). All three of its components
  // are built from thread.index/suspend/resume-later; each `module` command
  // is itself pending-capability ('thread-index' at line 9, 'thread-suspend'
  // at line 65 -- for the third component, whose own preceding module
  // command line is not separately listed here) and needs no xfail entry.
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 59,
    reason:
      "cascade of line 9 (module pending-capability: instantiate requires " +
      "host trampoline 'thread-index', deferred thread built-ins, " +
      "https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 60,
    reason: "same cascade as line 59, see that entry",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 102,
    reason:
      "cascade of line 65 (module pending-capability: instantiate " +
      "requires host trampoline 'thread-suspend', deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 103,
    reason: "same cascade as line 102, see that entry",
  },
  // async/during-sync-scheduling-candidates.json: BRAND NEW file (CM#705 pin
  // advance, polyengine#173). Six components, each built from thread
  // built-ins (thread.new-indirect/resume-later/suspend/index/
  // yield-then-promote); every component's `module`/`module_instance`
  // command is pending-capability (deferred thread built-ins, #12) and
  // needs no xfail entry — the cascading asserts below do.
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 74,
    reason:
      "cascade of line 19 (module pending-capability: instantiate " +
      "requires host trampoline 'thread-new-indirect', deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 75,
    reason: "same cascade as line 74, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 132,
    reason:
      "cascade of line 78 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 133,
    reason: "same cascade as line 132, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 134,
    reason: "same cascade as line 132, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 135,
    reason: "same cascade as line 132, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 234,
    reason:
      "cascade of line 144 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 235,
    reason: "same cascade as line 234, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 236,
    reason: "same cascade as line 234, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 237,
    reason: "same cascade as line 234, see that entry",
  },
  // Note: this file's line 245 ("BlockedCallbackTester" component
  // definition) itself now TRANSLATES AND DEFINES successfully at the
  // 4675ee1 pin (it was stale here pre-cleanup, per the stale-xfail
  // detector, and has been pruned); the definition's later use at line 303
  // still needs a host trampoline this executor lacks.
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 304,
    reason:
      "cascade of line 303 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 305,
    reason: "same cascade as line 304, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 308,
    reason:
      "cascade of line 307 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 309,
    reason: "same cascade as line 308, see that entry",
  },
  // Same as above for line 315 ("SyncLiftedTester"): the definition itself
  // is pruned-stale here (now translates fine); its uses at 403/407 still
  // lack a host trampoline.
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 404,
    reason:
      "cascade of line 403 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 405,
    reason: "same cascade as line 404, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 408,
    reason:
      "cascade of line 407 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 409,
    reason: "same cascade as line 408, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 482,
    reason:
      "cascade of line 414 (module pending-capability: instantiate " +
      "requires host trampoline 'thread-new-indirect', deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 483,
    reason: "same cascade as line 482, see that entry",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 484,
    reason: "same cascade as line 482, see that entry",
  },
  // async/during-sync-call-no-sibling-resume.json: same deferred-threads
  // mechanism; its `module` commands (lines 16, 162) are pending-capability
  // ('thread-new-indirect', 'thread-suspend') and need no xfail entry.
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 155,
    reason:
      "cascade of line 16 (module pending-capability: instantiate " +
      "requires host trampoline 'thread-new-indirect', deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 156,
    reason: "same cascade as line 155, see that entry",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 214,
    reason:
      "cascade of line 162 (module pending-capability: instantiate " +
      "requires host trampoline 'thread-suspend', deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 215,
    reason: "same cascade as line 214, see that entry",
  },
  // --- async/futures-must-write.json: root cause: STREAMS ---
  // --- async/reentrance.json: BRAND NEW file (test/async/reentrance.wast is
  // 100% new content added by CM#705's "remove the may_enter flag/trap",
  // polyengine#173). The `fact-reentrance-47` static-stub class (#248,
  // retired — see the note at the top of this file) previously MASKED the
  // three rows below: with the stub gone, each now surfaces a genuine
  // scheduler/reentrance semantic gap of its own, not a regression from
  // this bump. Classed `cm705-reentrance`,
  // https://github.com/polymorph-components/polyengine/issues/279.
  // Lines 42/60/99/100/151/198/237/346 (the pure fact-reentrance-47 rows,
  // with no residue underneath) all PASS now and are pruned. ---
  {
    file: "async/reentrance.json",
    line: 429,
    reason:
      "expected trap \"deadlock detected: event loop cannot make further " +
      "progress\", got SuspendError: trying to suspend JS frames — the " +
      "deadlock is never diagnosed because the wait reaches a Suspending " +
      "import through a JS callback frame; cm705-reentrance, " +
      "https://github.com/polymorph-components/polyengine/issues/279",
  },
  {
    file: "async/reentrance.json",
    line: 517,
    reason:
      "expected return, got trap \"cannot drop a subtask which has not " +
      "yet resolved\" — subtask.cancel on parked callback tasks while the " +
      "callee instance is on the stack does not settle the cancellation " +
      "before subtask.drop; cm705-reentrance, https://github.com/polymorph-components/polyengine/issues/279",
  },
  {
    file: "async/reentrance.json",
    line: 522,
    reason:
      "cascade: this component's `module` command is pending-capability " +
      "(instantiate requires a host trampoline for a deferred thread " +
      "built-in — waitable-set.new/waitable.join/subtask.cancel plus " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12); NOT reentrance-related",
  },
  {
    file: "async/reentrance.json",
    line: 645,
    reason:
      "cascade of line 522 (module pending-capability, deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance (not reentrance-related)",
  },
  {
    file: "async/reentrance.json",
    line: 760,
    reason:
      "cascade of line 657 (module pending-capability, deferred thread " +
      "built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance (not reentrance-related)",
  },
  {
    file: "async/reentrance.json",
    line: 837,
    reason:
      "expected trap \"waitable cannot be used synchronously while added " +
      "to a waitable set\", got \"guest trapped: unreachable\" — the " +
      "reentrant `back` does not raise the sync-use-in-waitable-set trap; " +
      "cm705-reentrance, https://github.com/polymorph-components/polyengine/issues/279",
  },
  // --- async/self-switch-traps.json: NEW file added by the CM#687
  // thread.*-then-promote built-ins (third_party/component-model advance
  // 2f13265 -> 7c67611, this dispatch). Its Tester component needs a host
  // trampoline for `thread-index`, not implemented by this executor yet
  // (deferred thread built-ins, https://github.com/polymorph-components/polyengine/issues/12); every
  // module_instance command against it is pending-capability/SKIPPED (no
  // xfail entry needed) and every assert cascades with "no current
  // instance". Also listed in upstream's own
  // third_party/component-model/test/nyi.txt at this pin. ---
  {
    file: "async/self-switch-traps.json",
    line: 46,
    reason:
      "cascade of line 45 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/self-switch-traps.json",
    line: 48,
    reason: "same cascade as line 46, see that entry",
  },
  {
    file: "async/self-switch-traps.json",
    line: 50,
    reason: "same cascade as line 46, see that entry",
  },
  {
    file: "async/self-switch-traps.json",
    line: 52,
    reason: "same cascade as line 46, see that entry",
  },
  // --- async/switch-to-ready-callback.json: NEW file, same CM#687 advance
  // as self-switch-traps.json above. Same root cause: 'thread-index'
  // deferred (https://github.com/polymorph-components/polyengine/issues/12); every module_instance command against
  // Tester is pending-capability/SKIPPED (no xfail entry needed) and every
  // assert cascades with "no current instance". ---
  {
    file: "async/switch-to-ready-callback.json",
    line: 355,
    reason:
      "cascade of line 354 (module_instance pending-capability: " +
      "instantiate requires host trampoline 'thread-index', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 357,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 359,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 361,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 363,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 365,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 367,
    reason: "same cascade as line 355, see that entry",
  },
  {
    file: "async/switch-to-ready-callback.json",
    line: 369,
    reason: "same cascade as line 355, see that entry",
  },
  // --- async/sync-streams.json: test/async/sync-streams.wast expects three
  // values polyengine does not produce (STARTING vs STARTED at the
  // sync-lowered `set` call, and a COMPLETED<->DROPPED completion-code swap
  // on the paired stream.read/write) under CM#705's blocking semantics, so
  // the file's single all-in-one assert_return hits a guest `unreachable`.
  // Classed `cm705-sync-sched`
  // (https://github.com/polymorph-components/polyengine/issues/249).
  //
  // For the rest of the file polyengine implements wasmtime's model (#43):
  // the async-lowered call's initial status is decided only after the callee
  // instance's runnable work has been drained to quiescence — by which time
  // the producer has exited and the next task reports STARTED. Adjudicated
  // 2026-08-10 (issue #43): the test's hard STARTED assertion is
  // schedule-dependent — an upstream test defect overfitting wasmtime's
  // deferred-entry policy (pristine definitions.py answers STARTING) — and
  // polyengine's drain policy satisfies it as written under any seed. ---
  {
    file: "async/sync-streams.json",
    line: 208,
    reason:
      "expected return, got trap: guest trapped: unreachable — this file's " +
      "expected STARTING/STARTED and COMPLETED/DROPPED codes track CM#705's " +
      "blocking semantics, which polyengine's sync scheduling does not yet " +
      "produce, so the guest's own assertion traps; cm705-sync-sched, " +
      "https://github.com/polymorph-components/polyengine/issues/249",
  },
  // --- async/trap-if-block-and-sync.json: (history: at the prior pin the
  // whole file was blocked by the now-exited wasmparser/wast pin-drift
  // class — see the EXIT note at the top of this file, $Tester's canonical
  // section used 🧵 thread built-in encodings that the old decoder
  // misparsed.) $Tester TRANSLATES AND DEFINES fine at the current pin
  // (line 5 is stale here and pruned, confirmed by the stale-xfail
  // detector); the surviving gap is one level down — instantiating it
  // needs a host trampoline for a deferred thread built-in
  // (`thread-yield-then-resume`), which this executor does not implement
  // yet (deferred threads, https://github.com/polymorph-components/polyengine/issues/12).
  // Every `(component instance $i $Tester)` command in the file is
  // therefore pending-capability and SKIPPED (not failed; no xfail entry
  // needed), and every assert against it cascades with "no current
  // instance". CM#705 grew the file from 17 to 18 exported tests
  // (trap-if-sync-cancel plus the four sync-stream/-future rows); the
  // subsequent re-pin further changed the exact command layout (module_instance
  // + assert pairs interleave 1:1 now, at lines 315-360, rather than the
  // old single-definition-then-39-cascades shape at lines 5/273-311), so
  // the old cascade line numbers (273-311) no longer correspond to any
  // command in the regenerated corpus and have been replaced with the
  // current ones below. ---
  {
    file: "async/trap-if-block-and-sync.json",
    line: 316,
    reason:
      "cascade of line 315 (module_instance pending-capability: instantiate " +
      "requires host trampoline 'thread-yield-then-resume', deferred " +
      "thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): no current instance",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 318,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 320,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 322,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 324,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 326,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 328,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 330,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 332,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 334,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 336,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 338,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 340,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 342,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 344,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 346,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 348,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 350,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 352,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 354,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 356,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 358,
    reason: "same cascade as line 316, see that entry",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 360,
    reason: "same cascade as line 316, see that entry",
  },
  // --- async/trap-if-done.json: root cause: STREAMS ---
  // --- async/trap-if-sync-and-waitable-set.json: root cause: deferred
  // thread built-ins (https://github.com/polymorph-components/polyengine/issues/12) — this file's Tester component
  // needs a host trampoline for `thread-new-indirect`, which this executor
  // does not implement yet, so every `module_instance` command against it
  // is pending-capability/SKIPPED (no xfail entry needed) and every assert
  // cascades with "no current instance". The file grew (CM#715) so the
  // cascade now extends past the pre-existing 281-305 entries below to
  // 307-327 (new entries added at the end of this block). Also listed in
  // upstream's own third_party/component-model/test/nyi.txt at this pin. ---
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 281,
    reason:
      "cascade: this file's component was declined earlier, so " +
      "every later command against the instance fails; see the " +
      "first entry for this file",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 283,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 285,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 287,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 289,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 291,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 293,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 295,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 297,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 299,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 301,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 303,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 305,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 307,
    reason:
      "cascade of this file's Tester module_instance command " +
      "(pending-capability: instantiate requires host trampoline " +
      "'thread-new-indirect', deferred thread built-ins, https://github.com/polymorph-components/polyengine/issues/12): " +
      "no current instance — new row, file grew (CM#715)",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 309,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 311,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 313,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 315,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 317,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 319,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 321,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 323,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 325,
    reason: "same cascade as line 307, see that entry",
  },
  {
    file: "async/trap-if-sync-and-waitable-set.json",
    line: 327,
    reason: "same cascade as line 307, see that entry",
  },
  // --- async/trap-if-transfer-in-waitable-set.json: root cause: STREAMS ---
  // --- async/wait-during-callback.json: root cause: STREAMS ---
  // --- async/zero-length.json: GREEN under jspi auto-detection (the jspi flip);
  // entry pruned. ---
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}

// ---------------------------------------------------------------------------
// Schedule-profile-dependent corpus files — a different axis from XFAIL
// above.
//
// XFAIL entries mean "the engine can't do this yet" (a capability gap).
// The entries below mean the opposite: the ENGINE is fine, but the guest
// component itself encodes an assumption that only holds under the
// reference interpreter's DETERMINISTIC_PROFILE
// (third_party/component-model/design/mvp/canonical-abi/definitions.py:1373),
// where `Store.tick` (definitions.py:603) resolves ties in a fixed order
// instead of `random.choice`. Our default FIFO policy matches that profile,
// so these files are fully green normally — they only need to be skipped
// when `POLYENGINE_SCHED_SEED` deliberately explores schedules BEYOND it
// (see runtime/src/task/scheduler.ts's `readSeed`/seeded-shuffle policy).
//
// async/async-calls-sync.json (async-calls-sync.wast:183 area) is the
// precedent for this class: the guest asserts each subtask's RETURNED value
// equals its subtask index, where that index is `$AsyncInner`'s `$counter`,
// handed out in the order backpressured tasks are RELEASED. That release
// order is pinned only under DETERMINISTIC_PROFILE; under a seed the guest
// can legitimately observe a different release order and hit its own
// `unreachable` — a profile-dependent guest assumption failing, not an
// engine fault. This is the exact class runtime/tests/jspi/handshake_test.ts
// (lines ~40-58) already self-skips for the same file, for the same reason,
// on the runtime side; this set lets harness/tests/conformance_test.ts do
// the analogous self-skip on the conformance-suite side.
//
// Measured (orchestrator, this repo): reproduces identically at
// POLYENGINE_SCHED_SEED = 1, 2, 3, 7, 4242, 99991 — always exactly this one
// corpus file failing (wast lines 250/251, "expected return, got trap:
// guest trapped: unreachable"), consistent with a scheduling-order-dependent
// guest assertion rather than a flake or an engine regression.
//
// Corpus-relative path, same shape as XfailEntry.file.
export const DETERMINISTIC_PROFILE_ONLY: ReadonlySet<string> = new Set([
  "async/async-calls-sync.json",
]);
