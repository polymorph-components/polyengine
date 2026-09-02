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
  // --- binary/binary.json: wasmparser pin drift (#13 exit re-classified
  // these from "translator-shim gaps" to pin-blocked: the rejecting decoder
  // is wasmparser 0.252 inside wasmtime-environ 47.0.3, not shim code —
  // the error strings below do not occur in crates/translator-shim).
  // Tracked by https://github.com/polymorph-components/polyengine/issues/152. The former
  // binary.json:1421 entry (module exports) is GONE: plan v4 carries
  // core-module exports (#13). ---
  {
    file: "binary/binary.json",
    line: 974,
    reason:
      "translator error [validation]: invalid boolean value — wasmparser " +
      "0.252 misparses the 🧵 thread built-in encodings re-aritied in the " +
      "0.253-0.255 window; dual-classed with deferred threads " +
      "(https://github.com/polymorph-components/polyengine/issues/12), pin exit tracked by " +
      "https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment). CM#705 pin " +
      "advance (polyengine#173) shifted this row from wast line 962 to " +
      "974 (12 lines of CM#698 outer-alias-count edits landed earlier in " +
      "the file); same error, same offset class, line renumbered only.",
  },
  {
    file: "binary/binary.json",
    line: 1206,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — the 0x2 name option is the 🔗 canonical-interface-names " +
      "encoding (canonversion/versionsuffix), which postdates wasmparser " +
      "0.252 (contracts/embedder-api.md forward note); pin exit tracked by " +
      "https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment). CM#705 pin " +
      "advance (polyengine#173) shifted this row from wast line 1194 to " +
      "1206; same error, same offset class, line renumbered only.",
  },
  // --- validation/attributes.json: same 0x2 name-option pin drift as
  // binary/binary.json:1206 above. ---
  {
    file: "validation/attributes.json",
    line: 30,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — same 🔗 canonical-names pin-drift class as " +
      "binary/binary.json:1206, https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "validation/attributes.json",
    line: 213,
    reason: "same name-option pin drift as line 30, see that entry",
  },
  // --- validation/kebab.json: CM#703/#704 ("name rules" reworks, pulled in
  // by the CM#705 pin advance polyengine#173) added import-name-conflict
  // checks under kebab-case folding (a `foo-bar` import conflicts with
  // `foobar`/`FOOBAR`/`foob-ar`/method-and-static-qualified variants that
  // fold to the same name). wasmtime-environ 47.0.3's wasmparser accepts
  // all five components as distinct imports — the folding-conflict check is
  // newer than the pinned wasmparser. Classed `name-rules-47`,
  // https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmparser/wast pin
  // alignment). Same gap class already tracked for interface names in
  // upstream-component-model-repo-findings.md (#246/#247). ---
  {
    file: "validation/kebab.json",
    line: 149,
    reason:
      'expected assert_invalid ("import name `foobar` conflicts with ' +
      'previous name `foo-bar`"), but it validated — wasmparser 0.252 ' +
      "(wasmtime-environ 47.0.3) does not implement CM#703/#704's " +
      "kebab-case name-folding conflict check; name-rules-47, " +
      "https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmparser/wast pin " +
      "alignment)",
  },
  {
    file: "validation/kebab.json",
    line: 154,
    reason:
      'expected assert_invalid ("import name `FOOBAR` conflicts with ' +
      'previous name `foo-bar`"), but it validated — same name-rules-47 ' +
      "gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 159,
    reason:
      'expected assert_invalid ("import name `foob-ar` conflicts with ' +
      'previous name `foo-bar`"), but it validated — same name-rules-47 ' +
      "gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 164,
    reason:
      'expected assert_invalid ("import name `[static]foo-bar.FO-ob-AR` ' +
      'conflicts with previous name `foo-bar`"), but it validated — same ' +
      "name-rules-47 gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/kebab.json",
    line: 169,
    reason:
      'expected assert_invalid ("import name `[method]foo-bar.foobar` ' +
      'conflicts with previous name `foo-bar`"), but it validated — same ' +
      "name-rules-47 gap as line 149, https://github.com/polymorph-components/polyengine/issues/248",
  },
  // --- validation/max-value-size.json: CM#688 ("max-value-size", pulled in
  // by the CM#705 pin advance polyengine#173) added the elem_size(t, i64) <
  // 2^28 validation rule (CanonicalABI.md#element-size). wasmtime-environ
  // 47.0.3's wasmparser does not enforce it — every assert_invalid in this
  // file validates instead of rejecting. Classed `max-value-size-47`,
  // https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmparser/wast pin
  // alignment). Line 63 is the dispatch-flagged pointer-width-sensitive row
  // (`list string 16777216`, the i32-vs-i64 elem-size boundary): observed
  // behavior on this (presumably 64-bit host) run is identical to the
  // others — wasmparser accepts it outright, not a differing failure mode
  // tied to pointer width. ---
  {
    file: "validation/max-value-size.json",
    line: 25,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — wasmparser 0.252 (wasmtime-environ 47.0.3) does not " +
      "implement CM#688's elem_size < 2^28 check (single fixed list just " +
      "over the limit: `(list u8 268435456)`); max-value-size-47, " +
      "https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmparser/wast pin " +
      "alignment)",
  },
  {
    file: "validation/max-value-size.json",
    line: 31,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25 (fixed list " +
      "whose product exceeds MAX: `(list u64 33554432)`), " +
      "https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 37,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25 (u32-wrap class: " +
      "real byte size is 2^32 but a naive u32 multiply wraps to 0: " +
      "`(list u64 536870912)`), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 43,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25 (compound sum " +
      "exceeds MAX via a tuple), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 48,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25 (compound sum " +
      "exceeds MAX via a record), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 57,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25 (nested fixed " +
      "list), https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "validation/max-value-size.json",
    line: 63,
    reason:
      'expected assert_invalid ("exceeds maximum byte size"), but it ' +
      "validated — same max-value-size-47 gap as line 25; this is the " +
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
  // https://github.com/polymorph-components/polyengine/issues/12 — and their components fail TRANSLATION first,
  // in the wasmparser-pin-drift class documented at trap-if-block-and-sync.
  // json:5 (https://github.com/polymorph-components/polyengine/issues/152): wasmparser 0.252 predates the 0.253-0.255
  // re-arity of the thread built-in opcodes, so the decoder misparses the
  // canonical section. `async/during-sync-call-exclusive-resume.json` and
  // `async/during-sync-scheduling-candidates.json` are BRAND NEW files added by
  // the CM#705 pin advance (polyengine#173) — they did not exist pre-advance,
  // so these are new entries, not renumbered ones. Predicted class from the
  // dispatch was `cm705-sync-sched` (polyengine#249, a semantic scheduling
  // deviation); investigation found the observed failures are translator-level
  // (TranslateError at the `module`/`module_definition` command, not a runtime
  // semantic mismatch), root-caused by the SAME thread-built-in wasmparser pin
  // drift as the older during-sync-call-*.json files below — so these are
  // classed here (https://github.com/polymorph-components/polyengine/issues/152 / https://github.com/polymorph-components/polyengine/issues/12), not under #249. ---
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 12,
    reason:
      "translator error [validation]: invalid boolean value (at offset " +
      "0x3eb) — wasmparser pin drift (class of trap-if-block-and-sync." +
      "json:5): the $Tester definition's canonical section uses 🧵 " +
      "thread.new-indirect/resume-later/suspend-then-resume encodings that " +
      "wasmparser 0.252 misparses; deferred-threads anyway, " +
      "https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 110,
    reason:
      "cascade of line 12: the Tester definition failed translation, so " +
      "there is no definition named 'Tester' to instantiate",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 111,
    reason: "cascade of line 12 via line 110: no current instance",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 112,
    reason: "cascade of line 12 via line 110: no current instance",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 114,
    reason:
      "cascade of line 12: the Tester definition failed translation, so " +
      "there is no definition named 'Tester' to instantiate",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 115,
    reason: "cascade of line 12 via line 114: no current instance",
  },
  // CM#705 (polyengine#173) appended a second component to this file (a new
  // "setup"/"run" pair driven by thread.new-indirect/index/resume-later/
  // suspend) — same thread-built-in pin-drift mechanism as line 12 above, at
  // a fresh offset.
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 136,
    reason:
      "translator error [validation]: invalid boolean value (at offset " +
      "0x28e) — same wasmparser thread-built-in pin-drift class as line 12 " +
      "(https://github.com/polymorph-components/polyengine/issues/152), new second component appended by the CM#705 " +
      "pin advance (polyengine#173); deferred-threads anyway, " +
      "https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 206,
    reason: "cascade of line 136: no current instance",
  },
  {
    file: "async/during-sync-call-may-block-if-other-ready-threads.json",
    line: 207,
    reason: "cascade of line 136: no current instance",
  },
  // async/during-sync-call-exclusive-resume.json: BRAND NEW file (CM#705 pin
  // advance, polyengine#173; test/async/during-sync-call-exclusive-resume.wast
  // is 100% new content, not a renumbering of the deleted
  // during-sync-call-no-exclusive-resume.wast). All three of its components
  // are built from thread.index/suspend/resume-later — same pin-drift class.
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 9,
    reason:
      "translator error [validation]: unexpected end-of-file (at offset " +
      "0x158) — same wasmparser thread-built-in pin-drift class as " +
      "trap-if-block-and-sync.json:5 (https://github.com/polymorph-components/polyengine/issues/152): 0.252 reads no " +
      "cancel? byte for 🧵 thread.suspend, walks the canonical section out " +
      "of alignment and off the end; deferred-threads anyway, " +
      "https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 59,
    reason: "cascade of line 9: no current instance",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 60,
    reason: "cascade of line 9: no current instance",
  },
  // line 65 (the file's second component) is a skipped-not-failed command;
  // no xfail entry needed. Its cascades at lines 102/103 target the THIRD
  // component (line 65's own module definition succeeds), which fails
  // translation independently for the same reason as line 9.
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 102,
    reason:
      "cascade: the third component in this file failed translation for " +
      "the same reason as line 9 (thread-built-in pin drift, " +
      "https://github.com/polymorph-components/polyengine/issues/152); no current instance",
  },
  {
    file: "async/during-sync-call-exclusive-resume.json",
    line: 103,
    reason: "cascade of line 102: no current instance",
  },
  // async/during-sync-scheduling-candidates.json: BRAND NEW file (CM#705 pin
  // advance, polyengine#173). Six components, each built from thread
  // built-ins (thread.new-indirect/resume-later/suspend/index/
  // yield-then-promote); every component fails translation with the same
  // wasmparser thread-built-in pin-drift class as trap-if-block-and-sync.
  // json:5 (https://github.com/polymorph-components/polyengine/issues/152), cascading to every assert against it.
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 19,
    reason:
      "translator error [validation]: invalid boolean value (at offset " +
      "0x241) — wasmparser thread-built-in pin drift, same class as " +
      "trap-if-block-and-sync.json:5 (https://github.com/polymorph-components/polyengine/issues/152); deferred-threads " +
      "anyway, https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 74,
    reason: "cascade of line 19: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 75,
    reason: "cascade of line 19: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 78,
    reason:
      "translator error [validation]: invalid leading byte (0x2d) for " +
      "canonical function (at offset 0x196) — same pin-drift class as " +
      "line 19, https://github.com/polymorph-components/polyengine/issues/152 (pending-capability: wasmparser/wast pin " +
      "alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 132,
    reason: "cascade of line 78: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 133,
    reason: "cascade of line 78: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 134,
    reason: "cascade of line 78: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 135,
    reason: "cascade of line 78: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 144,
    reason:
      "translator error [validation]: invalid leading byte (0x2d) for " +
      "canonical function (at offset 0x1b1) — same pin-drift class as " +
      "line 19, https://github.com/polymorph-components/polyengine/issues/152 (pending-capability: wasmparser/wast pin " +
      "alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 234,
    reason: "cascade of line 144: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 235,
    reason: "cascade of line 144: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 236,
    reason: "cascade of line 144: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 237,
    reason: "cascade of line 144: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 245,
    reason:
      "component definition failed translation: translator error " +
      "[validation]: invalid boolean value (at offset 0x1d0) — same " +
      "pin-drift class as line 19, https://github.com/polymorph-components/polyengine/issues/152 (pending-capability: " +
      "wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 303,
    reason:
      "cascade of line 245: no definition named 'BlockedCallbackTester'" ,
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 307,
    reason:
      "cascade of line 245: no definition named 'BlockedCallbackTester'" ,
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 304,
    reason: "cascade of line 245: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 305,
    reason: "cascade of line 245: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 308,
    reason: "cascade of line 245: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 309,
    reason: "cascade of line 245: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 315,
    reason:
      "component definition failed translation: translator error " +
      "[validation]: invalid boolean value (at offset 0x1bb) — same " +
      "pin-drift class as line 19, https://github.com/polymorph-components/polyengine/issues/152 (pending-capability: " +
      "wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 403,
    reason:
      "cascade of line 315: no definition named 'SyncLiftedTester'",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 407,
    reason:
      "cascade of line 315: no definition named 'SyncLiftedTester'",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 404,
    reason: "cascade of line 315: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 405,
    reason: "cascade of line 315: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 408,
    reason: "cascade of line 315: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 409,
    reason: "cascade of line 315: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 414,
    reason:
      "translator error [validation]: invalid boolean value (at offset " +
      "0x2c1) — same pin-drift class as line 19, https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 482,
    reason: "cascade of line 414: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 483,
    reason: "cascade of line 414: no current instance",
  },
  {
    file: "async/during-sync-scheduling-candidates.json",
    line: 484,
    reason: "cascade of line 414: no current instance",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 16,
    reason:
      "translator error [validation]: invalid leading byte (0x28) for " +
      "canonical function lift (at offset 0x30c) — same wasmparser " +
      "pin-drift class as during-sync-call-exclusive-resume.json:9; " +
      "deferred-threads anyway, https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 155,
    reason:
      "cascade of this file's first failure (line 16): the component " +
      "failed translation, so no current instance exists",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 156,
    reason: "cascade of line 16, see line 155",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 162,
    reason:
      "translator error [validation]: unexpected end-of-file (at offset " +
      "0x291) — same wasmparser pin-drift class: 0.252 reads no cancel? " +
      "byte for 🧵 thread.suspend (0x29), walks the canonical section out " +
      "of alignment and off the end; deferred-threads anyway, " +
      "https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 214,
    reason:
      "cascade of the line-162 module failure: no current instance " +
      "exists for this command",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 215,
    reason: "same line-162 cascade as line 214",
  },
  // --- async/futures-must-write.json: root cause: STREAMS ---
  // --- async/reentrance.json: BRAND NEW file (test/async/reentrance.wast is
  // 100% new content added by CM#705's "remove the may_enter flag/trap",
  // polyengine#173). CORRECTED CLASSIFICATION (revision round; verified by
  // probing the runner directly and reading wasmtime-environ 47.0.3 source):
  //
  // The `wasm trap:` PREFIX is the discriminator between the two mechanisms
  // that can produce a "cannot enter component instance" message:
  //   - "wasm trap: cannot enter component instance" (the `wasm trap:` prefix)
  //     is raised by GENERATED ADAPTER CODE — wasmtime-environ 47.0.3's FACT
  //     compiles an unconditional `Trap::CannotEnterComponent` stub
  //     (src/fact/trampoline.rs:116-127) whenever a fused adapter's lift and
  //     lower sides are the SAME instance, or either is an ancestor of the
  //     other — i.e. every VERTICAL (parent/child, either direction) fused
  //     adapter is a static trap stub at the 47.0.3 pin, independent of
  //     polyengine's own reentrance implementation. Only SIBLING adapters
  //     compile to real fused code at this pin. Classed `fact-reentrance-47`,
  //     https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmtime-environ bump).
  //   - "cannot enter component instance ${index}" (NO `wasm trap:` prefix)
  //     is polyengine's OWN entry refusal (runtime/src/exec/boundary.ts,
  //     intrinsics/fact_calls.ts), produced in JS, not wasm — since the
  //     CM#705 adoption landed (#251/#252/#255 + the model deletion,
  //     polyengine#173) that refusal fires ONLY for a poisoned instance
  //     (the per-instance corpse divergence, docs/architecture.md §6); the
  //     transient reentrance gate it once signified is gone. ZERO corpus
  //     rows in this file hit that path: every failing row below carries
  //     the `wasm trap:` prefix, so all are FACT-47 static-stub trips.
  //     The adoption cannot be proven or disproven here: FACT-47's stubs
  //     trap before any polyengine runtime code runs. #173 is pinned by
  //     runtime unit tests, not by this file. See also the correction note at
  //     https://github.com/polymorph-components/polyengine/issues/248#issuecomment-5471308919. ---
  {
    file: "async/reentrance.json",
    line: 42,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 60,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 99,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 151,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 198,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 237,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 346,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 517,
    reason:
      "expected return, got trap: wasm trap: cannot enter component " +
      "instance — the `wasm trap:` prefix identifies this as FACT's " +
      "static vertical-adapter trap stub (wasmtime-environ 47.0.3 " +
      "src/fact/trampoline.rs:116-127 compiles `Trap::CannotEnterComponent` " +
      "unconditionally whenever the fused adapter's lift/lower share an " +
      "instance or either is an ancestor of the other), not polyengine's " +
      "own reentrance gate (whose message has no `wasm trap:` prefix); " +
      "fact-reentrance-47, https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: " +
      "wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 100,
    reason:
      "cannot enter component instance 0 (reentrance forbidden) — " +
      "instance poisoned by: Trap: wasm trap: cannot enter component " +
      "instance — a POISON CASCADE of line 99's FACT-47 static-stub trap " +
      "(polyengine's withPoisonCause names the original trap, #145): line " +
      "99 traps first with the wasm-trap-prefixed FACT stub, poisoning the " +
      "instance, so this second invoke on it reports the poisoned-corpse " +
      "wrapper around the same underlying cause; clears when line 99 " +
      "clears at the wasmtime-environ bump; fact-reentrance-47, " +
      "https://github.com/polymorph-components/polyengine/issues/248",
  },
  {
    file: "async/reentrance.json",
    line: 429,
    reason:
      "expected trap \"deadlock detected: event loop cannot make further " +
      "progress\", got \"wasm trap: cannot enter component instance\" — " +
      "the FACT-47 static vertical-adapter stub (trampoline.rs:116-127) " +
      "preempts the deadlock-detection path entirely, firing before the " +
      "scheduler can observe no ready threads; fact-reentrance-47, " +
      "https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmtime-environ bump)",
  },
  {
    file: "async/reentrance.json",
    line: 522,
    reason:
      "translator error [validation]: section size mismatch: unexpected " +
      "data at the end of the section (at offset 0xee) — wasmparser " +
      "thread-built-in pin drift, same class as trap-if-block-and-sync." +
      "json:5, https://github.com/polymorph-components/polyengine/issues/152 (this component uses " +
      "waitable-set.new/waitable.join/subtask.cancel plus thread " +
      "built-ins); deferred-threads anyway, https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment); NOT reentrance-related — " +
      "a pure translate-time parse-drift failure at the module command, before " +
      "any reentrance semantics could run",
  },
  {
    file: "async/reentrance.json",
    line: 645,
    reason:
      "cascade of line 522's translate-time failure: no current instance " +
      "(translate-time parse drift, not reentrance)",
  },
  {
    file: "async/reentrance.json",
    line: 657,
    reason:
      "translator error [validation]: invalid leading byte (0x2b) for " +
      "canonical function lift (at offset 0xe8) — same wasmparser " +
      "thread-built-in pin-drift class as line 522, https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment); NOT " +
      "reentrance-related — a pure translate-time parse-drift failure at " +
      "the module command",
  },
  {
    file: "async/reentrance.json",
    line: 760,
    reason:
      "cascade of line 657's translate-time failure: no current instance " +
      "(translate-time parse drift, not reentrance)",
  },
  {
    file: "async/reentrance.json",
    line: 837,
    reason:
      "expected trap \"waitable cannot be used synchronously while added " +
      "to a waitable set\", got \"wasm trap: cannot enter component " +
      "instance\" — the FACT-47 static vertical-adapter stub " +
      "(trampoline.rs:116-127) preempts the intended waitable-set-membership " +
      "trap by firing first on the reentrant call; fact-reentrance-47, " +
      "https://github.com/polymorph-components/polyengine/issues/248 (pending-capability: wasmtime-environ bump)",
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
  // --- async/trap-if-block-and-sync.json: cm705-gate-removal? No — the
  // whole file is blocked by the pre-existing wasmparser/wast pin-drift
  // class (https://github.com/polymorph-components/polyengine/issues/152, dual-classed with deferred
  // threads https://github.com/polymorph-components/polyengine/issues/12): $Tester's canonical section uses
  // 🧵 thread built-in encodings (CM#705 added a `trap-if-sync-cancel` export
  // built from thread.suspend/thread.resume-later et al) that wasmparser 0.252
  // misparses, same mechanism as binary.json:974/1206. Every later
  // "(component instance $i $Tester)" + assert command cascades off the one
  // failed component-definition command at line 5; CM#705 grew the file from
  // 17 to 18 exported tests (trap-if-sync-cancel plus the four
  // sync-stream/-future rows), so the cascade spans lines 273-311. ---
  {
    file: "async/trap-if-block-and-sync.json",
    line: 5,
    reason:
      "wasmparser pin drift (same class as binary.json:974/1206 and " +
      "attributes.json:30/213): `testgen` assembles the suite with `wast` " +
      "255.0.0 while `translator-shim` validates with `wasmparser` 0.252.0, " +
      "the version wasmtime-environ 47.0.3 links against. The 0.253-0.255 " +
      "window re-aritied the thread built-in opcodes, so 0.252 misparses the " +
      "$Tester canonical section and rejects a 🧵 thread-built-in-derived " +
      "leading byte (\"invalid leading byte (0x28) for canonical function " +
      "lift (at offset 0xb66)\" — a decoder-level failure, not a plan.rs " +
      "mapping bug). Lifted by a wasmtime-environ whose wasmparser is >= the " +
      "0.255 line; downgrading testgen to `wast` 252 is NOT a fix (verified: " +
      "it fails to parse 44 of the 59 suite files, which use the newer " +
      "`(memory (core memory ...))` text syntax). Note the file's canonical " +
      "functions are all deferred thread built-ins anyway (https://github.com/polymorph-components/polyengine/issues/12) " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 273,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 274,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 275,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 276,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 277,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 278,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 279,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 280,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 281,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 282,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 283,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 284,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 285,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 286,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 287,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 288,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 289,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 290,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 291,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 292,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 293,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 294,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 295,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 296,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 297,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 298,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 299,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 300,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 301,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 302,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 303,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 304,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 305,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 306,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 307,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 308,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 309,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 310,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 311,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  // --- async/trap-if-done.json: root cause: STREAMS ---
  // --- async/trap-if-sync-and-waitable-set.json: root cause: FACT-ASYNC ---
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
