// The lift/lower CONVENTIONS suite — the executable definition of the host ABI
// (contracts/embedder-api.md §"The host-ABI surface and its version",
// amendment A22).
//
// WHAT THIS SUITE IS. Every other suite under runtime/tests/ asserts a
// property. This one RECORDS what the engine does at the host boundary, as a
// normalized transcript, and compares it byte-for-byte against a committed
// golden under `runtime/tests/conventions/golden/`. The goldens are the
// artifact: they make a host-ABI change impossible to ship silently.
//
//   - Modifying or deleting a committed golden asserts a host-ABI behavior
//     change and requires `breaking/protocol` in the same PR (or, for a
//     reviewed behavior-neutral correction of the suite itself,
//     `conventions-fix`). Adding goldens is free.
//   - `tools/version-guard/check.ts` (LOCKED_GOLDEN_DIR) enforces that at PR
//     time and authoritatively at cut time. The directory path is therefore
//     load-bearing; do not move it.
//
// UPDATING A GOLDEN. Deliberately not the default test task's permissions —
// `deno task test` cannot write into the repo. From `runtime/`:
//
//   deno test --allow-read=..,/tmp --allow-write=/tmp,tests/conventions/golden \
//     --allow-env=POLYENGINE_SCHED_SEED,POLYENGINE_UPDATE_GOLDEN \
//     --allow-run tests/conventions/
//
// with `POLYENGINE_UPDATE_GOLDEN=1` in the environment. Then read the diff:
// every changed line is a claim about the host ABI, and the PR needs the label
// to match.
//
// THE PROBE HOST MODULE. `probe.ts` is written the way a consumer writes a
// host module: `@polyengine/protocol` for vocabulary (predicates, brands,
// `suspending()`, `ComponentException`) and NOTHING from the runtime. One case
// family goes further and hand-rolls its brands with zero protocol imports
// (A9: "a hand-rolled object carrying the right brand is a legal value").
// The HARNESS side below is the APPLICATION — instantiation, artifact
// resolution — so it legitimately uses `@polyengine/runtime/embedder`.
//
// DETERMINISM IS A HARD REQUIREMENT. `just sched-seeds` re-runs this suite
// under POLYENGINE_SCHED_SEED=1 and =4242; transcripts must be byte-identical
// there and under FIFO. The rules that buy that, enforced by construction:
//
//   - one transcript per case, driven by a single guest task, awaited to
//     completion — no cross-task interleaving is ever recorded;
//   - no timings, no durations, no object identities, no absolute paths, no
//     iteration order that the scheduler chooses (object keys are emitted
//     SORTED; array order is program order);
//   - values are normalized STRUCTURALLY — a handle is recognized by the
//     protocol brand predicate, never by a constructor name, which would pin
//     a class identity A9 removed from the contract in the first place.
//
// One deliberate exception to "record the message": a trap authored by the
// ENGINE (a raw `unreachable`) carries the JS engine's own wording, which
// differs per engine and is explicitly not API (§"Error model"). `normalize`
// records such traps by brand alone. Runtime-AUTHORED trap wording is stable
// by project choice and IS recorded, because "the message names the import"
// is a convention worth pinning.

import {
  isComponentException,
  isDroppedError,
  isErrorContext,
  isFuture,
  isInvalidHandleError,
  isPeerTrappedError,
  isStream,
  isStreamProducerError,
  isStreamWriter,
  isTrap,
} from "@polyengine/protocol";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Absolute paths and `file://` URLs are environment, never behavior. */
export function scrubMessage(m: string): string {
  return m
    .replace(/file:\/\/[^\s)>;,]+/g, "<url>")
    .replace(/(?<![\w.])\/[\w./-]+\.(ts|js|wasm|wat)\b/g, "<path>")
    .replace(/\r?\n[\s\S]*$/, " …");
}

