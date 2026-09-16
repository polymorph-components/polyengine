// Checked-in triage list for commands known to fail against the current
// runtime. Passing entries are stale and fail the conformance gate.

export interface XfailEntry {
  file: string;
  line: number;
  reason: string;
}

const issue249 =
  "https://github.com/polymorph-components/polyengine/issues/249";

export const XFAIL: XfailEntry[] = [
  // These are current runtime diagnostic/scheduling gaps, not deferred-thread
  // cascades. The thread built-ins instantiate and execute; each row below was
  // re-run directly after that support landed.
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
