// The host half of the kitchen-sink example: a representative tour of the
// embedder API (contracts/embedder-api.md — the authority if this file and
// the contract ever disagree).
//
//   §1  translate + instantiate, with a real imports record
//   §2  host-implemented imports: sync, fallible (ComponentException), suspending
//   §3  a host-implemented resource class (@suspending method, static,
//       dispose-on-guest-drop)
//   §4  calling exports: enum/variant/record/flags spellings
//   §5  outermost option vs return-place result vs NESTED option/result
//   §6  a guest-implemented resource driven with `using`
//   §7  run-batch: the guest drives every import, parking twice on JSPI
//       without knowing it
//   §8  streams: natural producers in (array / ReadableStream), a
//       Stream<T> handle out (for-await in chunks)
//   §9  futures: a Promise in, an EAGER Future handle out
//
// Run with: ./run.sh

import {
  instantiate,
} from "@polyengine/runtime/embedder";
import { suspending, ComponentException } from "@polyengine/protocol";
import { defaultTranslator } from "@polyengine/translator";

// Tiny self-checks so the example fails loudly if the API drifts.
// (`undefined` is meaningful in the conventions — the outermost-option
// spelling — so the replacer must not let JSON collapse it into null.)
function assertEq(got: unknown, want: unknown, what: string) {
  const replacer = (_k: string, v: unknown) =>
    v === undefined ? "<undefined>" : typeof v === "bigint" ? `${v}n` : v;
  const g = JSON.stringify(got, replacer);
  const w = JSON.stringify(want, replacer);
  if (g !== w) throw new Error(`${what}: expected ${w}, got ${g}`);
}

// --- §2/§3: the host side of the `notify` import interface ------------------

const logs: string[] = [];

/** §3 — a host-implemented resource. The guest's `channel` resource maps to
 * this class: constructor from the guest's `Channel::new`, camelCase
 * methods, statics as statics, and `[Symbol.dispose]` invoked by the
 * runtime when the guest drops its last own handle. `send` is marked
 * @suspending: it returns a Promise, so each guest `chan.send(...)` parks
 * the guest's wasm frame until the "transmission" settles. */
class Channel {
  static #open = 0;
  #name: string;
  #sent = 0;

  constructor(name: string) {
    Channel.#open += 1;
    this.#name = name;
  }