/**
 * A trap whose wording the engine chose (`guest trapped:` provenance prefix,
 * §"Error model") is recorded by brand alone: V8/SpiderMonkey/JSC each phrase
 * `unreachable` differently and the runtime deliberately does not normalize
 * them.
 */
function engineWorded(message: string): boolean {
  return message.includes("guest trapped:");
}

type Norm = unknown;

function normError(e: object, seen: Set<object>): Norm {
  const err = e as Error & {
    payload?: unknown;
    progress?: number;
    cause?: unknown;
    code?: unknown;
  };
  const msg = typeof err.message === "string" ? scrubMessage(err.message) : "";
  const body: Record<string, unknown> = {};

  if (isComponentException(e)) {
    body.tag = "componentException";
    body.message = msg;
    // A10: `payload` is the WIT err value; a payloadless err's payload is
    // `undefined` (the empty-side spelling of §"Error model").
    if ("payload" in err) body.payload = normalize(err.payload, seen);
  } else if (isPeerTrappedError(e)) {
    body.tag = "peerTrapped";
    body.message = msg;
    if (typeof err.progress === "number") body.progress = err.progress;
    body.cause = normalize(err.cause, seen);
  } else if (isTrap(e)) {
    body.tag = "trap";
    // See the header note: engine-worded traps record no text.
    body.message = engineWorded(msg) ? "<engine-worded>" : msg;
  } else if (isDroppedError(e)) {
    body.tag = "dropped";
  } else if (isInvalidHandleError(e)) {
    body.tag = "invalidHandle";
    body.message = msg;
  } else if (isStreamProducerError(e)) {
    body.tag = "streamProducer";
    body.message = msg;
    body.cause = normalize(err.cause, seen);
  } else {
    // An UNBRANDED error: the class of value the contract says never crosses
    // as an err (§"Error model"). Name and message only — no stack. Its
    // `cause` IS walked: A20's canonical chain is an unbranded poisoning
    // failure whose own cause is the underlying `Trap`, and the trap at the
    // bottom must stay recognizable.
    body.tag = "error";
    body.name = err.name;
    body.message = msg;
    if (err.cause !== undefined) body.cause = normalize(err.cause, seen);
  }
  return { "@err": body };
}

/**
 * Structural normalization of any host-visible value into JSON-able data.
 *
 * The distinctions this preserves are exactly the ones the contract makes:
 * an ABSENT property vs. one present-and-`undefined` (the option/variant rule,
 * §"Value mapping"), `Uint8Array` vs. `T[]` (the `Chunk<u8>` rule), `bigint`
 * vs. `number` (u64/s64), and brand membership for every stateful value.
 */
export function normalize(v: unknown, seen: Set<object> = new Set()): Norm {
  if (v === undefined) return "@undefined";
  if (v === null) return "@null";
  switch (typeof v) {
    case "boolean":
    case "string":
      return v;
    case "number":
      // -0 and NaN are not JSON round-trippable; spell them.
      if (Number.isNaN(v)) return "@NaN";
      if (v === 0 && Object.is(v, -0)) return "@-0";
      if (!Number.isFinite(v)) return v > 0 ? "@Infinity" : "@-Infinity";
      return v;
    case "bigint":
      return { "@bigint": v.toString() };
    case "symbol":
      return "@symbol";
    case "function":
      return "@function";
  }

  const o = v as object;
  if (seen.has(o)) return "@cycle";
  seen.add(o);
  try {
    // Stateful handles: brand first, ALWAYS — never `instanceof`, never
    // `constructor.name` (A9 removed class identity from the contract).
    if (isStream(o)) return "@stream";
    if (isStreamWriter(o)) return "@streamWriter";
    if (isFuture(o)) return "@future";
    if (isErrorContext(o)) {
      return { "@errorContext": (o as { message: string }).message };
    }
    if (o instanceof Error) return normError(o, seen);

    if (o instanceof Uint8Array) return { "@u8": Array.from(o) };
    if (ArrayBuffer.isView(o) || o instanceof ArrayBuffer) return "@binary";
    if (Array.isArray(o)) return o.map((e) => normalize(e, seen));

    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      // A class instance the conventions do not define a shape for (a host
      // resource instance, say). Callers that care record a projection of it
      // instead; recording an identity here would be nondeterministic.
      return "@object";
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      out[k] = normalize((o as Record<string, unknown>)[k], seen);
    }
    return out;
  } finally {
    seen.delete(o);
  }
}

