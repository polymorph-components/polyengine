// Leg 2 — polymorph-iroh's exec-model probe: the lann/jco#11 kill shot.
//
//   deno run --allow-read leg2_exec_model.ts
//
// Artifact: polymorph-iroh/target/wasm32-wasip2/release/iroh_exec_model_guest.wasm
// Guest source: polymorph-iroh/experiments/exec-model/guest/src/lib.rs
// jco reference driver: polymorph-iroh/host-jco/src/run-exec.mjs
//
// The probe order below is the diagnostic: jco's execution-slot queue
// serializes task lifetimes, so `start-pump()` leaves a detached task holding
// an in-flight `wait-for` and every LATER export call deadlocks before its
// first wasm slice. We drive exactly that order and assert each step.
//
// Host glue implemented here (throwaway; the real thing is the shim):
//   - wasi:clocks/monotonic-clock@0.3.0 `wait-for` — an async host function
//     (Promise + setTimeout). No JSPI: the runtime's Promise-returning-import
//     path parks the callback-ABI task.
//   - polymorph:webcrypto x25519 `generate-key` + key-agreement resources —
//     backed by Deno's own WebCrypto X25519, so the probe's `block_on` bridge
//     exercises a genuinely async host import.
//   - wasi:cli stdio + wasi:io streams/poll — real enough to surface a guest
//     panic instead of swallowing it.
// Everything else in `plan.imports` is a loud stub (wasi_stub.ts).

import {
  ARTIFACTS,
  fmtSurface,
  loadTranslator,
  ms,
  planShape,
  readArtifact,
  sha256Hex,
  translateOnce,
} from "./common.ts";
import { buildImports } from "./wasi_stub.ts";
import {
  hostStream,
  hostStreamFor,
  instantiateComponent,
} from "../../runtime/src/exec/mod.ts";
import type { ComponentValue } from "../../runtime/src/cabi/types.ts";

const failures: string[] = [];
function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
}
// Retightened after the R-fix round: probes 4a/4b originally carried
// `xfail(...)` wrappers against findings R-1 (host-pump starvation of
// pendingHostCalls) / R-2 (check-then-act poisoning via hostFailure); both are
// fixed (runtime/tests/host_pump_test.ts pins them), so every probe is now a
// hard assertion and a regression fails this leg.
function note(msg: string) {
  console.log(`  ....  ${msg}`);
}
/** Bound every guest-driven await: a hang must become a recorded verdict. */
const STEP_TIMEOUT_MS = 5000;
function withTimeout<T>(p: Promise<T> | T, label: string): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, rj) =>
      setTimeout(
        () => rj(new Error(`TIMEOUT after ${STEP_TIMEOUT_MS} ms: ${label}`)),
        STEP_TIMEOUT_MS,
      )
    ),
  ]);
}
/** Classify a thrown value against the runtime's incompleteness signals. */
function classify(e: unknown): string {
  const name = (e as Error)?.name ?? typeof e;
  return `${name}: ${(e as Error)?.message ?? String(e)}`;
}

console.log("=== Leg 2: iroh exec-model probe ===\n");

const bytes = await readArtifact(ARTIFACTS.execModel);
console.log(`artifact: ${ARTIFACTS.execModel}`);
console.log(`  bytes:  ${bytes.length}`);
console.log(`  sha256: ${await sha256Hex(bytes)}`);

const t = await loadTranslator();
const att = translateOnce(t, bytes);
check(att.ok, `translate accepted (phase=${att.errorPhase ?? "-"})`);
if (!att.ok) {
  console.log(`  message: ${att.errorMessage}\n  detail: ${att.errorDetail}`);
  Deno.exit(1);
}
const plan = att.plan!;
console.log(`\nplan: ${planShape(plan)}`);
console.log(
  `\nGROUND TRUTH on the import surface (the WIT world declares only\n` +
    `wasi:clocks/monotonic-clock@0.3.0; the binary carries far more):`,
);
console.log(fmtSurface(plan));

// ---------------------------------------------------------------------------
// p2 stdio / poll: real enough to be diagnostic.
// ---------------------------------------------------------------------------
const stdioLog: string[] = [];
let nextRep = 1;
const streamKind = new Map<number, string>();
const STDOUT = nextRep++;
streamKind.set(STDOUT, "stdout");
const STDERR = nextRep++;
streamKind.set(STDERR, "stderr");

