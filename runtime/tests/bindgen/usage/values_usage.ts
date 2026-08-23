// Hand-written usage sample for the generated `values.ts` facade — pins
// every host-value shape mapping (records, variants, enums, flags, options
// incl. nested boxing, results-as-function-result, tuples, lists) against
// the generated C1-convention types (contracts/embedder-api.md value
// mapping table), at `deno check` time.

import { bind } from "../generated/values.ts";
import type {
  Color,
  Mixed,
  Perms,
  Shape,
  ValuesExports,
} from "../generated/values.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { ComponentException } from "@polyengine/protocol";
import type { Equal, Expect } from "./type_assert.ts";

// --- record: camelCase fields -------------------------------------------
type _MixedFields = Expect<
  Equal<Mixed, { a: number; b: string; c: number; d: boolean }>
>;

// --- variant: `{kind}` | `{kind,value}`, value ABSENT (not undefined) for the
// payloadless case ---------------------------------------------------------
type _ShapeIsKindValue = Expect<
  Equal<
    Shape,
    | { kind: "point" }
    | { kind: "circle"; value: number }
    | { kind: "label"; value: string }
    | { kind: "rect"; value: Size_ }
  >
>;
interface Size_ {
  w: number;
  h: number;
}
// Payloadless case really has no `value` key at all (not `value: undefined`):
// a value assignable to the point case must not require providing `value`,
// and `value` must not be a legal key on it.
const point: Shape = { kind: "point" };
// @ts-expect-error value is not a valid property on the payloadless case
const _pointWithValue: Shape = { kind: "point", value: 1 };
void point;

// --- enum: kebab string literal union, NOT `{kind}` objects --------------
type _ColorIsStringUnion = Expect<Equal<Color, "red" | "green" | "blue">>;
const _colorLiteral: Color = "red";

// --- flags: object of camelCase booleans ---------------------------------
type _PermsFields = Expect<
  Equal<Perms, { read: boolean; write: boolean; exec: boolean; admin: boolean }>
>;

export function useValues(instance: EmbedderInstance) {
  const exports: ValuesExports = bind(instance);

  // Exports are uniformly Promise-shaped.
  type _EchoBoolIsPromise = Expect<
    Equal<ValuesExports["echoBool"], (v: boolean) => Promise<boolean>>
  >;

  // u64/s64 -> bigint.
  type _EchoU64IsBigint = Expect<
    Equal<ValuesExports["echoU64"], (v: bigint) => Promise<bigint>>
  >;
  type _EchoS64IsBigint = Expect<
    Equal<ValuesExports["echoS64"], (v: bigint) => Promise<bigint>>
  >;

  // list<u8> -> Uint8Array (never a view — always a copy per the contract,
  // untestable at the type level, only the shape is pinned here).
  type _EchoListU8 = Expect<
    Equal<ValuesExports["echoListU8"], (v: Uint8Array) => Promise<Uint8Array>>
  >;
  type _EchoListString = Expect<
    Equal<ValuesExports["echoListString"], (v: string[]) => Promise<string[]>>
  >;

  // tuple<u32,string,f64> -> real TS tuple, not a despecialized record.
  type _EchoTuple = Expect<
    Equal<
      ValuesExports["echoTuple"],
      (v: [number, string, number]) => Promise<[number, string, number]>
    >
  >;

  // option<string>: outermost option -> T | undefined.
  type _EchoOption = Expect<
    Equal<
      ValuesExports["echoOption"],
      (v: string | undefined) => Promise<string | undefined>
    >
  >;

  // option<option<u32>>: outer option -> T | undefined; the option nested
  // directly inside another option boxes into the {kind:"some"|"none"}
  // variant family instead of a second `undefined` — this is the
  // values-fixture Some(None) edge the contract calls out by name.
  type _EchoOptionNested = Expect<
    Equal<
      ValuesExports["echoOptionNested"],
      (
        v: { kind: "some"; value: number } | { kind: "none" } | undefined,
      ) => Promise<{ kind: "some"; value: number } | { kind: "none" } | undefined>
    >
  >;
  const none: ReturnType<ValuesExports["echoOptionNested"]> extends
    Promise<infer T> ? T : never = undefined; // none(): bare undefined
  const someNone: { kind: "none" } = { kind: "none" }; // some(none)
  const someSome: { kind: "some"; value: number } = { kind: "some", value: 7 }; // some(some(7))
  void none;
  void someNone;
  void someSome;

  // result<u32,string> AS A FUNCTION RESULT: resolves to the ok payload,
  // `@throws {ComponentException<string>}` documents the err channel (never part of
  // the resolved value) — contracts/embedder-api.md §"Error model". As a
  // *parameter*, `result` is not in return position, so it keeps the plain
  // `{kind,value}` value shape (same family as `variant`).
  type _EchoResultParamIsKindValue = Expect<
    Equal<
      Parameters<ValuesExports["echoResult"]>[0],
      { kind: "ok"; value: number } | { kind: "err"; value: string }
    >
  >;
  type _EchoResultReturnsOkOnly = Expect<
    Equal<ReturnType<ValuesExports["echoResult"]>, Promise<number>>
  >;

  async function callEchoResult(): Promise<number> {
    try {
      return await exports.echoResult({ kind: "ok", value: 1 });
    } catch (e) {
      // Branded per the error model: an err value crosses only as ComponentException.
      const componentErr = e as ComponentException<string>;
      return componentErr.payload.length;
    }
  }
  void callEchoResult;

  return exports;
}
