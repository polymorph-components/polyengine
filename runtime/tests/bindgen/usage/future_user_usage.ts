// Hand-written usage sample for the generated `future-user.ts` facade —
// pins both `future<T>` directions: consuming a future as a parameter
// (widens to `FutureSource<T>`, the accepted-producers union) and producing
// one as an export return value — the latter is an **eager handle** (C2
// amendment, contracts/embedder-api.md §"Streams and futures"): the export
// returns `Future<T>` directly, NOT `Promise<Future<T>>`, because JS
// promise resolution unconditionally adopts thenables (`Future<T>` is
// itself `PromiseLike<T>`), so a Promise can never resolve *to* a `Future`
// handle — that shape is simply not expressible, hence the exception.

import { bind } from "../generated/future-user.ts";
import type { FutureUserExports } from "../generated/future-user.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import type { Future, FutureSource } from "@polyengine/protocol";
import type { Equal, Expect } from "./type_assert.ts";

type _DoubleFutureTakesFutureSource = Expect<
  Equal<
    FutureUserExports["doubleFuture"],
    (f: FutureSource<number>) => Promise<number>
  >
>;
type _MakeFutureReturnsEagerHandle = Expect<
  Equal<FutureUserExports["makeFuture"], (x: number) => Future<number>>
>;

export async function useFutureUser(
  instance: EmbedderInstance,
  f: FutureSource<number>,
) {
  const exports = bind(instance);
  const doubled: number = await exports.doubleFuture(f);
  // No `await` on the outer call: `makeFuture` returns the `Future<number>`
  // handle directly (eager handle, not `Promise<Future<number>>`) — this is
  // how a caller holds onto it (e.g. to `.cancel()` without consuming the
  // value).
  const made: Future<number> = exports.makeFuture(21);
  // `await`ing the handle still yields the value, since `Future<T>` is
  // `PromiseLike<T>` ("await it directly" — contracts/embedder-api.md
  // §"Streams and futures").
  const madeValue: number = await made;
  return { doubled, made, madeValue };
}