/** Deterministic JSON: object keys emitted in sorted order at every depth. */
function stableStringify(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${
      Object.keys(o).sort().map((k) =>
        `${JSON.stringify(k)}:${stableStringify(o[k])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------

/**
 * One transcript. `note` appends an event in PROGRAM order; nothing about
 * wall-clock time, task interleaving, or identity may reach it.
 */
export class Transcript {
  readonly #lines: string[] = [];
  constructor(readonly name: string) {}

  /** Record `ev` with structurally normalized fields. */
  note(ev: string, data: Record<string, unknown> = {}): void {
    const row: Record<string, unknown> = { ev };
    for (const k of Object.keys(data).sort()) row[k] = normalize(data[k]);
    this.#lines.push(stableStringify(row));
  }

  /** Record the outcome of `f`: its value, or whatever it threw. */
  async attempt(ev: string, f: () => unknown): Promise<unknown> {
    try {
      const value = await f();
      this.note(ev, { ok: true, value });
      return value;
    } catch (e) {
      this.note(ev, { ok: false, threw: e });
      return undefined;
    }
  }

  /**
   * Record the outcome of `f` and hand back whatever it THREW (undefined when
   * it did not throw) — for cases that go on to interrogate the failure.
   */
  async caught(ev: string, f: () => unknown): Promise<unknown> {
    try {
      this.note(ev, { ok: true, value: await f() });
      return undefined;
    } catch (e) {
      this.note(ev, { ok: false, threw: e });
      return e;
    }
  }

  text(): string {
    return this.#lines.map((l) => l + "\n").join("");
  }
}

// ---------------------------------------------------------------------------
// Golden comparison
// ---------------------------------------------------------------------------

function envFlag(name: string): boolean {
  // `deno task test` grants --allow-env=POLYENGINE_SCHED_SEED only; reading
  // anything else throws rather than returning undefined. The suite must run
  // unchanged under those permissions, so the read is guarded.
  try {
    return (Deno.env.get(name) ?? "") !== "";
  } catch {
    return false;
  }
}

const UPDATING = envFlag("POLYENGINE_UPDATE_GOLDEN");

/**
 * Compare a transcript against its committed golden — or rewrite it when
 * POLYENGINE_UPDATE_GOLDEN is set (see this file's header for the exact
 * command; the default test task has no write permission for the repo).
 */
export async function checkGolden(t: Transcript): Promise<void> {
  const url = new URL(`./golden/${t.name}.jsonl`, import.meta.url);
  const got = t.text();
  if (UPDATING) {
    await Deno.writeTextFile(url, got);
    return;
  }
  let want: string;
  try {
    want = await Deno.readTextFile(url);
  } catch {
    throw new Error(
      `conventions: no golden for "${t.name}". This transcript is NEW ` +
        `coverage (free to add — see support.ts's header for the update ` +
        `command). Recorded:\n${got}`,
    );
  }
  if (got === want) return;
  throw new Error(
    `conventions: transcript "${t.name}" diverged from its golden.\n` +
      `A divergence is a HOST-ABI BEHAVIOR CHANGE unless the suite itself was ` +
      `wrong (contracts/embedder-api.md A22).\n--- golden ---\n${want}` +
      `--- recorded ---\n${got}`,
  );
}

/** Record a case and compare it, in one call. */
export async function transcript(
  name: string,
  body: (t: Transcript) => Promise<void>,
): Promise<void> {
  const t = new Transcript(name);
  await body(t);
  await checkGolden(t);
}
