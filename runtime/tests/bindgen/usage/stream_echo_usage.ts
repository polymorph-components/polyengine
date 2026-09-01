// Hand-written usage sample for the generated `stream-echo.ts` facade —
// pins a function that both consumes AND produces a `stream<T>` in one
// export (the wit-bindgen 0.60 stream-producer-side case): the parameter
// widens to `StreamSource<T>` (accepted producers), the return stays
// `Stream<T>` (streams are unaffected by the future eager-handle rule
// — `Stream` is not thenable) and is still Promise-wrapped as usual.

import { bind } from "../generated/stream-echo.ts";
import type { StreamEchoExports } from "../generated/stream-echo.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { Stream, StreamSource } from "@polyengine/protocol";
import type { Equal, Expect } from "./type_assert.ts";

type _EchoDoubled = Expect<
  Equal<
    StreamEchoExports["echoDoubled"],
    (input: StreamSource<number>) => Promise<Stream<number>>
  >
>;

export async function useStreamEcho(
  instance: EmbedderInstance,
  input: StreamSource<number>,
) {
  const exports = bind(instance);
  const output: Stream<number> = await exports.echoDoubled(input);
  return output;
}
