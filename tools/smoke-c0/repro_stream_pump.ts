// Finding R-1 (host-pump starvation of pendingHostCalls) — minimal repro: a
// host-side read of a guest stream hangs
// when the guest's writer task is parked on a Promise-returning host import
// and no export call is in flight.
//
//   deno run --allow-read repro_stream_pump.ts
//
// Shape (polymorph-iroh exec-model `open-stream`): the guest returns a
// `stream<u8>` immediately and fills it from a DETACHED task that awaits
// `wasi:clocks/monotonic-clock@0.3.0 wait-for` between chunks. The host then
// reads the stream between export calls.
//
// Observed: the first chunk arrives (it was already buffered when the export
// returned); the second read never resolves.
//
// Mechanism (runtime/src/exec/boundary.ts:1393-1416): a Promise-returning
// lowered import registers its promise in `store.pendingHostCalls` and, on
// settle, calls `onResolve` — which readies the guest thread but does NOT
// tick the store. Only `driveAsync` (runtime/src/exec/boundary.ts:614+)
// races `pendingHostCalls` and re-pumps, and `driveAsync` exists only for the
// duration of an export call. `HostBuffer.pump()`
// (runtime/src/exec/host_streams.ts:161-175) is the between-export-calls
// driver, but it only drains `store.awaiting` (the JSPI park set); it has no
// arm for `pendingHostCalls`.
//
// Control below: with ANY export call concurrently in flight, the same reads
// complete — which is the diagnosis, executable.
//
// Triage: RUNTIME BUG (not toolchain drift, not a missing shim).

import {
  ARTIFACTS,
  loadTranslator,
  ms,
  readArtifact,
  translateOnce,
} from "./common.ts";
import { buildImports } from "./wasi_stub.ts";
import {
  hostStreamFor,
  instantiateComponent,
} from "../../runtime/src/exec/mod.ts";
import type { ComponentValue } from "../../runtime/src/cabi/types.ts";

const bytes = await readArtifact(ARTIFACTS.execModel);
const t = await loadTranslator();
const { plan, adapters } = translateOnce(t, bytes) as {
  plan: NonNullable<ReturnType<typeof translateOnce>["plan"]>;
  adapters: Map<string, Uint8Array>;
};

const overrides: Record<string, unknown> = {
  "wasi:clocks/monotonic-clock/wait-for": (ns: unknown) =>
    new Promise<null>((res) =>
      setTimeout(() => res(null), Math.max(0, Math.ceil(Number(ns as bigint) / 1e6)))
    ),
};

async function newInstance() {
  const { imports } = buildImports(plan, { overrides });
  const c = await instantiateComponent({
    plan,
    componentBytes: bytes,
    adapters,
    imports,
  });
  return c.exports[plan.exports[0].name] as Record<string, unknown>;
}

type AnyFn = (...a: unknown[]) => unknown;
const TIMEOUT_MS = 4000;
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rj) =>
      setTimeout(() => rj(new Error(`TIMEOUT ${TIMEOUT_MS}ms: ${label}`)), TIMEOUT_MS)
    ),
  ]);
}

console.log("=== repro R-1: host stream read vs. detached writer on an async import ===\n");

// --- A. the bug -------------------------------------------------------------
console.log("A. read the guest stream with NO export call in flight");
{
  const probe = await newInstance();
  const returned = await (probe["open-stream"] as AnyFn)(5000, 1000);
  const s = hostStreamFor<number>(returned as ComponentValue);
  let count = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const vs = await withTimeout(s.readable.read(4096), `read#${i}`);
      console.log(`   read#${i} -> ${vs.length} bytes in ${ms(performance.now() - t0)}`);
      if (vs.length === 0) break;
      count += vs.length;
    }
    console.log(`   RESULT: read ${count}/5000 bytes — no hang (bug not reproduced)`);
  } catch (e) {
    console.log(`   RESULT: HUNG after ${count}/5000 bytes — ${(e as Error).message}`);
    console.log(`   ^ finding R-1 reproduced`);
  }
}

