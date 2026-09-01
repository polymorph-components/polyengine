// Hand-written usage sample for `@polyengine/runtime/embedder`'s `Sync<F>`
// type and `sync()` adapter (contracts/embedder-api.md §"Functions and
// async", §"Functions and async") — pins how the sync VIEW type maps generated
// facade shapes: plain export functions, an exports-record interface,
// and a resource class. Runtime behavior of `sync()` is already covered
// by runtime/tests/embedder/sync_adapter_test.ts; this file is
// TYPE-only (`deno check`).

import { bind } from "../generated/values.ts";
import type { ValuesExports } from "../generated/values.ts";
import { bind as bindResources } from "../generated/resources.ts";
import type { Counter, ResourcesExports } from "../generated/resources.ts";
import { bind as bindFutureUser } from "../generated/future-user.ts";
import type { FutureUserExports } from "../generated/future-user.ts";
import type { EmbedderInstance } from "../../../src/embedder/mod.ts";
import { sync } from "../../../src/embedder/mod.ts";
import type { Sync } from "../../../src/embedder/mod.ts";
import type { Future } from "@polyengine/protocol";
import type { Equal, Expect } from "./type_assert.ts";

export function useSync(instance: EmbedderInstance) {
  const exports: ValuesExports = bind(instance);

  // sync(fn) on a plain Promise-returning export: strips the Promise,
  // keeps the parameter list (sync() `sync(fn)` bullet).
  const syncEchoBool = sync(exports.echoBool);
  type _SyncEchoBoolIsPlain = Expect<
    Equal<typeof syncEchoBool, (v: boolean) => boolean>
  >;
  const echoed: boolean = syncEchoBool(true); // not a Promise: no `await`
  void echoed;

  // Sync<F> on the whole exports interface: every member is mapped
  // recursively, same as `sync(record)` at runtime — this is the DEFECT
  // fixed in sync.ts (a named interface has no implicit index signature,
  // so the naive `F extends Record<string, unknown>` branch used to miss
  // it and leave the view Promise-shaped).
  type _SyncedValuesExports = Sync<ValuesExports>;
  type _SyncedEchoBoolIsPlain = Expect<
    Equal<_SyncedValuesExports["echoBool"], (v: boolean) => boolean>
  >;
  type _SyncedEchoU64IsPlain = Expect<
    Equal<_SyncedValuesExports["echoU64"], (v: bigint) => bigint>
  >;

  return { syncEchoBool };
}

export function useSyncResources(instance: EmbedderInstance) {
  const exports: ResourcesExports = bindResources(instance);

  // Sync<Counter>: a class-instance type (not an object literal) is the
  // other half of the defect this fixture pins — methods map Promise<T> ->
  // T, and a non-Promise member ([Symbol.dispose]/`drop`, if present on
  // the generated fixture) passes through unchanged rather than being
  // destructured by the mapped-type's call-signature branch.
  type _SyncedCounter = Sync<Counter>;
  type _SyncedIncrementIsPlain = Expect<
    Equal<_SyncedCounter["increment"], () => bigint>
  >;
  type _SyncedGetIsPlain = Expect<
    Equal<_SyncedCounter["get"], () => bigint>
  >;
  // `[Symbol.dispose]` is already non-Promise-returning (`() => void`):
  // Sync<F>'s function-passthrough branch (checked before the object/
  // mapped-type branch) must leave it exactly as-is, not attempt to map
  // over its call signature.
  type _SyncedDisposeUnchanged = Expect<
    Equal<
      _SyncedCounter[typeof Symbol.dispose],
      Counter[typeof Symbol.dispose]
    >
  >;

  void exports;
}

export function useSyncFutureUser(instance: EmbedderInstance) {
  const exports: FutureUserExports = bindFutureUser(instance);

  // A Future<T>-returning export is already an eager handle (not
  // Promise<Future<T>>, per future_user_usage.ts) — CORRECT per sync() that
  // Sync<F> passes it through unchanged: the sync form of a handle-valued
  // result IS the eager handle, there is nothing further to strip.
  type _SyncedMakeFutureUnchanged = Expect<
    Equal<Sync<FutureUserExports["makeFuture"]>, (x: number) => Future<number>>
  >;

  void exports;
}
