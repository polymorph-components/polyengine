// Lifting and lowering of full value lists with spilling (definitions.py
// `## Lifting and Lowering Values`): parameter/result sequences that exceed
// the flat maximum are passed indirectly through a tuple in linear memory.

import { assert_, trapIf } from "./trap.ts";
import { alignment, alignTo, elemSize } from "./layout.ts";
import { load } from "./load.ts";
import { store } from "./store.ts";
import { type CoreValueIter, liftFlat, type ValueIter } from "./lift.ts";
import { lowerFlat } from "./lower.ts";
import { flatCount } from "./flatten.ts";
import { type LiftLowerContext, requireMemory } from "./context.ts";
import { asIndex, borrowedBytes } from "./memory.ts";
import { callDtorGated } from "./handles.ts";
import { dropSharedForTeardown } from "../task/streams.ts";
import {
  type ComponentValue,
  type CoreValue,
  despecialize,
  type TupleType,
  type ValType,
} from "./types.ts";

/**
 * Cleanup for ownership acquired while a prepared host value is transferred.
 * An acquisition remains ours through exact destination-table insertion; only
 * handing the lowered arguments/results to their receiver ends custody.
 */
interface Acquisition {
  cleanup(): void;
  table?: import("./handles.ts").Table<unknown>;
  index?: number;
  entry?: unknown;
}

export interface PreparedTransfer {
  readonly values: ComponentValue[];
  readonly types: ValType[];
  readonly transferFree: boolean;
  transfer(checkpoint: () => void, start?: boolean): ComponentValue[];
  readonly optionalCustody: PreparedCustody | null;
  cleanup(...primary: [] | [unknown]): void;
  delivered(): void;
  start(checkpoint: () => void): void;
}

export class PreparedCustody {
  readonly #acquired: Acquisition[] = [];
  readonly #starts: (() => void)[] = [];
  #insertCursor = 0;
  #finished = false;

  acquire(cleanup: () => void): void {
    if (this.#finished) throw new Error("prepared custody already finished");
    this.#acquired.push({ cleanup });
  }

  deferStart(start: () => void): void {
    this.#starts.push(start);
  }

  start(checkpoint: () => void): void {
    while (this.#starts.length > 0) {
      checkpoint();
      this.#starts.shift()!();
      checkpoint();
    }
  }

  inserted(
    table: import("./handles.ts").Table<unknown>,
    index: number,
    entry: unknown,
  ): void {
    const a = this.#acquired[this.#insertCursor++];
    // Raw-dialect owns have no facade acquisition. They remain governed by
    // the ordinary CABI table lifecycle rather than being guessed into ours.
    if (a === undefined) return;
    a.table = table;
    a.index = index;
    a.entry = entry;
  }

  delivered(): void {
    this.#finished = true;
    this.#starts.length = 0;
    this.#acquired.length = 0;
  }

  cleanup(): void;
  cleanup(primary: unknown): void;
  cleanup(...primaryArgs: [] | [unknown]): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#starts.length = 0;
    let cleanupFailure: unknown;
    let failed = false;
    for (let i = this.#acquired.length - 1; i >= 0; i--) {
      const a = this.#acquired[i];
      try {
        if (a.table !== undefined) {
          // The receiver may legitimately have transferred the handle onward
          // during reentry. Remove only the exact entry still under our custody.
          if (a.table.array[a.index!] !== a.entry) continue;
          a.table.remove(a.index!);
        }
        a.cleanup();
      } catch (e) {
        if (!failed) cleanupFailure = e;
        failed = true;
      }
    }
    this.#acquired.length = 0;
    if (primaryArgs.length === 0 && failed) throw cleanupFailure;
  }
}

/** A private, already-snapshotted host value list. */
export class PreparedValues implements PreparedTransfer {
  readonly transferFree = false;
  #custody: PreparedCustody | null = null;
  #transferred = false;

  constructor(
    readonly values: ComponentValue[],
    readonly types: ValType[],
    readonly transferFn?: (
      values: ComponentValue[],
      types: ValType[],
      custody: PreparedCustody,
      checkpoint: () => void,
    ) => void,
  ) {}

  get custody(): PreparedCustody {
    return this.#custody ??= new PreparedCustody();
  }

  /** Inspect without allocating on transfer-free scalar paths. */
  get optionalCustody(): PreparedCustody | null {
    return this.#custody;
  }

  cleanup(): void;
  cleanup(primary: unknown): void;
  cleanup(...primary: [] | [unknown]): void {
    if (primary.length === 0) this.#custody?.cleanup();
    else this.#custody?.cleanup(primary[0]);
  }

