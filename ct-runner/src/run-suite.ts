// The L3 case-loop driver: instantiate the suite behind the embedder
// conventions, enumerate cases, execute them, emit canonical L4 results
// JSONL. Mirrors the semantics of polymorph-test's own JS legs
// (js/viewer/harness.mjs `runCases`/`runSuiteJsonl`) rather than reinventing
// a policy — an "introspecting host runner" per ARCHITECTURE.md Rule 3 must
// stay behaviorally equivalent to the layered path.
//
// L4 schema authority: polymorph-test crates/component-test-results/src/lib.rs
// (`Envelope`, `RunInfo`, `CaseResult`, `Status`, `Provenance`,
// `wire_vocabulary_pinned` test) — the canonical wire types; cross-checked
// against expected/verify-pipeline-fixture.jsonl and
// expected/verify-compose-sample.jsonl (golden samples of the same format).

import {
  type ComponentArtifacts,
  instantiate,
} from "@polyengine/runtime/embedder";
import { Trap, ComponentException } from "@polyengine/protocol";
import { Context, testContextImportRecord } from "./context.ts";
import { analyzeImports, requireImportsResolved } from "./import-analysis.ts";
import {
  applies,
  firstExcluding,
  loadTagsInventory,
  tagsOf,
} from "./tags.ts";

/**
 * The suite's `tests` interface id (wit/tests.wit `interface tests`, v0.1.0).
 *
 * @internal — used only inside this module's export lookup; no importer
 * (including this package's own tests) references it. The public entry
 * point is `runSuite()`.
 */
export const TESTS_INTERFACE = "polymorph:test/tests@0.1.0";

export interface RunSuiteOptions {
  /**
   * Host imports for everything the suite needs OTHER than test-context
   * (WASI, SUT interfaces, …) — the same shape `instantiate` itself takes
   * (contracts/embedder-api.md §"Module wiring and instantiation"). The
   * runner adds `test-context` itself and errors on a collision (dispatch's
   * import-wiring spec); omit it here.
   */
  imports?: Record<string, unknown>;
  /** Envelope `target` (opaque implementation x environment key). */
  target: string;
  /**
   * Envelope `suite.name`. Per js/viewer/harness.mjs's `envelope()`: "the
   * suite name is normalized to the lockfile identity — the wasm file stem,
   * underscores"; callers may pass the kebab-case name as-is, this function
   * does the same normalization (`replaceAll("-", "_")`).
   */
  suiteName: string;
  /** Substring filter: non-matching cases are skipped entirely (no emit),
   * per js/viewer/harness.mjs `runCases`'s `only` handling. */
  only?: string;
  /**
   * Feature-tag scheduling (issue #25): the features this target LACKS —
   * js/viewer/harness.mjs's `missing`. Tag-gating activates whenever the
   * suite carries a `component-test:tags@0.1` inventory (src/tags.ts):
   * non-applicable cases emit `not-applicable` rows instead of executing,
   * and an enumerated case no record covers throws (inventory drift — the
   * run is unsound, not failing). Passing `missing` for a suite WITHOUT an
   * inventory is an error (gating requested but impossible — upstream's
   * runner refuses the same way rather than silently degrading).
   */
  missing?: string[];
  /**
   * Per-case wall-clock budget in ms (the `--case-timeout` runner option
   * documented in harness.mjs's `runSuiteJsonl` doc comment). On expiry the
   * case fails with `{"limit-exceeded":"case-timeout"}` provenance and the
   * loop moves on; JSPI attempts cannot be cancelled, so this is only safe
   * paired with `freshCases` (the default) — see below.
   */
  caseTimeoutMs?: number;
  /**
   * Fresh suite instance per case (default true). harness.mjs's doc comment
   * on `runSuiteJsonl`'s `freshCases` parameter: "a fresh instance per case
   * ... contains trap poisoning" and is required to pair with
   * `caseTimeoutMs` (an abandoned JSPI attempt keeps running until its
   * instance is dropped). Setting this false reuses one instance for the
   * whole run — legal, but a trapped case can poison every later one, exactly
   * as harness.mjs warns.
   */
  freshCases?: boolean;
  /** Opt in to JSPI-backed suspension; passed through to `instantiate`. */
  jspi?: boolean;
  /**
   * Stripe this run to one shard of the suite (issue #110): case `i`
   * (i = the census index — `census.entries()`'s index over the FULL
   * enumerated case list, before `only`/tag filtering) belongs to shard
   * `i % count`; this shard executes and emits only its own cases, mirroring
   * `runCases`' established `i % count === index` striping semantics
   * (striping, not contiguous ranges, balances load since expensive cases
   * cluster by group). `only`/tag-gating are applied AFTER stripe
   * membership is decided (a case not in this stripe is neither executed
   * nor emitted, exactly as if it never existed for this shard) — this is
   * the interpretation that keeps the invariant "the union of every shard's
   * rows, in suite order, equals the unsharded run's rows" (pinned by
   * shard_test.ts's partition-identity test).
   *
   * Sharded envelope/terminator contract: a sharded call still emits its
   * own envelope line and its own `{"segment-end":true}` terminator —
   * `runSuite` does not know about sibling shards and cannot merge. The
   * documented consumer topology (issue #110's stated shape) is: a
   * caller-side worker pool runs one `runSuite` call per shard, and the
   * PARENT — not this function — discards all but one envelope, merges the
   * per-case rows back into suite order using the `index` argument now
   * passed to `emit`, and writes the single terminator. The returned
   * `RunCounts` are likewise per-shard (they count only this stripe's
   * cases); the parent sums them. `shard` absent
   * (the default) is byte-identical to today: no `index` shard-partitioning
   * occurs and single-argument `emit` callers are unaffected.
   */
  shard?: { index: number; count: number };
  /** Receives each output line (envelope, one per case, terminator),
   * WITHOUT a trailing newline — callers decide the line separator.
   * `caseIndex` (issue #110) is the case's suite-order index (the same `i`
   * used for stripe membership) for per-case rows; `undefined` for the
   * envelope and terminator lines. A sharded consumer uses it to restore
   * suite order when merging stripes back together. Optional second
   * argument: existing single-argument `emit` callers are unaffected. */
  emit: (line: string, caseIndex?: number) => void;
  /** Optional progress log, one call per case (mirrors harness.mjs's
   * `log?.(...)` callback). */
  log?: (msg: string) => void;
}

