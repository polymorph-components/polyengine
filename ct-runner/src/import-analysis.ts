// Translate-only import analysis: `requiredImports()` (contracts/embedder-api.md
// §"Module wiring and instantiation") plus the runner's own test-context
// auto-wiring policy, without ever instantiating the suite. Used both by
// `runSuite` (to fail fast, before an async instantiate) and standalone (the
// "translate-only acceptance" gate: enumerate what a not-yet-executable suite
// is missing, without trying to run it).

import {
  type ImportLeaf,
  NameCollisionError,
  type PlanLike,
  requiredImports,
} from "@polyengine/runtime/embedder";
import { ImportResolver } from "@polyengine/runtime/embedder";
import { TEST_CONTEXT_INTERFACE } from "./context.ts";

/** One or more of the suite's import leaves cannot be resolved (yet). */
export class MissingImportsError extends Error {
  /** The unresolved leaves, in `requiredImports()` order. */
  readonly leaves: ImportLeaf[];
  /** The distinct top-level record keys (interface ids / bare names) missing. */
  readonly missing: string[];

  constructor(missing: string[], leaves: ImportLeaf[]) {
    super(
      `suite is missing ${missing.length} host import(s): ` +
        missing.map((m) => `'${m}'`).join(", "),
    );
    this.name = "MissingImportsError";
    this.missing = missing;
    this.leaves = leaves;
  }
}

export interface ImportAnalysis {
  /** Every linkable import leaf (`requiredImports()`, unfiltered). */
  leaves: ImportLeaf[];
  /** Whether this suite imports `test-context` at all (world-shaped suites do;
   * a pre-composed bundle with the provider already linked in does not). */
  requiresTestContext: boolean;
  /** Top-level keys the suite needs that `provided` (plus test-context, if
   * this runner will supply it) does not resolve. Empty when runnable. */
  missing: string[];
}

/**
 * Analyze a suite's import surface against a caller-provided imports record,
 * WITHOUT instantiating anything (translate-only; `requiredImports` reads
 * only the plan). Detects:
 *  - whether `test-context` is imported (only then does the runner provide
 *    it; pre-composed bundles already include their provider);
 *  - a caller/runner collision on `test-context`;
 *  - every other top-level import key the suite needs but `provided` lacks,
 *    via the same version-canonical resolution `instantiate` itself uses
 *    (`ImportResolver`, contracts/embedder-api.md §"Version canonicalization").
 */
export function analyzeImports(
  plan: PlanLike,
  provided: Record<string, unknown> = {},
): ImportAnalysis {
  const leaves = requiredImports(plan);
  const requiresTestContext = leaves.some(
    (l) => l.interfaceId === TEST_CONTEXT_INTERFACE,
  );
  if (requiresTestContext && TEST_CONTEXT_INTERFACE in provided) {
    throw new NameCollisionError(
      `'${TEST_CONTEXT_INTERFACE}' was provided explicitly, but this suite ` +
        `imports test-context and the ct-runner always supplies it itself ` +
        `(contracts/embedder-api.md's "merges, erroring on collisions" ` +
        `policy). Remove it from your imports record — a pre-composed ` +
        `bundle that already links a provider should not import ` +
        `test-context in the first place.`,
    );
  }
  const resolver = new ImportResolver(provided);
  const groups = new Set(leaves.map((l) => l.interfaceId));
  const missing: string[] = [];
  for (const id of groups) {
    if (requiresTestContext && id === TEST_CONTEXT_INTERFACE) continue; // the runner supplies it
    if (resolver.resolve(id) === undefined) missing.push(id);
  }
  return { leaves, requiresTestContext, missing };
}

/** `analyzeImports`, throwing `MissingImportsError` if anything is missing. */
export function requireImportsResolved(
  plan: PlanLike,
  provided: Record<string, unknown> = {},
): ImportAnalysis {
  const analysis = analyzeImports(plan, provided);
  if (analysis.missing.length > 0) {
    const leaves = analysis.leaves.filter((l) =>
      analysis.missing.includes(l.interfaceId)
    );
    throw new MissingImportsError(analysis.missing, leaves);
  }
  return analysis;
}
