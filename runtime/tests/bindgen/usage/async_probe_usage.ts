// Hand-written usage sample for the generated `async-probe.ts` facade —
// pins `stream<T>`/`future<T>` export param/return typing (param position
// widens to `StreamSource<T>`/`FutureSource<T>`, the accepted-producers
// unions — contracts/embedder-api.md §"Streams and futures": "lowering
// accepts the natural JS producers") and that async WIT funcs are still
// uniformly Promise-shaped as exports.

import { bind } from "../generated/async-probe.ts";
import type { AsyncProbeExports } from "../generated/async-probe.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { FutureSource, StreamSource } from "@polyengine/protocol";
import type { Equal, Expect } from "./type_assert.ts";

type _WaitThenDouble = Expect<
  Equal<AsyncProbeExports["waitThenDouble"], (x: number) => Promise<number>>
>;
type _SumStreamTakesStreamSource = Expect<
  Equal<
    AsyncProbeExports["sumStream"],
    (values: StreamSource<number>) => Promise<bigint>
  >
>;
type _FutureAddTakesFutureSource = Expect<
  Equal<
    AsyncProbeExports["futureAdd"],
    (f: FutureSource<number>, y: number) => Promise<number>
  >
>;

export async function useAsyncProbe(instance: EmbedderInstance) {
  const exports = bind(instance);
  const doubled: number = await exports.waitThenDouble(21);
  return { doubled };
}