export interface RunCounts {
  passed: number;
  failed: number;
  skipped: number;
  /** Cases scheduled out as `not-applicable` (tag gating; harness.mjs `na`). */
  na: number;
  total: number;
}

/** `js/viewer/harness.mjs`'s `resolveTestsExport`, ported: the suite's
 * `tests` interface from an instantiated component, whichever spelling the
 * producer used (verbatim interface id is what this runtime always uses,
 * but the fallback costs nothing and documents the contract). */
// deno-lint-ignore no-explicit-any
function resolveTestsExport(exports: Record<string, any>): any {
  const tests = exports[TESTS_INTERFACE] ?? exports["tests"];
  if (tests === undefined) {
    throw new Error(
      `suite instance exports no '${TESTS_INTERFACE}' interface: ` +
        `${Object.keys(exports)}`,
    );
  }
  return tests;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function describeThrow(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Run one suite end to end: instantiate, enumerate, execute every case,
 * emit the complete results-JSONL stream (envelope, one line per case,
 * terminator) through `opts.emit`. Throws `MissingImportsError` up front
 * (contracts/embedder-api.md's `requiredImports`) if the caller's imports
 * cannot satisfy the suite, and a plain `Error` if the census is empty (an
 * empty selection is a run error, per component-test-results/src/lib.rs's
 * `fold_jsonl` and harness.mjs's `runSuiteJsonl` — both refuse it).
 */
export async function runSuite(
  artifacts: ComponentArtifacts,
  opts: RunSuiteOptions,
): Promise<RunCounts> {
  const provided = opts.imports ?? {};
  // Fail fast, translate-only, before any instantiate (gate 3's contract):
  // detect whether test-context is imported at all — a pre-composed bundle
  // with the provider already linked in must work with no test-context
  // wiring — and merge, erroring on any caller/runner collision.
  const analysis = requireImportsResolved(artifacts.plan, provided);
  const mergedImports = analysis.requiresTestContext
    ? { ...provided, ...testContextImportRecord() }
    : provided;

  const freshCases = opts.freshCases ?? true;

  // Validate `shard` loudly (issue #110): integers, count >= 1, index in
  // [0, count). Fail fast, before any instantiate, same posture as the
  // imports/tags validation above.
  if (opts.shard !== undefined) {
    const { index, count } = opts.shard;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        `shard.count must be an integer >= 1, got ${count}`,
      );
    }
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new Error(
        `shard.index must be an integer in [0, ${count}), got ${index}`,
      );
    }
  }

  const newTests = async () => {
    const inst = await instantiate(artifacts, mergedImports, {
      jspi: opts.jspi,
    });
    return resolveTestsExport(inst.exports);
  };

  const censusTests = await newTests();
  const census = await censusTests.all();

  // Feature-tag scheduling (issue #25): gate on the suite's own
  // `component-test:tags@0.1` inventory when it has one — the SDK embeds it
  // in the guest core module and it survives wac composition, so this
  // introspecting runner CAN see it (revising the earlier "cannot see the
  // tags section" stance recorded below). Suites without an inventory run
  // feature-blind exactly as before.
  const inventory = loadTagsInventory(artifacts.componentBytes);
  const missing = opts.missing ?? [];
  if (inventory === null && opts.missing !== undefined) {
    throw new Error(
      "missing-features given, but the suite carries no " +
        "component-test:tags@0.1 inventory (not built with their SDK, or " +
        "sections stripped) — tag gating is impossible, refusing to " +
        "silently run feature-blind",
    );
  }

  const suiteName = opts.suiteName.replaceAll("-", "_");
  const artifactSha256 = await sha256Hex(artifacts.componentBytes);
  opts.emit(JSON.stringify({
    "component-test-results": "0.1",
    target: opts.target,
    suite: { name: suiteName, "artifact-sha256": artifactSha256 },
    // "tags" when this run schedules against the suite's tag inventory,
    // "none" for inventory-less suites (component-test-results/src/lib.rs
    // `RunInfo`: "none" is for producers that cannot see the tags section
    // — with the inventory in hand, this runner no longer is one).
    run: { segment: 0, scheduling: inventory !== null ? "tags" : "none" },
  }));

  if (census.length === 0) {
    // Both authorities refuse this: component-test-results/src/lib.rs
    // `fold_jsonl` ("empty selection is a run error") and harness.mjs
    // `runSuiteJsonl` ("suite enumerated zero cases").
    throw new Error(
      "suite enumerated zero cases (empty selection is a run error)",
    );
  }

  const counts: RunCounts = { passed: 0, failed: 0, skipped: 0, na: 0, total: 0 };

  for (const [i, testCase] of census.entries()) {
    // Stripe membership (issue #110) is decided on the census index `i`,
    // BEFORE `only`/tag filtering — a case outside this shard's stripe is
    // skipped with no emit and no count contribution, as if this shard's
    // census never enumerated it at all.
    if (opts.shard && i % opts.shard.count !== opts.shard.index) continue;

    const name = String(await testCase.name());
    counts.total++;
    // js/viewer/harness.mjs `runCases`: "if (only && !name.includes(only))
    // continue" — a filtered-out case is skipped entirely, no emit.
    if (opts.only && !name.includes(opts.only)) continue;

    // harness.mjs `runCases` mark scheduling, in its exact order: `only`
    // first (above), then drift, then applicability. The N/A row's shape is
    // the embed runner's (expected/verify-pipeline-fixture.jsonl):
    // status, first excluding mark as detail, diagnostics-complete true.
    if (inventory !== null) {
      const tags = tagsOf(inventory, name);
      if (tags === undefined) {
        throw new Error(`inventory drift: no tags record covers ${name}`);
      }
      if (!applies(tags, missing)) {
        counts.na++;
        opts.emit(JSON.stringify({
          case: name,
          status: "not-applicable",
          detail: firstExcluding(tags, missing),
          "diagnostics-complete": true,
        }), i);
        opts.log?.(`${name} … not-applicable`);
        continue;
      }
    }

    // js/viewer/harness.mjs `runCases`' `freshCases` branch: re-enumerate
    // from a fresh instance and run the matching case; a vanished case is
    // inventory drift, not a failing case, and throws.
    let executed = testCase;
    if (freshCases) {
      const freshTests = await newTests();
      const freshList = await freshTests.all();
      const match = await findByName(freshList, name, i);
      if (match === undefined) {
        throw new Error(`case '${name}' vanished on re-enumeration`);
      }
      executed = match;
    }

    const diags: string[] = [];
    // The host-side `test-context` sideband: `diagnostic` calls are consumed
    // concurrently with `run` per wit/tests.wit's doc comment — here that is
    // automatic (same event loop turn, synchronous push into `diags`).
    const ctx = new Context((msg: string) => diags.push(msg));

    const start = performance.now();
    // deno-lint-ignore no-explicit-any
    let event: Record<string, any>;
    try {
      const attempt = executed.run(ctx);
      let timedOut = false;
      if (opts.caseTimeoutMs) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        timedOut = await Promise.race([
          attempt.then(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), opts.caseTimeoutMs);
          }),
        ]).finally(() => clearTimeout(timer));
      } else {
        await attempt;
      }
      const durationMs = Math.round(performance.now() - start);
      if (timedOut) {
        counts.failed++;
        event = {
          case: name,
          status: "fail",
          provenance: { "limit-exceeded": "case-timeout" },
          detail: `case timeout exceeded (${(opts.caseTimeoutMs! / 1000)}s)`,
          "duration-ms": durationMs,
          "diagnostics-complete": false,
        };
      } else {
        counts.passed++;
        event = {
          case: name,
          status: "pass",
          provenance: "returned",
          "duration-ms": durationMs,
          // The case returned normally, so its diagnostics sideband is
          // complete (upstream emits this on every returned row; polyengine's
          // trap/timeout rows already carry `false`).
          "diagnostics-complete": true,
        };
      }
    } catch (e) {
      const durationMs = Math.round(performance.now() - start);
      if (e instanceof ComponentException) {
        const payload = e.payload as
          | { kind: "failed"; value: string }
          | { kind: "skipped"; value: string }
          | undefined;
        if (payload?.kind === "failed") {
          counts.failed++;
          event = {
            case: name,
            status: "fail",
            provenance: "returned",
            detail: payload.value,
            "duration-ms": durationMs,
            "diagnostics-complete": true,
          };
        } else if (payload?.kind === "skipped") {
          counts.skipped++;
          event = {
            case: name,
            status: "skipped",
            provenance: "returned",
            detail: payload.value,
            "duration-ms": durationMs,
            "diagnostics-complete": true,
          };
        } else {
          // Contract violation: `outcome` has exactly two cases. Treat as
          // this case's failure, same as a trap (the run() promise made a
          // verdict-shaped claim the runner cannot parse).
          counts.failed++;
          event = {
            case: name,
            status: "fail",
            provenance: "trap",
            detail: `run() rejected with an unrecognized outcome payload: ` +
              `${JSON.stringify(payload)}`,
            "duration-ms": durationMs,
            "diagnostics-complete": false,
          };
        }
      } else {
        // Trap (real wasm trap, or any unbranded throw): "a runner treats a
        // trap as this case's failure and the suite instance as poisoned"
        // (wit/tests.wit `test-case.run` doc comment) — poisoning is moot
        // under `freshCases` (the default), since the NEXT case gets a fresh
        // instance regardless.
        counts.failed++;
        const isTrap = e instanceof Trap;
        event = {
          case: name,
          status: "fail",
          provenance: "trap",
          detail: `trap: ${isTrap ? e.message : describeThrow(e)}`,
          "duration-ms": durationMs,
          "diagnostics-complete": false,
        };
      }
    }
    if (diags.length > 0) event.diagnostics = diags;
    opts.emit(JSON.stringify(event), i);
    opts.log?.(`${name} … ${event.status}`);
  }

  opts.emit('{"segment-end":true}');
  return counts;
}

// deno-lint-ignore no-explicit-any
async function findByName(list: any[], name: string, hint?: number): Promise<any> {
  // Same-index fast path. Enumeration order is a hint, not a contract: real
  // suites enumerate deterministically, so the re-enumerated case is
  // virtually always at its census index — one name() round-trip instead of
  // a front-to-back scan. The scan (harness.mjs's freshCases branch, which
  // the fallback below mirrors verbatim) is quadratic in suite size, and
  // each name() here is an interpreted CABI call (~8 us): a 19k-case suite
  // pays ~182M of them, dominating the run's wall clock. An order-unstable
  // suite just misses the hint and falls back; drift detection is unchanged
  // (`undefined` still means the case vanished).
  if (hint !== undefined && hint < list.length) {
    const candidate = list[hint];
    if (String(await candidate.name()) === name) return candidate;
  }
  for (const c of list) {
    if (String(await c.name()) === name) return c;
  }
  return undefined;
}

export { analyzeImports, MissingImportsError, requireImportsResolved } from "./import-analysis.ts";
