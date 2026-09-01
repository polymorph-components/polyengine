// Fail-on-pre-fix pins for the three runtime defects found by the #18
// polymorph-tls conformance smoke (tools/smoke-tls/) — the first corpus
// with resource-bearing stream/future payloads and borrow-carrying calls
// through FACT prepare/start adapters.
//
//   Pin 1 — structural ValType equality must not JSON.stringify types that
//           contain `own`/`borrow` (ResourceTypeInfo cycles back to live
//           instance state). Sibling of the `task.return` structural-equality fix; hit
//           again via `sameElemType` and lowerStream/lowerFuture's EAGERLY
//           evaluated diagnostic strings.
//   Pin 2 — one `ResourceTypeInfo` per component-wide ResourceIndex, aliased
//           across resource tables (plan-format.md "Type exports index into
//           `resourceTables`" note). Per-
//           table tokens made FACT stream/future transfers trap "destination
//           element mismatch" in wac-composed components.
//   Pin 3 — `resource.transfer-borrow` inside a FACT `[async-start]` window
//           (prepare/start protocol, no enter/exit-sync-call bracket):
//           borrow bookkeeping attaches to the callee task + caller lender
//           scope (definitions.py lift_borrow:1517 / lower_borrow:1821).

import {
  fmtValType,
  ResourceTypeInfo,
  Table,
  valTypeEqual,
  type ValType,
} from "../src/cabi/mod.ts";
import { sameElemType } from "../src/task/streams.ts";
import { loadPlan } from "../src/plan/mod.ts";
import {
  createTrampoline,
  type FactStartScope,
  SyncCallScope,
  type TrampolineContext,
} from "../src/intrinsics/mod.ts";
import { ResourceHandle } from "../src/cabi/handles.ts";
import { SUPPORTED_FORMAT_VERSION } from "../src/plan/loader.ts";
import type { WirePlan } from "../src/plan/format.ts";
import { assertEq } from "./support/asserts.ts";

function minimalPlan(overrides: Partial<WirePlan> = {}): WirePlan {
  return {
    formatVersion: SUPPORTED_FORMAT_VERSION,
    producer: { shimVersion: "0", wasmtimeEnviron: "47.0.3", features: [] },
    component: { sha256: "0".repeat(64), len: 0 },
    modules: [],
    initializers: [],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    streamTables: [],
    futureTables: [],
    errorContextTables: [],
    imports: [],
    exports: [],
    worldDigest: "sha256:0",
    ...overrides,
  };
}

// --- Pin 1 ------------------------------------------------------------------

/** A resource type whose identity token cycles back to a table that holds a
 * value referencing the type — the real shape: `rt.impl.handles` holds ends
 * whose `.shared.t` contains the own type. `JSON.stringify` throws on it. */
function cyclicResourceType(): { rt: ResourceTypeInfo; t: ValType } {
  const handles = new Table<unknown>();
  const impl = { handles, mayLeave: true };
  const rt = new ResourceTypeInfo(impl, null);
  const t: ValType = {
    kind: "future",
    element: { kind: "result", ok: null, error: { kind: "own", rt } },
  };
  handles.add({ shared: { t } }); // closes the cycle
  return { rt, t };
}

Deno.test("pin: sameElemType survives resource-bearing (cyclic) element types", () => {
  const { rt, t } = cyclicResourceType();
  // Sanity: the pre-fix implementation (JSON.stringify comparison) throws here.
  let threw = false;
  try {
    JSON.stringify(t);
  } catch {
    threw = true;
  }
  assertEq(threw, true, "fixture must actually be cyclic");

  const same: ValType = {
    kind: "future",
    element: { kind: "result", ok: null, error: { kind: "own", rt } },
  };
  assertEq(sameElemType(t, same), true, "same rt -> equal");
  assertEq(valTypeEqual(t, same), true);

  const otherRt = new ResourceTypeInfo(null, null);
  const different: ValType = {
    kind: "future",
    element: { kind: "result", ok: null, error: { kind: "own", rt: otherRt } },
  };
  assertEq(sameElemType(t, different), false, "distinct rt -> unequal, no throw");
});

Deno.test("pin: fmtValType is cycle-safe and structural", () => {
  const { t } = cyclicResourceType();
  assertEq(fmtValType(t), "future<result<_, own<resource>>>");
  assertEq(fmtValType(null), "_");
});

// --- Pin 2 ------------------------------------------------------------------

Deno.test("pin: tables naming one ResourceIndex share one identity token", () => {
  const loaded = loadPlan(minimalPlan({
    resourceTables: [
      { kind: "concrete", resource: 0, instance: 0 },
      { kind: "concrete", resource: 0, instance: 1 }, // alias (composed peer)
      { kind: "concrete", resource: 1, instance: 0 },
    ],
  }));
  assertEq(
    loaded.resourceTokens[0] === loaded.resourceTokens[1],
    true,
    "same ResourceIndex through two tables -> one token",
  );
  assertEq(
    loaded.resourceTokens[0] === loaded.resourceTokens[2],
    false,
    "distinct resources stay distinct",
  );
});

// --- Pin 3 ------------------------------------------------------------------

Deno.test("pin: transfer-borrow works inside a FACT [async-start] window", () => {
  const srcInst = { handles: new Table<unknown>(), mayLeave: true };
  const dstInst = { handles: new Table<unknown>(), mayLeave: true };
  const srcRt = new ResourceTypeInfo(null, null);
  const dstRt = new ResourceTypeInfo(null, null); // dst does NOT implement it

  const factStartScopes: FactStartScope[] = [];
  const ctx = {
    resourceTableInstance: (i: number) => (i === 0 ? srcInst : dstInst),
    resourceToken: (i: number) => (i === 0 ? srcRt : dstRt),
    syncCallStack: [] as SyncCallScope[],
    factStartScopes,
    trapState: { pending: null },
  } as unknown as TrampolineContext;

  const transfer = createTrampoline(
    { kind: "resource-transfer-borrow" } as never,
    ctx,
  );

  const handle = srcInst.handles.add(new ResourceHandle(srcRt, 17, true));

  // Outside any scope: the pre-fix assertion (and still an error today).
  let refused = false;
  try {
    transfer(handle, 0, 1);
  } catch {
    refused = true;
  }
  assertEq(refused, true, "no bracket, no FACT window -> refused");

  // Inside a FACT start window: lender + callee-task bookkeeping, per the
  // reference. Pre-fix this threw "transfer-borrow outside an
  // enter-sync-call/exit-sync-call bracket".
  const taskScope = { numBorrows: 0 };
  const lenders = new SyncCallScope();
  factStartScopes.push({ taskScope, lenders });
  const out = transfer(handle, 0, 1) as number;
  factStartScopes.pop();

  const src = srcInst.handles.get(handle) as ResourceHandle;
  assertEq(src.numLends, 1, "source handle became a lender");
  assertEq(taskScope.numBorrows, 1, "callee task owes one borrow");
  const dst = dstInst.handles.get(out) as ResourceHandle;
  assertEq(dst.own, false);
  assertEq(dst.rep, 17);
  assertEq(dst.borrowScope === taskScope, true, "drop decrements the callee task");

  lenders.releaseLenders();
  assertEq(src.numLends, 0, "deliver-resolve releases the lender");
});
