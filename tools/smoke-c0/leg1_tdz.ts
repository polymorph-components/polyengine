// Leg 1 — the lann/jco#51 TDZ shape, executed.
//
//   deno run --allow-read leg1_tdz.ts
//
// Artifact: wosh/spikes/compose-async-tdz/composed.wasm (the consumer
// formerly named experiment-mosh) — a wac
// composition of `tdz:plug` (async factory returning own<widget>) into
// `tdz:socket` (async export awaiting it, plus an exported `handoff`
// interface that names the same resource in a signature). That combination
// is exactly jco's TDZ trigger: the emitted trampoline references a resource
// class above its declaration. A runtime linker emits nothing, so the defect
// *class* cannot exist here — this leg makes that claim executable.
//
// Expected values read from source, not guessed:
//   plug/src/lib.rs:  make() -> Ok(Widget::new(WidgetRes(42)))
//   socket/src/lib.rs: run() -> Ok(make().await?.poke())  =>  ok(42)
// `handoff.accept(w: widget)` is NOT callable from the host: `widget` is
// defined by the plug instance and is not exported by the composed world, so
// the host cannot mint one. Its mere presence is the trigger; we assert it is
// exported and correctly typed instead.

import {
  ARTIFACTS,
  fmtSurface,
  loadTranslator,
  planShape,
  readArtifact,
  sha256Hex,
  translateOnce,
} from "./common.ts";
import { buildImports } from "./wasi_stub.ts";
import { instantiateComponent } from "../../runtime/src/exec/mod.ts";

function check(cond: boolean, msg: string) {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
}
const failures: string[] = [];

console.log("=== Leg 1: compose-async-tdz (lann/jco#51 shape) ===\n");

const bytes = await readArtifact(ARTIFACTS.tdz);
console.log(`artifact: ${ARTIFACTS.tdz}`);
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
console.log(`  worldDigest: ${plan.worldDigest}`);
console.log(`  adapters: ${att.adapters!.size} (FACT modules — the fused`);
console.log(`            cross-component async call, jco's #14 shape)`);
console.log(`\nimports (all from the Rust wasip2 libc baseline, none from`);
console.log(`the WIT world — see plug/wit + socket/wit):`);
console.log(fmtSurface(plan));

console.log(`\nexports:`);
for (const e of plan.exports) console.log(`  ${e.kind} ${e.name}`);

// The trigger surface: BOTH interfaces exported, one of which names the
// imported-from-plug resource in its signature.
const exportNames = plan.exports.map((e) => e.name);
check(
  exportNames.some((n) => n.includes("driver")),
  `exports the driver interface (${exportNames.join(", ")})`,
);
check(
  exportNames.some((n) => n.includes("handoff")),
  "exports the handoff interface — the resource re-export that is jco#51's trigger",
);
check(att.adapters!.size >= 1, "FACT adapter(s) emitted for the fused call");

// ---------------------------------------------------------------------------
// Instantiate. Everything in `plan.imports` is libc baseline noise (stdio,
// exit, terminal probing) that this component only touches on panic, so pure
// stubs are correct: if one fires, that is a finding, and StubCalled says so.
// ---------------------------------------------------------------------------
const trace: string[] = [];
const { imports, stubbed } = buildImports(plan, { trace });
console.log(`\nhost glue: ${stubbed.length} leaves stubbed, 0 implemented`);

const c = await instantiateComponent({
  plan,
  componentBytes: bytes,
  adapters: att.adapters!,
  imports,
});
check(true, "instantiate succeeded (no emission step exists to have a TDZ in)");

const driverExport = exportNames.find((n) => n.includes("driver"))!;
const driver = c.exports[driverExport] as Record<string, unknown>;
console.log(`\ndriver instance exports: ${Object.keys(driver).join(", ")}`);
const run = driver["run"] as () => unknown;
check(typeof run === "function", "driver.run is callable");

// `run` is `async func` and awaits a cross-component async call, so it parks:
// the host sees a Promise, driven by the runtime's own loop.
const pending = run();
check(
  pending instanceof Promise,
  "run() parked on the cross-component async call (returned a Promise)",
);
const result = await pending;
console.log(`\nrun() = ${JSON.stringify(result, (_k, v) =>
  typeof v === "bigint" ? `${v}n` : v)}`);
// OBSERVED CONVENTION: `result<u32, string>` lifts at the raw boundary to
// `{ kind: "ok", value: 42 }` / `{ kind: "error", value: "…" }` — not a bare
// payload. Recorded here because embedder-api.md owns the host shape (whose
// error kind is "err", not "error") and jco's bare-payload-throw is the
// footgun being replaced.
const asRec = result as { kind?: unknown; value?: unknown };
const isOk = asRec !== null && typeof asRec === "object" &&
  asRec.kind === "ok";
const payload = isOk ? asRec.value : undefined;
check(isOk, `result is the ok case (kind=${String(asRec?.kind)})`);
check(
  payload === 42 || payload === 42n,
  `run() -> ok(42) — plug/src/lib.rs WidgetRes(42).poke() through the fused ` +
    `async call (got ${String(payload)})`,
);

check(trace.length === 0, `no baseline import fired (trace: ${trace.join(", ") || "empty"})`);

console.log(`\nstats: ${JSON.stringify(c.stats)}`);

console.log(
  `\nleg1 verdict: ${failures.length === 0 ? "PASS" : `FAIL (${failures.length})`}`,
);
for (const f of failures) console.log(`  - ${f}`);
if (failures.length > 0) Deno.exit(1);