// --- B. the control ---------------------------------------------------------
console.log(
  "\nB. same reads, but with `stream-outcome()` concurrently in flight\n" +
    "   (it loops on wait-for, so a driveAsync loop exists the whole time)",
);
{
  const probe = await newInstance();
  const returned = await (probe["open-stream"] as AnyFn)(5000, 1000);
  const s = hostStreamFor<number>(returned as ComponentValue);
  // Keep an export call alive; its driveAsync is the pump the host read lacks.
  // Attach the rejection handler IMMEDIATELY: this call can reject before we
  // await it (finding R-2), and an unhandled rejection aborts the process.
  let keepAliveOutcome = "still pending";
  const keepAlive = ((probe["stream-outcome"] as AnyFn)() as Promise<unknown>)
    .then(
      (v) => (keepAliveOutcome = `resolved ${JSON.stringify(v)}`),
      (e) => (keepAliveOutcome = `REJECTED ${(e as Error).message}`),
    );
  let count = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const vs = await withTimeout(s.readable.read(4096), `read#${i}`);
      console.log(`   read#${i} -> ${vs.length} bytes in ${ms(performance.now() - t0)}`);
      if (vs.length === 0) break;
      count += vs.length;
    }
    console.log(`   RESULT: read ${count}/5000 bytes with a driver in flight`);
  } catch (e) {
    console.log(`   RESULT: HUNG after ${count}/5000 bytes — ${(e as Error).message}`);
  }
  try {
    await withTimeout(keepAlive, "stream-outcome");
  } catch (e) {
    keepAliveOutcome = (e as Error).message;
  }
  console.log(`   stream-outcome: ${keepAliveOutcome}`);
}

// --- C. the discriminator ---------------------------------------------------
console.log(
  "\nC. same reads, but `wait-for` returns SYNCHRONOUSLY (no Promise)\n" +
    "   — the guest writer then never parks on a host-import promise.",
);
{
  const { imports } = buildImports(plan, {
    overrides: { "wasi:clocks/monotonic-clock/wait-for": () => null },
  });
  const c = await instantiateComponent({
    plan,
    componentBytes: bytes,
    adapters,
    imports,
  });
  const probe = c.exports[plan.exports[0].name] as Record<string, unknown>;
  const returned = await (probe["open-stream"] as AnyFn)(5000, 1000);
  const s = hostStreamFor<number>(returned as ComponentValue);
  let count = 0;
  try {
    for (let i = 0; i < 10; i++) {
      const vs = await withTimeout(s.readable.read(4096), `read#${i}`);
      console.log(`   read#${i} -> ${vs.length} bytes`);
      if (vs.length === 0) break;
      count += vs.length;
    }
    console.log(
      `   RESULT: read ${count}/5000 bytes — ${
        count === 5000
          ? "COMPLETE. The async host-import park is the trigger for R-1."
          : "still short."
      }`,
    );
  } catch (e) {
    console.log(`   RESULT: HUNG after ${count}/5000 — ${(e as Error).message}`);
  }
}

console.log(
  "\nNOTE finding R-2: in run B the concurrent export call rejects with\n" +
    "  TypeError: Cannot read properties of undefined (reading 'awaiting')\n" +
    "  at HostActivity.#drainAsync (runtime/src/exec/host_streams.ts:198).\n" +
    "  `#drainAsync` checks `store.awaiting.size > 0`, then AWAITS\n" +
    "  (line 184 `await Promise.resolve()`), then takes `[...store.awaiting][0]`\n" +
    "  — but the set can be emptied while it is suspended, so the index is\n" +
    "  `undefined` and `t.awaiting` throws. Triage: RUNTIME BUG (a check-then-\n" +
    "  act race across an await, not a semantics question).",
);

console.log("\nrepro done");
Deno.exit(0);
