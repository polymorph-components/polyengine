// Consumer smoke test — shared helpers (docs/consumers.md).
//
// Run legs from this directory:
//   deno run --allow-read leg1_tdz.ts
//   deno run --allow-read leg2_exec_model.ts
//   deno run --allow-read leg3_throughput.ts
//   deno run --allow-read --allow-run leg4_websocket.ts
//
// Prerequisite (built from source in this repo):
//   cargo build -p translator-shim --release --target wasm32-unknown-unknown
//
// All consumer artifacts are referenced by absolute path and are READ-ONLY;
// nothing in this tree writes to the polymorph working trees.

import { Translator } from "../../runtime/src/shim/mod.ts";
import { TranslateError } from "../../runtime/src/plan/mod.ts";
import type { WirePlan } from "../../runtime/src/plan/format.ts";

export const REPO_ROOT = new URL("../../", import.meta.url);
export const POLYMORPH = Deno.env.get("POLYMORPH_ROOT") ??
  "/home/lmartin/p/polymorph";
/** experiment-mosh renamed and moved out of the polymorph tree
 * (2026-08-10): it is `wosh`, a sibling OF the polymorph directory. */
export const WOSH = Deno.env.get("WOSH_ROOT") ?? "/home/lmartin/p/wosh";

/** Absolute paths to the consumer artifacts under test (never copied). */
export const ARTIFACTS = {
  tdz: `${WOSH}/spikes/compose-async-tdz/composed.wasm`,
  execModel:
    `${POLYMORPH}/polymorph-iroh/target/wasm32-wasip2/release/iroh_exec_model_guest.wasm`,
  engineGo: `${WOSH}/engine-go/main.wasm`,
  composedClient: `${WOSH}/client-core/composed-client.wasm`,
  composedProxy: `${WOSH}/proxy/composed-proxy.wasm`,
  irohEndpoint:
    `${POLYMORPH}/polymorph-iroh/target/wasm32-wasip2/release/iroh_endpoint.wasm`,
} as const;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function loadTranslator(): Promise<Translator> {
  const rel = "target/wasm32-unknown-unknown/release/translator_shim.wasm";
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(new URL(rel, REPO_ROOT));
  } catch {
    throw new Error(
      `missing ${rel} — run: cargo build -p translator-shim --release ` +
        `--target wasm32-unknown-unknown`,
    );
  }
  return await Translator.create(bytes);
}

export async function readArtifact(path: string): Promise<Uint8Array> {
  return await Deno.readFile(path);
}

/** A translation attempt with wall-clock timing and a structured verdict. */
export interface TranslateAttempt {
  ok: boolean;
  ms: number;
  envelopeBytes: number;
  /** Set when `ok`. */
  plan?: WirePlan;
  adapters?: Map<string, Uint8Array>;
  /** Set when `!ok`: the envelope's `errorDetail`, verbatim. */
  errorPhase?: string;
  errorMessage?: string;
  errorDetail?: string;
}

/**
 * One `translateRaw` + `loadEnvelope` pass.
 *
 * Rejections are captured, not thrown: contracts/plan-format.md gives the
 * shim three phases (validation | unsupported | internal) and this suite's job is to
 * triage them, so every phase is data here.
 */
export function translateOnce(
  t: Translator,
  bytes: Uint8Array,
): TranslateAttempt {
  const t0 = performance.now();
  let json: string;
  try {
    json = t.translateRaw(bytes);
  } catch (e) {
    return {
      ok: false,
      ms: performance.now() - t0,
      envelopeBytes: 0,
      errorPhase: "internal(host)",
      errorMessage: String(e),
      errorDetail: String((e as Error)?.stack ?? ""),
    };
  }
  const ms = performance.now() - t0;
  const envelopeBytes = json.length;
  try {
    const { plan, adapters } = t.translate(bytes);
    return { ok: true, ms, envelopeBytes, plan, adapters };
  } catch (e) {
    if (e instanceof TranslateError) {
      return {
        ok: false,
        ms,
        envelopeBytes,
        errorPhase: e.phase,
        errorMessage: e.message,
        errorDetail: e.detail,
      };
    }
    return {
      ok: false,
      ms,
      envelopeBytes,
      errorPhase: "plan-load",
      errorMessage: String(e),
      errorDetail: String((e as Error)?.stack ?? ""),
    };
  }
}

/** Group `plan.imports` by interface (everything before the last path leaf). */
export function importSurface(plan: WirePlan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const imp of plan.imports) {
    // `name` is the component's top-level import string; `path` walks into
    // instance imports (`imports[].path`, contracts/plan-format.md schema).
    const iface = imp.name;
    const leaf = imp.path.length > 0 ? imp.path.join("/") : "<direct>";
    const list = out.get(iface) ?? [];
    list.push(`${leaf} [${imp.kind}]`);
    out.set(iface, list);
  }
  for (const v of out.values()) v.sort();
  return new Map([...out].sort((a, b) => a[0] < b[0] ? -1 : 1));
}

export function fmtSurface(plan: WirePlan): string {
  const lines: string[] = [];
  for (const [iface, leaves] of importSurface(plan)) {
    lines.push(`  ${iface}`);
    for (const l of leaves) lines.push(`      ${l}`);
  }
  return lines.join("\n");
}

export function planShape(plan: WirePlan): string {
  const embedded = plan.modules.filter((m) => m.kind === "embedded").length;
  const adapters = plan.modules.filter((m) => m.kind === "adapter").length;
  return `modules=${plan.modules.length} (embedded=${embedded} adapter=${adapters}) ` +
    `initializers=${plan.initializers.length} trampolines=${plan.trampolines.length} ` +
    `types=${plan.types.length} imports=${plan.imports.length} exports=${plan.exports.length}`;
}

export function ms(n: number): string {
  return `${n.toFixed(1)} ms`;
}