function decodeBytes(v: unknown): string {
  const arr = v instanceof Uint8Array ? v : new Uint8Array(v as number[]);
  return new TextDecoder().decode(arr);
}

// ---------------------------------------------------------------------------
// polymorph:webcrypto — Deno WebCrypto behind the guest's `block_on` bridge.
// The host boundary is raw reps (e2e_imports_test.ts): own/borrow arrive and
// leave as integers, and the host keeps its own side table.
// ---------------------------------------------------------------------------
interface OptsState {
  deriveBits: boolean;
  deriveKey: boolean;
  extractable: boolean;
}
const optsTable = new Map<number, OptsState>();
const pubTable = new Map<number, CryptoKey>();
const secTable = new Map<number, CryptoKey>();

const trace: string[] = [];
const dropped: string[] = [];

const overrides: Record<string, unknown> = {
  // --- p3 clock: the one import the WIT world actually declares. -----------
  // `wait-for: async func(how-long: duration)`; duration is u64 nanoseconds.
  // Returning a Promise is the whole integration — no JSPI involved.
  "wasi:clocks/monotonic-clock/wait-for": (ns: unknown) => {
    const millis = Number(ns as bigint) / 1e6;
    return new Promise<null>((res) =>
      setTimeout(() => res(null), Math.max(0, Math.ceil(millis)))
    );
  },
  // `now: func() -> instant` (nanoseconds since an arbitrary epoch).
  "wasi:clocks/monotonic-clock/now": () =>
    BigInt(Math.round(performance.now() * 1e6)),

  // --- p2 stdio ------------------------------------------------------------
  "wasi:cli/stdout/get-stdout": () => STDOUT,
  "wasi:cli/stderr/get-stderr": () => STDERR,
  "wasi:io/streams/[method]output-stream.check-write": () => ({
    kind: "ok",
    value: 65536n,
  }),
  "wasi:io/streams/[method]output-stream.write": (
    rep: unknown,
    contents: unknown,
  ) => {
    const text = decodeBytes(contents);
    stdioLog.push(`[${streamKind.get(rep as number) ?? rep}] ${text}`);
    return { kind: "ok", value: null };
  },
  "wasi:io/streams/[method]output-stream.blocking-write-and-flush": (
    rep: unknown,
    contents: unknown,
  ) => {
    stdioLog.push(`[${streamKind.get(rep as number) ?? rep}] ${
      decodeBytes(contents)
    }`);
    return { kind: "ok", value: null };
  },
  "wasi:io/streams/[method]output-stream.blocking-flush": () => ({
    kind: "ok",
    value: null,
  }),

  // --- polymorph:webcrypto/key-agreement -----------------------------------
  "polymorph:webcrypto/key-agreement/[constructor]agreement-key-options":
    () => {
      const rep = nextRep++;
      optsTable.set(rep, {
        deriveBits: false,
        deriveKey: false,
        extractable: false,
      });
      return rep;
    },
  "polymorph:webcrypto/key-agreement/[method]agreement-key-options.can-derive-bits":
    (rep: unknown, allowed: unknown) => {
      optsTable.get(rep as number)!.deriveBits = allowed as boolean;
    },
  "polymorph:webcrypto/key-agreement/[method]agreement-key-options.can-derive-key":
    (rep: unknown, allowed: unknown) => {
      optsTable.get(rep as number)!.deriveKey = allowed as boolean;
    },
  "polymorph:webcrypto/key-agreement/[method]agreement-key-options.extractable":
    (rep: unknown, allowed: unknown) => {
      optsTable.get(rep as number)!.extractable = allowed as boolean;
    },
  // `export-key-raw: async func() -> result<list<u8>, error>` — the raw
  // 32-byte RFC 7748 u-coordinate (wit/agreement.wit, `public-key`).
  "polymorph:webcrypto/key-agreement/[method]public-key.export-key-raw":
    async (rep: unknown) => {
      const key = pubTable.get(rep as number)!;
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      return { kind: "ok", value: raw };
    },

  // --- polymorph:webcrypto/x25519 ------------------------------------------
  // `generate-key: async func(options) -> result<tuple<secret-key, public-key>, error>`
  "polymorph:webcrypto/x25519/generate-key": async (optsRep: unknown) => {
    optsTable.delete(optsRep as number); // `options` is `own`, consumed here
    const pair = await crypto.subtle.generateKey(
      { name: "X25519" },
      true,
      ["deriveBits"],
    ) as CryptoKeyPair;
    const sec = nextRep++;
    const pub = nextRep++;
    secTable.set(sec, pair.privateKey);
    pubTable.set(pub, pair.publicKey);
    return { kind: "ok", value: [sec, pub] };
  },
};

