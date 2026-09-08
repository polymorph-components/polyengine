// Shared classification helpers for engine-lane drivers (browser + shell
// canary lanes): given per-file command results and a lane's expectation
// overlay, classify against the Deno-lane xfail truth
// (`harness/src/xfail.ts`) widened/narrowed by the overlay's deltas, and
// report unexpected failures / stale overlay entries / totals drift.

import { Summary } from "../../harness/src/summary.ts";
import { isXfail } from "../../harness/src/xfail.ts";
import type { FileResult } from "../../harness/src/runner.ts";
import type {
  LaneDelta,
  LaneTotals,
} from "../../harness/browser/expectations/types.ts";
import { deltaKey } from "../../harness/browser/expectations/types.ts";

/** Minimal shape any lane driver's per-file result must satisfy. */
export interface ClassifiableFile {
  path: string;
  dir: string;
  source: string;
  // deno-lint-ignore no-explicit-any
  results: any[];
}

/** Minimal shape of a lane expectation overlay this module needs. */
export interface ClassifiableExpectation {
  deltas: LaneDelta[];
  fileDeltas?: { file: string; reason: string }[];
}

export interface Classified {
  summary: Summary;
  /** Unexpected failures: failed, not xfail on Deno, not an expected delta. */
  unexpectedFailures: {
    file: string;
    line: number;
    type: string;
    detail: string;
  }[];
  /** Deltas the overlay predicted but that did not occur (stale entries). */
  staleDeltas: { file: string; line: number; kind: string; reason: string }[];
}

export function classify<F extends ClassifiableFile>(
  files: F[],
  exp: ClassifiableExpectation,
): Classified {
  const summary = new Summary();
  const expectedFail = new Map<string, string>();
  const expectedPass = new Map<string, string>();
  for (const d of exp.deltas) {
    (d.kind === "expected-fail" ? expectedFail : expectedPass)
      .set(deltaKey(d.file, d.line), d.reason);
  }
  const exemptFiles = new Map(
    (exp.fileDeltas ?? []).map((f) => [f.file, f.reason]),
  );
  const hitFail = new Set<string>();
  const hitPass = new Set<string>();

  const unexpectedFailures: Classified["unexpectedFailures"] = [];

  for (const f of files) {
    const fileExempt = exemptFiles.has(f.path);
    const fileResult: FileResult = { source: f.source, results: f.results };
    // Lane xfail predicate: the Deno-lane xfail set, widened by this lane's
    // `expected-fail` deltas and narrowed by its `expected-pass` deltas.
    // Narrowing matters for the stale-xfail gate: an `expected-pass` delta
    // says "this Deno xfail passes here", so it must NOT be reported stale.
    summary.add(f.dir, fileResult, (r) => {
      const key = deltaKey(f.path, r.line);
      if (expectedPass.has(key)) {
        hitPass.add(key);
        return false;
      }
      if (expectedFail.has(key)) {
        hitFail.add(key);
        return true;
      }
      if (fileExempt && r.status === "failed") return true;
      return isXfail(f.path, r.line);
    });

    for (const r of f.results) {
      if (r.status !== "failed") continue;
      const key = deltaKey(f.path, r.line);
      if (expectedFail.has(key) || fileExempt || isXfail(f.path, r.line)) {
        continue;
      }
      unexpectedFailures.push({
        file: f.path,
        line: r.line,
        type: r.type,
        detail: String(r.detail ?? ""),
      });
    }
  }

  const staleDeltas = exp.deltas.filter((d) => {
    const key = deltaKey(d.file, d.line);
    return d.kind === "expected-fail" ? !hitFail.has(key) : !hitPass.has(key);
  }).map((d) => ({
    file: d.file,
    line: d.line,
    kind: d.kind,
    reason: d.reason,
  }));

  return { summary, unexpectedFailures, staleDeltas };
}

export function totalsOf(summary: Summary): LaneTotals {
  const t = summary.total();
  return {
    commands: t.commands,
    executed: t.executed,
    passed: t.passed,
    failed: t.failed,
    xfail: t.xfail,
    pendingRuntime: t.pendingRuntime,
    pendingCapability: t.pendingCapability,
    unsupportedDirective: t.unsupportedDirective,
  };
}

export function diffTotals(got: LaneTotals, want: LaneTotals): string[] {
  const out: string[] = [];
  for (const k of Object.keys(want) as (keyof LaneTotals)[]) {
    if (got[k] !== want[k]) {
      out.push(`  ${k}: got ${got[k]}, expected ${want[k]}`);
    }
  }
  return out;
}