  @suspending
  send(msg: string): Promise<number> {
    logs.push(`channel[${this.#name}] <- ${msg}`);
    this.#sent += 1;
    // Settles on a macrotask: a genuine park, not a microtask formality.
    return new Promise((r) => setTimeout(() => r(this.#sent), 0));
  }

  label(): string {
    return this.#name;
  }

  static openCount(): number {
    return Channel.#open;
  }

  [Symbol.dispose]() {
    Channel.#open -= 1;
    logs.push(`channel[${this.#name}] disposed`);
  }
}

const imports = {
  // Interface imports are keyed by their verbatim WIT id; members are
  // camelCase. World-level bare imports (none here) would sit at the top
  // level of this record.
  "polyengine:kitchen-sink/notify": {
    // §2a — plain sync import. The enum parameter arrives as a string.
    log: (lvl: string, msg: string) => {
      logs.push(`${lvl}: ${msg}`);
    },

    // §2b — fallible import (result return-place): return the ok value;
    // throw `new ComponentException(payload)` for the err side. Any OTHER throw is a
    // host bug and traps the component — the anti-footgun inversion.
    parseId: (raw: string): number => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        throw new ComponentException(`'${raw}' is not an id`);
      }
      return n;
    },

    // §2c — a SUSPENDING import: sync-typed in WIT (`func() -> u64`), but
    // the implementation returns a Promise. The `suspending()` marker (the
    // call form; `@suspending` on Channel.send above is the decorator
    // form) declares that intent: the guest's frame parks on JSPI and
    // resumes with the value. Costs to know about: every call through a
    // marked import pays an engine continuation hop even when it returns
    // synchronously, and a marked import must not be reached from a
    // component's `start` function.
    readSensor: suspending(
      (): Promise<bigint> =>
        new Promise((r) => setTimeout(() => r(6502n), 0)),
    ),

    // §3 — the resource class sits at its WIT-named (PascalCase) position.
    Channel,
  },
};

// --- §1: translate + instantiate --------------------------------------------

const translator = await defaultTranslator();
const componentBytes = await Deno.readFile(
  new URL("build/kitchen-sink.component.wasm", import.meta.url),
);

// `{ componentBytes, translator }` translates internally (A3);
// `defaultTranslator()` is @polyengine/translator's packaged, per-realm-cached
// loader (on Deno: a native wasm-module import — no permissions). Apps
// that know their components at build time can skip the translator
// entirely: see tools/translate (embedder-api A4).
//
// A marked import is auto-detection evidence: this instantiation selects
// JSPI mode by itself. (`jspi: false` would force plain mode, where a
// Promise from a sync-typed import is refused instead of parked.)
const component = await instantiate({ componentBytes, translator }, imports);

// Interface exports are keyed like interface imports: verbatim WIT id.
const api = component.exports["polyengine:kitchen-sink/api"];

// --- §4: plainly-shaped values ----------------------------------------------

// variant → { kind } / { kind, value }; nested records are plain objects.
assertEq(await api.describe({ kind: "dot" }), "a dot", "describe dot");
assertEq(
  await api.describe({ kind: "circle", value: 3 }),
  "a circle of radius 3",
  "describe circle",
);
assertEq(
  await api.describe({ kind: "rect", value: { x: 4, y: 5 } }),
  "a rectangle to (4, 5)",
  "describe rect",
);

// enum → string.
assertEq(await api.classify(7), "debug", "classify 7");
assertEq(await api.classify(512), "warn", "classify 512");

// record → object.
assertEq(
  await api.scale({ x: 2, y: -3 }, 10),
  { x: 20, y: -30 },
  "scale",
);

// flags → object of booleans (absent = false when lowering).
assertEq(await api.allowed({ read: true, write: true }), true, "allowed rw");
assertEq(await api.allowed({ exec: true }), false, "allowed exec-only");

// --- §5: the three faces of option/result ------------------------------------

// OUTERMOST option: `undefined` or the value — no wrapper object.
assertEq(await api.find("origin"), { x: 0, y: 0 }, "find origin");
assertEq(await api.find("atlantis"), undefined, "find missing");

// RETURN-PLACE result: ok resolves; err arrives as a thrown ComponentException whose
// `.payload` is the WIT err value. Match on the brand, never on message.
assertEq(await api.lookup("unit"), { x: 1, y: 1 }, "lookup ok");
try {
  await api.lookup("atlantis");
  throw new Error("lookup should have thrown");
} catch (e) {
  if (!(e instanceof ComponentException)) throw e;
  assertEq(e.payload, "no point named 'atlantis'", "lookup err payload");
}

// NESTED option/result are plain data — but note WHICH rule applies where:
// the result-as-value is { kind: "ok" | "err", value }, while the option
// wrapping it is still the outermost of ITS OWN chain (the list does not
// count), so the none slot is a genuine `undefined`, not a { kind: "none" }.
assertEq(
  await api.survey(),
  [
    undefined,
    { kind: "ok", value: { x: 2, y: 3 } },
    { kind: "err", value: "survey hole" },
  ],
  "survey nested shapes",
);

// Option-inside-option is the ONE place boxing appears, and it boxes
// exactly as deep as needed (the contract's worked example):
assertEq(await api.maybeMaybe(0), undefined, "maybe-maybe none");
assertEq(await api.maybeMaybe(1), { kind: "none" }, "maybe-maybe some(none)");
assertEq(
  await api.maybeMaybe(2),
  { kind: "some", value: 7 },
  "maybe-maybe some(some(7))",
);

// --- §6: a guest-implemented resource ----------------------------------------

// The exports facade gives a real class: construct (synchronously — the
// one exception to Promise-shaped exports), call methods, and let `using`
// drop the handle (guest-side state is freed when scope ends).
{
  using counter = new api.Counter(3);
  assertEq(await counter.increment(), 4, "counter.increment");
  assertEq(await counter.increment(), 5, "counter.increment again");
  assertEq(await counter.current(), 5, "counter.current");
}

// --- §7: the guest drives the imports ----------------------------------------

// run-batch logs, parses (both result sides), reads the suspending sensor,
// and sends through a Channel — parking this component's stack on every
// suspending call, invisibly to the guest code.
const reading = await api.runBatch(3);
assertEq(reading, 6502n, "run-batch sensor reading");

assertEq(Channel.openCount(), 0, "channel disposed after guest drop");
assertEq(
  logs.filter((l) => l.startsWith("channel[batch] <-")).length,
  3,
  "three sends through the channel",
);
assertEq(logs.includes("info: batch: done"), true, "guest logged completion");

// --- §8: streams ---------------------------------------------------------------

// Where the guest expects a stream<u32>, pass a natural producer — a
// finite array is the simplest (auto-closed at the end)...
assertEq(await api.tally([1, 2, 3, 4]), 10n, "tally an array-as-stream");

// ...or anything ReadableStream/AsyncIterable-shaped.
assertEq(
  await api.tally(ReadableStream.from([5, 6, 7])),
  18n,
  "tally a ReadableStream",
);

// A guest-PRODUCED stream arrives as a Stream<u32> handle. `for await`
// yields CHUNKS — number[] batches (Uint8Array for stream<u8>), never
// single values — sized by whatever the guest wrote per rendezvous.
const stream = await api.countdown(3);
const received: number[] = [];
for await (const chunk of stream) received.push(...chunk);
assertEq(received, [3, 2, 1], "countdown chunks, flattened");

// --- §9: futures ---------------------------------------------------------------

// Where the guest expects a future<u32>, a plain Promise works.
assertEq(
  await api.promisedDouble(
    new Promise((r) => setTimeout(() => r(21), 0)),
  ),
  42,
  "promise-as-future",
);

// A future-typed RESULT is the one deliberate exception to Promise-shaped
// exports: the call returns an EAGER Future<u32> handle, synchronously.
// (Wrapping it in a Promise would let JS promise resolution adopt the
// thenable handle — drop()/cancel() would become unreachable.) Hold it,
// inspect it, then await it: the handle is thenable and yields the value.
const fut = api.deferredAnswer();
assertEq(typeof fut.drop, "function", "deferred-answer returns a handle");
assertEq(await fut, 42, "awaiting the handle yields the value");

console.log(`kitchen-sink example: OK (${logs.length} log lines)`);