const { imports, stubbed } = buildImports(plan, { overrides, trace, dropped });
console.log(
  `\nhost glue: ${
    Object.keys(overrides).length
  } leaves implemented, ${stubbed.length} stubbed`,
);
console.log(`  stubbed: ${stubbed.join(", ")}`);

const c = await instantiateComponent({
  plan,
  componentBytes: bytes,
  adapters: att.adapters!,
  imports,
});
check(true, "instantiate succeeded");

const probeName = plan.exports[0].name;
const probe = c.exports[probeName] as Record<string, unknown>;
console.log(`\nexport instance: ${probeName}`);
console.log(`  functions: ${Object.keys(probe).join(", ")}`);

type AnyFn = (...a: unknown[]) => unknown;
const fn = (n: string) => probe[n] as AnyFn;

function unwrapOk(v: unknown, where: string): unknown {
  // Raw boundary: `result` is `{kind: "ok" | "error", value}` — the internal
  // spelling is "error", not the host layer's "err"
  // (contracts/descriptor-ir.md §"Host value shapes").
  const r = v as { kind?: unknown; value?: unknown };
  if (r && typeof r === "object" && r.kind === "error") {
    failures.push(`${where} returned err: ${JSON.stringify(r.value)}`);
    console.log(`  FAIL  ${where} -> err ${JSON.stringify(r.value)}`);
    return undefined;
  }
  return r?.value;
}

// ---------------------------------------------------------------------------
// Probe 1 — block_on inside a spawned task, export still live.
// ---------------------------------------------------------------------------
console.log(`\n--- probe 1: blockon-in-spawn()`);
try {
  const t0 = performance.now();
  const v = await fn("blockon-in-spawn")();
  const desc = unwrapOk(v, "blockon-in-spawn");
  check(typeof desc === "string", `ok(string) in ${ms(performance.now() - t0)}`);
  note(`guest says: ${desc}`);
} catch (e) {
  check(false, `blockon-in-spawn threw — ${classify(e)}`);
}

// ---------------------------------------------------------------------------
// Probes 2+3 — the jco#11 shape. `start-pump` MUST return while the detached
// pump task still holds an in-flight `wait-for(50ms)`, and `poll-pump` MUST
// then execute (under jco it never runs its first wasm slice).
// ---------------------------------------------------------------------------
console.log(`\n--- probe 2: start-pump()  [detached pump left in flight]`);
let pumpStarted = false;
try {
  const t0 = performance.now();
  const v = await fn("start-pump")();
  const elapsed = performance.now() - t0;
  unwrapOk(v, "start-pump");
  pumpStarted = true;
  check(true, `start-pump returned in ${ms(elapsed)}`);
  // The pump's first act is `wait-for(50ms)`. Returning materially faster
  // than that is the proof the detached task is still parked, not joined.
  check(
    elapsed < 50,
    `returned BEFORE the pump's 50 ms wait-for completed (${
      ms(elapsed)
    }) — the detached task is still in flight`,
  );
} catch (e) {
  check(false, `start-pump threw — ${classify(e)}`);
}

