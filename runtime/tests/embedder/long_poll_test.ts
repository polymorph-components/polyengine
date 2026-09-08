// The long-poll shape: an async-typed export parked on a guest-internal
// waitable is PENDING, not deadlocked (issue #292).
//
// `next()` starts an intra-component `future.read` and returns WAIT. At that
// point nothing is ready and no host call is outstanding, which used to make
// the export driver declare
//   Trap: wasm trap: deadlock detected: event loop cannot make further
//   progress (export 'next': ...)
// It is not a deadlock. definitions.py `canon_lift` runs its trapping driving
// loop only `if not ft.async_` (line 2189): for an async-typed export it
// returns right after the first `thread.resume()` and the driving belongs to
// the embedder's `Store.tick`, which never traps. wasmtime splits the same
// way — `run_concurrent` is `poll_until(trap_on_idle = false)`, so a
// `call_concurrent` future stays pending on idle, and the trapping variant
// backs only the blocking `[Typed]Func::call_async`. Polyengine's
// Promise-shaped export is the `call_concurrent` side, so the Promise stays
// pending until a later driver — here the next export call — finishes the
// task.
//
// Every case runs in both suspension modes: the verdict sites live in three
// different loops (`driveLoop`'s synchronous fall-through and `driveAsync`'s
// two), and plain vs jspi picks different ones.

import { assertEq } from "../support/asserts.ts";
import { caught, haveFixture, instantiateFixture } from "./support.ts";
import { instantiateComponent } from "../../src/exec/executor.ts";
import { Translator } from "../../src/shim/mod.ts";
import { readArtifact } from "./support.ts";

const FIXTURE = "runtime/tests/embedder/long-poll.wasm";
const ready = await haveFixture(FIXTURE);

/** A macrotask turn: what a stalled-vs-pending distinction needs. */
const macrotask = () => new Promise((r) => setTimeout(r, 0));

for (const jspi of [false, true]) {
  const tag = jspi ? "jspi" : "plain";

  Deno.test({
    name:
      `long-poll (${tag}): next() stays pending until a later push() readies it`,
    ignore: !ready,
    fn: async () => {
      const c = await instantiateFixture(FIXTURE, {}, { jspi });
      let settled: unknown = "pending";
      const next = (c.exports.next as () => Promise<number>)();
      next.then((v) => (settled = v), (e) => (settled = e));
      // A full macrotask turn with no driver running: pre-fix this had
      // already rejected with the deadlock trap.
      await macrotask();
      assertEq(settled, "pending", "next() must not settle on its own");
      await (c.exports.push as (v: number) => Promise<void>)(7);
      assertEq(await next, 7);
    },
  });

  Deno.test({
    name: `long-poll (${tag}): the cycle repeats on one instance`,
    ignore: !ready,
    fn: async () => {
      const c = await instantiateFixture(FIXTURE, {}, { jspi });
      const next1 = (c.exports.next as () => Promise<number>)();
      await macrotask();
      await (c.exports.push as (v: number) => Promise<void>)(7);
      assertEq(await next1, 7);
      const next2 = (c.exports.next as () => Promise<number>)();
      await macrotask();
      await (c.exports.push as (v: number) => Promise<void>)(9);
      assertEq(await next2, 9);
    },
  });

  Deno.test({
    name:
      `long-poll (${tag}): a trap while completing next() rejects the pending Promise`,
    ignore: !ready,
    fn: async () => {
      const c = await instantiateFixture(FIXTURE, {}, { jspi });
      const next = (c.exports.next as () => Promise<number>)();
      // Keep the rejection handled from the start: the poisoning listener
      // settles it synchronously, inside `push-bad`'s own driver.
      const nextOutcome = caught(() => next);
      await macrotask();
      // `push-bad` writes the future, which readies `next`'s callback, which
      // traps. `push-bad`'s own call rejects...
      const pushErr = await caught(() =>
        (c.exports.pushBad as (v: number) => Promise<void>)(7)
      );
      assertEq(pushErr !== undefined, true, "push-bad must reject");
      // ...and so must the Promise nobody was driving. Without the poisoning
      // seam this hangs forever (the #66 failure, for lifts).
      const err = await nextOutcome;
      assertEq(err !== undefined, true, "the pending next() must reject");
      assertEq(
        /trap|unreachable/i.test(String(err)),
        true,
        `expected a trap, got: ${err}`,
      );
      // The instance is a corpse from here on.
      const later = await caught(() => (c.exports.next as () => unknown)());
      assertEq(
        String(later).includes("cannot enter component instance"),
        true,
        `expected an entry refusal, got: ${later}`,
      );
    },
  });
}

// The harness's opt-back-in. `invoke` in a wast file is a BLOCKING call, so
// the conformance runner keeps today's trap via `InstantiateInput.trapOnIdle`
// — wasmtime's `run_concurrent_trap_on_idle`. Exercised at the exec level
// because the embedder layer deliberately does not expose the flag.
Deno.test({
  name: "long-poll: trapOnIdle restores the deadlock trap for async exports",
  ignore: !ready,
  fn: async () => {
    const shim = await readArtifact(
      "target/wasm32-unknown-unknown/release/translator_shim.wasm",
    );
    const componentBytes = (await readArtifact(FIXTURE))!;
    const { plan, adapters } = (await Translator.create(shim!)).translate(
      componentBytes,
    );
    const handle = await instantiateComponent({
      plan,
      componentBytes,
      adapters,
      trapOnIdle: true,
    });
    const err = await caught(() => (handle.exports["next"] as () => unknown)());
    assertEq(
      String(err).includes("deadlock detected"),
      true,
      `expected the deadlock trap, got: ${err}`,
    );
  },
});
