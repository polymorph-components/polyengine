// Checked-in triage list for commands known to fail against the current
// runtime. Passing entries are stale and fail the conformance gate.

export interface XfailEntry {
  file: string;
  line: number;
  reason: string;
}

const issue248 =
  "https://github.com/polymorph-components/polyengine/issues/248";
const issue249 =
  "https://github.com/polymorph-components/polyengine/issues/249";

export const XFAIL: XfailEntry[] = [
  // The pinned Wasmtime frontend does not yet implement the Component Model
  // name-folding conflicts (CM#703/#704); test/nyi.txt lists this file.
  ...[
    [150, "`foobar` conflicts with `foo-bar`"],
    [155, "`FOOBAR` conflicts with `foo-bar`"],
    [160, "`foob-ar` conflicts with `foo-bar`"],
    [165, "the static-qualified folded name conflicts"],
    [170, "the method-qualified folded name conflicts"],
  ].map(([line, detail]) => ({
    file: "validation/kebab.json",
    line: line as number,
    reason:
      `expected assert_invalid because ${detail}, but the pinned frontend validated it; name-rules NYI, ${issue248}`,
  })),

  // The pinned frontend likewise lacks CM#688's elem_size < 2^28 rule;
  // test/nyi.txt lists this file. Line 64 is the pointer-width boundary case.
  ...[26, 32, 38, 44, 49, 58, 64].map((line) => ({
    file: "validation/max-value-size.json",
    line,
    reason:
      `expected assert_invalid (exceeds maximum byte size), but the pinned frontend validated it; max-value-size NYI, ${issue248}`,
  })),

  // These are current runtime diagnostic/scheduling gaps, not deferred-thread
  // cascades. The thread built-ins instantiate and execute; each row below was
  // re-run directly after that support landed.
  {
    file: "async/during-sync-call-no-sibling-resume.json",
    line: 156,
    reason:
      `guest reaches unreachable instead of returning during the no-sibling-resume schedule; sync scheduling gap, ${issue249}`,
  },
  ...[46, 48, 50, 52].map((line) => ({
    file: "async/self-switch-traps.json",
    line,
    reason:
      `operation traps as required, but reports "cannot resume the current thread" instead of "cannot resume thread which is not suspended"; diagnostic mismatch, ${issue249}`,
  })),
  ...[355, 357, 363, 365].map((line) => ({
    file: "async/switch-to-ready-callback.json",
    line,
    reason:
      `operation traps as required, but reports "cannot resume thread" instead of "cannot resume thread which is not suspended"; diagnostic mismatch, ${issue249}`,
  })),
  {
    file: "async/trap-if-block-and-sync.json",
    line: 316,
    reason:
      `reports the host driver's deadlock diagnostic instead of the synchronous-callee cannot-block diagnostic; sync scheduling gap, ${issue249}`,
  },
  ...[328, 330, 332].map((line) => ({
    file: "async/trap-if-block-and-sync.json",
    line,
    reason:
      `reports a specific invalid callback code instead of the corpus's unsupported-callback-code diagnostic; diagnostic mismatch, ${issue249}`,
  })),
  ...[204, 206].map((line) => ({
    file: "values/post-return.json",
    line,
    reason:
      `post-return operation traps as required, but reports "may_leave violation" instead of "cannot leave component instance"; diagnostic mismatch, ${issue249}`,
  })),
  ...[212, 218, 226, 232, 234, 236, 238, 246, 248, 250, 252].map((line) => ({
    file: "values/post-return.json",
    line,
    reason:
      `post-return blocking builtin escapes as a JSPI SuspendError instead of the required Component Model trap; post-return boundary gap, ${issue249}`,
  })),
];

export function isXfail(file: string, line: number): boolean {
  return XFAIL.some((e) => e.file === file && e.line === line);
}

// Schedule-profile-dependent corpus files are a different axis from XFAIL.
// This guest asserts an order guaranteed only by definitions.py's
// DETERMINISTIC_PROFILE. Seeded runs deliberately explore other valid orders.
export const DETERMINISTIC_PROFILE_ONLY: ReadonlySet<string> = new Set([
  "async/async-calls-sync.json",
]);