console.log(`\n--- probe 3: poll-pump()   [jco deadlocks here]`);
if (pumpStarted) {
  try {
    const t0 = performance.now();
    const v = await fn("poll-pump")();
    const desc = unwrapOk(v, "poll-pump");
    check(
      typeof desc === "string",
      `ok(string) in ${
        ms(performance.now() - t0)
      } — an export call ran to completion AFTER a detached task was left ` +
        `parked (lann/jco#11 / polymorph-iroh#10)`,
    );
    note(`guest says: ${desc}`);
  } catch (e) {
    check(false, `poll-pump threw — ${classify(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Probe 4a — exported stream, read to completion.
//
// FINDING R-1 (see runtime/tests/host_pump_test.ts): the guest fills this stream from a
// DETACHED task that awaits `wait-for` between chunks. Once the export call
// has returned there is no `driveAsync` loop, and nothing re-pumps the store
// when a Promise-returning host import settles — so the host read stalls after
// the first (already-buffered) chunk. Bounded here so the leg still reports.
// ---------------------------------------------------------------------------
console.log(`\n--- probe 4a: open-stream(5000, 1000) read to completion`);
try {
  const returned = await withTimeout(fn("open-stream")(5000, 1000), "open-stream");
  const s = hostStreamFor<number>(returned as ComponentValue);
  let count = 0;
  let reads = 0;
  let stalled = "";
  try {
    for (let i = 0; i < 200; i++) {
      const vs = await withTimeout(s.readable.read(4096), `read#${i}`);
      reads++;
      if (vs.length === 0) break;
      count += vs.length;
    }
  } catch (e) {
    stalled = classify(e);
  }
  check(
    count === 5000,
    `host read ${count}/5000 bytes in ${reads} reads` +
      (stalled ? ` then stalled (${stalled})` : ""),
  );
  note(`guest writer parked on an async host import with no export call in ` +
    `flight — the R-1 shape; the host pump drives it (host_pump_test.ts)`);
} catch (e) {
  check(false, `open-stream (complete) threw — ${classify(e)}`);
}

// ---------------------------------------------------------------------------
// Probe 4b — reader dropped mid-stream: the guest writer must observe
// resolution ("reader stopped after N bytes"), not trap.
// ---------------------------------------------------------------------------
console.log(`\n--- probe 4b: open-stream(100000, 1000), drop reader mid-stream`);
try {
  const returned = await withTimeout(fn("open-stream")(100000, 1000), "open-stream");
  const s = hostStreamFor<number>(returned as ComponentValue);
  let count = 0;
  let stalled = "";
  try {
    while (count < 2500) {
      const vs = await withTimeout(s.readable.read(1024), "read");
      if (vs.length === 0) break;
      count += vs.length;
    }
  } catch (e) {
    stalled = classify(e);
  }
  check(count >= 2500, `host read ${count}/2500 bytes before dropping` +
    (stalled ? ` (${stalled})` : ""));
  // Drop and see what the writer observed — the actual semantics under test.
  try {
    s.readable.drop();
  } catch (e) {
    check(false, `readable.drop() threw — ${classify(e)}`);
  }
  try {
    const out = unwrapOk(
      await withTimeout(fn("stream-outcome")(), "stream-outcome"),
      "stream-outcome",
    );
    check(
      typeof out === "string" && out.includes("reader stopped"),
      `writer observed resolution, not a trap: ${out}`,
    );
  } catch (e) {
    check(false, `stream-outcome after reader drop — ${classify(e)}`);
  }
} catch (e) {
  check(false, `probe 4b unreachable — ${classify(e)}`);
}

// ---------------------------------------------------------------------------
// Probe 5 — host-provided stream into the guest.
// ---------------------------------------------------------------------------
console.log(`\n--- probe 5: sink-stream(<host stream of 500 bytes>)`);
try {
  const s = hostStream<number>({ kind: "u8" });
  const t0 = performance.now();
  const pending = fn("sink-stream")(s.value);
  const payload = new Array(500).fill(0x33);
  await s.writable.writeAll(payload);
  s.writable.drop();
  const n = unwrapOk(await withTimeout(pending, "sink-stream"), "sink-stream");
  check(n === 500, `guest counted ${n} bytes in ${ms(performance.now() - t0)}`);
} catch (e) {
  check(false, `sink-stream threw — ${classify(e)}`);
}

// ---------------------------------------------------------------------------
console.log(`\n--- diagnostics`);
note(`stats: ${JSON.stringify(c.stats)}`);
note(`host imports actually reached: ${
  [...new Set(trace)].sort().join(", ") || "(none)"
}`);
note(`guest resource drops observed: ${dropped.length}`);
if (stdioLog.length > 0) {
  console.log(`  guest stdio (${stdioLog.length} writes):`);
  for (const l of stdioLog) console.log(`    ${l.trimEnd()}`);
}

console.log(
  `\nleg2 verdict: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`,
);
for (const f of failures) console.log(`  FAIL  - ${f}`);
// Deno keeps the process alive on the pending `wait-for` timers of the guest's
// abandoned detached tasks; the verdict is printed, so leave deliberately.
Deno.exit(failures.length > 0 ? 1 : 0);
