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
    line: 962,
    reason:
      "translator error [validation]: invalid boolean value — wasmparser " +
      "0.252 misparses the 🧵 thread built-in encodings re-aritied in the " +
      "0.253-0.255 window; dual-classed with deferred threads " +
      "(https://github.com/polymorph-components/polyengine/issues/12), pin exit tracked by " +
      "https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "binary/binary.json",
    line: 1194,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — the 0x2 name option is the 🔗 canonical-interface-names " +
      "encoding (canonversion/versionsuffix), which postdates wasmparser " +
      "0.252 (contracts/embedder-api.md forward note); pin exit tracked by " +
      "https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  // --- validation/attributes.json: same 0x2 name-option pin drift as
  // binary/binary.json:1194 above. ---
  {
    file: "validation/attributes.json",
    line: 30,
    reason:
      "translator error [validation]: invalid leading byte (0x2) for name " +
      "option — same 🔗 canonical-names pin-drift class as " +
      "binary/binary.json:1194, https://github.com/polymorph-components/polyengine/issues/152 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "validation/attributes.json",
    line: 213,
    reason: "same name-option pin drift as line 30, see that entry",
  },
  // --- values/post-return.json: post-return.wast:4 ($Tester) declares
  // every async built-in (task.return, thread.yield/INDEX, waitable-set.*,
  // subtask.*, stream.*, future.*) to assert they trap from a post-return
  // function. The M2 task core shipped; the SURVIVING refusal is
  // 'thread-index' — the 🧵 shared-everything-threads class, deferred by
  // https://github.com/polymorph-components/polyengine/issues/12 — so the component still declines at instantiation and all 28
  // assert_traps cascade off 'no current instance'. (Reason strings
  // rewritten post-M2-exit-review: they previously named the shipped task
  // core, which would misdirect triage.)
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
  // lowers to `CoreDef::UnsafeIntrinsic` — a shape plan v0 has no wire form
  // for (plan-format.md v0.1 amendments; the known M2 blocker).
  // post-return.wast:334 calls `backpressure.inc`/`backpressure.dec` from a
  // post-return function. NOTE the observed symptom is a *wrong value*
  // ("expected u32 11, got 5"), not an error: the module command fails as a
  // capability skip and the invoke then runs against the previously
  // instantiated component, which also exports `f`. The value mismatch is an
  // artifact of that, not a canonical-ABI bug.
  // --- values/variants.json: GREEN. variants.wast:83's component mixes an
  // async-lifted export (`mix-ret`) with sync ones, reached through FACT
  // adapters; M2 phase 2b (prepare-call / {sync,async}-start-call) made it
  // instantiate and run — pinned by runtime/tests/integration/
  // e2e_suite_test.ts ("async-lifted exports instantiate and run"). ---

  // =====================================================================
  // async/ — triage as of M2 phase 2c (streams/futures/error-context).
  //
  // Streams, futures and error-context are IMPLEMENTED; the entries below no
  // longer describe a missing value type. The dominant remaining class is
  // JSPI: the *synchronous* form of a stream/future copy, of
  // `waitable-set.wait`, and of a cross-component call all block the calling
  // wasm frame, which a stackless runtime cannot do. See
  // runtime/src/intrinsics/stream_builtins.ts `finishCopy`.
  //
  // Historic note (M2 phase 1 triage) follows.
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
  //   * streams / futures — 41 commands (M2 phase 2, out of this track).
  //   * 166 further commands are *cascades*: once a component instance is
  //     declined at instantiation, every later command against it fails with
  //     "no current instance". They carry the root cause's reason.
  //   * 4 genuine one-off gaps, each with its own entry (trap-message
  //     fidelity, instance poisoning, instantiation-time task context, and one
  //     shim decoder gap).
  // =====================================================================
  // --- async/async-calls-sync.json: GREEN under jspi auto-detection (M2
  // flip); entries pruned. ---
  // --- async/big-interleaving-test.json: GREEN under jspi auto-detection
  // (M2 flip); entry pruned. ---
  // --- async/builtin-trap-poisons-instance.json: root cause: STREAMS ---
  // --- async/cancel-stream.json: root cause: STREAMS ---
  // --- async/cancel-subtask.json: GREEN under jspi auto-detection (M2
  // flip); entry pruned. ---
  // --- async/cancellable.json: GREEN under jspi auto-detection (M2 flip:
  // request_cancellation now finds cancellable SuspensionPoints, and the
  // async subtask.cancel waits for callee determinacy); entry pruned. ---
  // --- async/closed-stream.json: root cause: STREAMS ---
  // --- async/cross-abi-calls.json: root cause: FACT-ASYNC ---
  // --- async/cross-task-future.json: root cause: STREAMS ---
  // --- async/deadlock.json: GREEN under jspi auto-detection (M2 flip: the
  // driver's deadlock verdict now fires with wasmtime's trap text); entry
  // pruned. ---
  // --- async/dont-block-start.json: GREEN under jspi auto-detection (M2
  // flip: a start-function SuspendError maps to "cannot block a synchronous
  // task before returning"); entry pruned. ---
  // --- async/drop-cross-task-borrow.json: root cause: FACT-ASYNC ---
  // lines 305/307 GREEN after the #18 tls-smoke fixes (FACT [async-start]
  // borrow window + ResourceTypeInfo unification); line 309 GREEN after the
  // #13 wording fix (task-exit borrow check words as wasmtime's "borrow
  // handles still remain at the end of the call"); entries pruned.
  // --- async/drop-stream.json: root cause: STREAMS ---
  // line 158 GREEN after the #13 wording fix (busy readable-end drop words
  // as a removal, matching wasmtime); entry pruned.
  // --- async/drop-subtask.json: GREEN under jspi auto-detection (M2 flip);
  // entry pruned. ---
  // --- async/drop-waitable-set.json: root cause: FACT-ASYNC ---
  // --- async/during-sync-call-*.json (3 files, upstream #691): all three
  // pin 🧵 sync-call-blocking semantics and are built entirely from thread
  // built-ins (thread.new-indirect / resume-later / suspend-then-resume /
  // suspend) — the deferred-threads class,
  // https://github.com/polymorph-components/polyengine/issues/12 — and their components fail
  // TRANSLATION first, in the wasmparser-pin-drift class documented at
  // trap-if-block-and-sync.json:5: wasmparser 0.252 predates the
  // 0.253-0.255 re-arity of the thread built-in opcodes (0x28
  // thread.resume-later doesn't exist; 0x29/0x2a read no cancel? byte), so
  // the decoder misparses the canonical section. Upstream lists all three
  // in test/nyi.txt (wasmtime's own runner skips them). ---
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
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 8,
    reason:
      "translator error [validation]: invalid leading byte (0x28) for " +
      "canonical function lift (at offset 0x322) — wasmparser pin drift " +
      "(class of trap-if-block-and-sync.json:5): 0x28 is 🧵 " +
      "thread.resume-later in the wast-255 encoding but has no production " +
      "in wasmparser 0.252; deferred-threads anyway, " +
      "https://github.com/polymorph-components/polyengine/issues/12 " +
      "(pending-capability: wasmparser/wast pin alignment)",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 115,
    reason:
      "cascade of this file's first failure (line 8): the component failed " +
      "translation, so no current instance exists",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 116,
    reason: "cascade of line 8, see line 115",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 117,
    reason: "cascade of line 8, see line 115",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 118,
    reason: "cascade of line 8, see line 115",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 119,
    reason: "cascade of line 8, see line 115",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 162,
    reason:
      "cascade of the line-124 component declining at instantiation " +
      "(🧵 host trampoline, deferred-threads " +
      "https://github.com/polymorph-components/polyengine/issues/12, classified " +
      "pending-runtime, the values/post-return.json precedent): no current " +
      "instance exists for this command",
  },
  {
    file: "async/during-sync-call-no-exclusive-resume.json",
    line: 163,
    reason: "same line-124 instantiation-decline cascade as line 162",
  },
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 16,
    reason:
      "translator error [validation]: invalid leading byte (0x28) for " +
      "canonical function lift (at offset 0x30c) — same wasmparser " +
      "pin-drift class as during-sync-call-no-exclusive-resume.json:8; " +
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
  // --- async/empty-wait.json: GREEN under jspi auto-detection (M2 flip);
  // entry pruned. ---
  // --- async/futures-must-write.json: root cause: STREAMS ---
  // --- async/partial-stream-copies.json: GREEN under jspi auto-detection
  // (M2 flip); entry pruned. ---
  // --- async/passing-resources.json: lines 175/176 GREEN after the #18
  // tls-smoke fixes (cycle-safe structural ValType equality + token
  // unification); entries pruned. ---
  // --- async/same-component-stream-future.json: root cause: STREAMS ---
  // --- async/sync-barges-in.json: GREEN under jspi auto-detection (M2
  // flip); entry pruned. ---
  // --- async/sync-streams.json: GREEN. Since #43 polyengine implements
  // wasmtime's model: the entry gate is HELD for the whole core invocation
  // (a resolved producer blocked mid-sync-write keeps gating), and the
  // async-lowered call's initial status is decided only after the callee
  // instance's runnable work has been drained to quiescence — by which time
  // the producer has exited and the next task reports STARTED. Adjudicated
  // 2026-08-10 (issue #43): the test's hard STARTED assertion is
  // schedule-dependent — an upstream test defect overfitting wasmtime's
  // deferred-entry policy (pristine definitions.py answers STARTING) —
  // and polyengine's drain policy satisfies it as written under any seed. The
  // former release-at-BLOCK divergence is gone. (Before the M2 jspi flip
  // this file was xfailed outright.)
  // entry pruned. ---
  // --- async/trap-if-block-and-sync.json: see entries ---
  {
    file: "async/trap-if-block-and-sync.json",
    line: 5,
    reason:
      "wasmparser pin drift (same class as binary.json:962/1194 and " +
      "attributes.json:30/213): `testgen` assembles the suite with `wast` " +
      "255.0.0 while `translator-shim` validates with `wasmparser` 0.252.0, " +
      "the version wasmtime-environ 47.0.3 links against. The 0.253-0.255 " +
      "window re-aritied the thread built-in opcodes: `0x2a` is " +
      "`ThreadUnsuspend` (no payload) in 0.252 but " +
      "`ThreadSuspendThenResume{cancellable}` (reads one byte) in 0.255. " +
      "This file's canonical section ends `... 2a 00 28 ...` at 0xc16; " +
      "0.252 stops after `2a`, misreads the `00` at 0xc17 as a new " +
      "canonical function (`0x00` = lift family), then rejects the `0x28` " +
      "at 0xc18 — the reported error, exactly. Not a plan.rs mapping bug: " +
      "the failure is in wasmparser's decoder, before any mapping runs. " +
      "Lifted by a wasmtime-environ whose wasmparser is >= the 0.255 line; " +
      "downgrading testgen to `wast` 252 is NOT a fix (verified: it fails " +
      "to parse 44 of the 59 suite files, which use the newer " +
      "`(memory (core memory ...))` text syntax). Note the file's canonical " +
      "functions are all deferred thread built-ins anyway (https://github.com/polymorph-components/polyengine/issues/12) " +
      "(pending-capability: wasmparser/wast pin alignment)",
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
  {
    file: "async/trap-if-block-and-sync.json",
    line: 312,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 313,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 314,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 315,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 316,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 317,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 318,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 319,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 320,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 321,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 322,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 323,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 324,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 325,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 326,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 327,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 328,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 329,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 330,
    reason:
      "cascade of this file's first failure: the component was " +
      "declined at instantiation, so no instance exists for this " +
      "command",
  },
  {
    file: "async/trap-if-block-and-sync.json",
    line: 331,
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
  // --- async/zero-length.json: GREEN under jspi auto-detection (M2 flip);
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