  delivered(): void {
    this.#custody?.delivered();
  }

  start(checkpoint: () => void): void {
    this.#custody?.start(checkpoint);
  }

  transfer(checkpoint: () => void, start = true): ComponentValue[] {
    if (!this.#transferred) {
      if (this.transferFn !== undefined) {
        this.transferFn(this.values, this.types, this.custody, checkpoint);
      }
      this.#transferred = true;
    }
    if (start) this.#custody?.start(checkpoint);
    return this.values;
  }
}

export class TransferFreeValues implements PreparedTransfer {
  readonly optionalCustody = null;
  readonly transferFree = true;

  constructor(readonly values: ComponentValue[], readonly types: ValType[]) {}

  transfer(_checkpoint: () => void, _start = true): ComponentValue[] {
    return this.values;
  }
  cleanup(..._primary: [] | [unknown]): void {}
  delivered(): void {}
  start(_checkpoint: () => void): void {}
}

export function isPreparedTransfer(v: unknown): v is PreparedTransfer {
  return v instanceof PreparedValues || v instanceof TransferFreeValues;
}

/**
 * Snapshot the raw definitions.py dialect. This deliberately performs no
 * facade validation and leaves own/borrow reps and async shared values opaque.
 */
export function prepareRawValues(
  vs: unknown[],
  ts: ValType[],
): PreparedTransfer {
  const out = new Array<ComponentValue>(ts.length);
  for (let i = 0; i < ts.length; i++) out[i] = prepareRawValue(vs[i], ts[i]);
  const transfer = ts.some(hasRawCustody)
    ? (
      values: ComponentValue[],
      types: ValType[],
      custody: PreparedCustody,
      checkpoint: () => void,
    ) => {
      for (let i = 0; i < types.length; i++) {
        acquireRawValue(values[i], types[i], custody, checkpoint);
      }
    }
    : undefined;
  return transfer === undefined
    ? new TransferFreeValues(out, ts)
    : new PreparedValues(out, ts, transfer);
}

const rawCustodyTypes = new WeakMap<object, boolean>();

function hasRawCustody(t: ValType): boolean {
  const key = t as object;
  const hit = rawCustodyTypes.get(key);
  if (hit !== undefined) return hit;
  rawCustodyTypes.set(key, false);
  const d = despecialize(t);
  const answer = d.kind === "own" || d.kind === "stream" ||
    d.kind === "future" ||
    (d.kind === "list" && hasRawCustody(d.element)) ||
    (d.kind === "record" && d.fields.some((f) => hasRawCustody(f.type))) ||
    (d.kind === "variant" &&
      d.cases.some((c) => c.type !== null && hasRawCustody(c.type)));
  rawCustodyTypes.set(key, answer);
  return answer;
}

function prepareRawValue(v: unknown, t: ValType): ComponentValue {
  const d = despecialize(t);
  switch (d.kind) {
    case "bool":
      return Boolean(v);
    case "s8":
    case "u8":
    case "s16":
    case "u16":
    case "s32":
    case "u32":
    case "f32":
    case "f64":
      assert_(typeof v === "number", `${d.kind} value is not a number`);
      return v;
    case "s64":
    case "u64":
      assert_(typeof v === "bigint", `${d.kind} value is not a bigint`);
      return v;
    case "char":
    case "string":
      assert_(typeof v === "string", `${d.kind} value is not a string`);
      return v;
    case "list": {
      if (despecialize(d.element).kind === "u8" && v instanceof Uint8Array) {
        // Contents remain borrowed until CABI has made its one required copy.
        return borrowedBytes(v) as unknown as ComponentValue;
      }
      const src = v as ArrayLike<unknown>;
      const n = src.length;
      const out = new Array<ComponentValue>(n);
      for (let i = 0; i < n; i++) out[i] = prepareRawValue(src[i], d.element);
      return out;
    }
    case "record": {
      const src = v as Record<string, unknown>;
      const out = Object.create(null) as Record<string, ComponentValue>;
      for (const f of d.fields) {
        out[f.label] = prepareRawValue(src[f.label], f.type);
      }
      return out;
    }
    case "variant": {
      const src = v as { kind: string; value: unknown };
      const kind = src.kind;
      const c = d.cases.find((x) => x.label === kind);
      return {
        kind,
        value: c?.type === null || c === undefined
          ? src.value as ComponentValue
          : prepareRawValue(src.value, c.type),
      };
    }
    case "flags": {
      const src = v as Record<string, unknown>;
      const out = Object.create(null) as Record<string, ComponentValue>;
      for (const l of d.labels) out[l] = src[l] as ComponentValue;
      return out;
    }
    default:
      return v as ComponentValue;
  }
}

function acquireRawValue(
  v: ComponentValue,
  t: ValType,
  custody: PreparedCustody,
  checkpoint: () => void,
): void {
  // A mixed composite reaches this routine because some sibling owns custody;
  // do not revisit transfer-free scalar/byte subtrees
  // (docs/architecture.md:343-353).
  if (!hasRawCustody(t)) return;
  const d = despecialize(t);
  switch (d.kind) {
    case "own":
      checkpoint();
      custody.acquire(() => callDtorGated(d.rt.resource, v as number, null));
      return;
    case "stream":
    case "future":
      checkpoint();
      custody.acquire(() => dropSharedForTeardown(v as never));
      return;
    case "list":
      for (const e of v as ComponentValue[]) {
        acquireRawValue(e, d.element, custody, checkpoint);
      }
      return;
    case "record": {
      const record = v as Record<string, ComponentValue>;
      for (const f of d.fields) {
        acquireRawValue(record[f.label], f.type, custody, checkpoint);
      }
      return;
    }
    case "variant": {
      const tagged = v as { kind: string; value: ComponentValue };
      const c = d.cases.find((candidate) => candidate.label === tagged.kind);
      if (c?.type !== null && c !== undefined) {
        acquireRawValue(tagged.value, c.type, custody, checkpoint);
      }
      return;
    }
  }
}

/**
 * Shared spill tuple keyed on parameter/result array identity, allowing both
 * paths to reuse type/layout caches. The array and its types must remain
 * immutable after first use, as for plan-owned ft.params/ft.results.
 */
const spillTuples = new WeakMap<ValType[], TupleType>();

function spillTupleType(ts: ValType[]): TupleType {
  const hit = spillTuples.get(ts);
  if (hit !== undefined) return hit;
  const t: TupleType = { kind: "tuple", elements: ts };
  spillTuples.set(ts, t);
  return t;
}

export function liftFlatValues(
  cx: LiftLowerContext,
  maxFlat: number,
  vi: CoreValueIter,
  ts: ValType[],
): ComponentValue[] {
  if (flatCount(ts, cx.opts) > maxFlat) {
    const mem = requireMemory(cx.opts);
    const ptrRaw = vi.next(mem.ptrType());
    const tupleType = spillTupleType(ts);
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    trapIf(BigInt(ptrRaw) % BigInt(align) !== 0n, "misaligned spill pointer");
    trapIf(
      BigInt(ptrRaw) + BigInt(size) > BigInt(mem.length),
      "spill tuple out of bounds",
    );
    const ptr = asIndex(ptrRaw);
    const tuple = load(cx, ptr, tupleType) as Record<string, ComponentValue>;
    return Object.values(tuple);
  } else {
    return ts.map((t) => liftFlat(cx, vi, t));
  }
}

export function lowerFlatValues(
  cx: LiftLowerContext,
  maxFlat: number,
  vs: ComponentValue[],
  ts: ValType[],
  outParam: ValueIter | null = null,
): CoreValue[] {
  if (flatCount(ts, cx.opts) > maxFlat) {
    const mem = requireMemory(cx.opts);
    const tupleType = spillTupleType(ts);
    const tupleValue: Record<string, ComponentValue> = {};
    vs.forEach((v, i) => {
      tupleValue[String(i)] = v;
    });
    let ptr: number;
    let flatVals: CoreValue[];
    const align = alignment(tupleType, mem.ptrType());
    const size = elemSize(tupleType, mem.ptrType());
    if (outParam === null) {
      ptr = cx.allocate(align, size);
      flatVals = mem.ptrType() === "i32" ? [ptr] : [BigInt(ptr)];
    } else {
      ptr = asIndex(outParam.next(mem.ptrType()));
      flatVals = [];
    }
    trapIf(ptr !== alignTo(ptr, align), "misaligned spill pointer");
    trapIf(ptr + size > mem.length, "spill tuple out of bounds");
    store(cx, tupleValue, tupleType, ptr);
    return flatVals;
  } else {
    const flatVals: CoreValue[] = [];
    for (let i = 0; i < vs.length; i++) {
      flatVals.push(...lowerFlat(cx, vs[i], ts[i]));
    }
    return flatVals;
  }
}
