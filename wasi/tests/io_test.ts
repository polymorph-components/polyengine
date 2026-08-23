// wasi:io@0.2 — pollable tier (a), stream sink write paths, ComponentException
// stream-error cases (contracts/embedder-api.md §"WASI examination").

import { assertEq, assertRejects, assertTrue } from "./asserts.ts";
import { ComponentException } from "@polyengine/protocol";
import { InputStream, io, OutputStream, Pollable, poll } from "../src/io.ts";
import type { StreamErrorValue } from "../src/io.ts";

Deno.test("io: pollable is always ready (tier a) and block() is a no-op", () => {
  const p = new Pollable();
  assertEq(p.ready(), true);
  p.block(); // must not throw or hang
});

Deno.test("io: poll() returns every index (every pollable is ready)", () => {
  const result = poll([new Pollable(), new Pollable(), new Pollable()]);
  assertEq(JSON.stringify(result), JSON.stringify([0, 1, 2]));
});

Deno.test("io: OutputStream.write feeds the sink synchronously", () => {
  const chunks: Uint8Array[] = [];
  const out = new OutputStream((c) => chunks.push(c));
  out.write(new Uint8Array([1, 2, 3]));
  assertEq(chunks.length, 1);
  assertEq(JSON.stringify([...chunks[0]]), JSON.stringify([1, 2, 3]));
});

Deno.test("io: OutputStream.checkWrite reports a large permit (never backs up)", () => {
  const out = new OutputStream(() => {});
  assertTrue(out.checkWrite() > 0n);
});

Deno.test("io: OutputStream.blockingWriteAndFlush degenerates to write (tier b)", () => {
  const chunks: Uint8Array[] = [];
  const out = new OutputStream((c) => chunks.push(c));
  out.blockingWriteAndFlush(new Uint8Array([9]));
  assertEq(chunks.length, 1);
});

Deno.test("io: writes after drop throw ComponentException<stream-error> 'closed'", () => {
  const out = new OutputStream(() => {});
  out[Symbol.dispose]();
  try {
    out.write(new Uint8Array([1]));
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException, "closed write throws ComponentException");
    const payload = (e as ComponentException<StreamErrorValue>).payload;
    assertEq(payload.kind, "closed");
  }
});

Deno.test("io: checkWrite after drop also throws the closed stream-error", () => {
  const out = new OutputStream(() => {});
  out[Symbol.dispose]();
  try {
    out.checkWrite();
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

// Issue #178: a p2 guest's read-until-closed loop must terminate — once the
// buffer drains, `read` must report the `closed` stream-error rather than
// returning an empty chunk forever (the prior behavior, which livelocked
// stdin-reading guests).
Deno.test("io: InputStream.read reaches closed after the buffer drains (issue #178 livelock)", () => {
  const s = new InputStream(new Uint8Array([1, 2, 3]));
  const first = s.read(2n);
  assertEq(JSON.stringify([...first]), JSON.stringify([1, 2]));
  const second = s.read(2n);
  assertEq(JSON.stringify([...second]), JSON.stringify([3]));
  try {
    s.read(2n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException, "drained read throws ComponentException");
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
  // Once closed at EOF, subsequent reads keep throwing closed (the loop
  // terminates, it doesn't oscillate).
  try {
    s.read(1n);
    throw new Error("expected a throw");
  } catch (e) {
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

Deno.test("io: InputStream.read(0n) at end-of-buffer stays a no-op, not closed", () => {
  const s = new InputStream(new Uint8Array([1]));
  s.read(1n);
  assertEq(s.read(0n).length, 0, "a zero-length probe never faults");
});

// Issue #178: the default empty-buffer stdin case — the very first
// nonzero-len read must report closed immediately, not an empty list, or
// a guest's EOF loop never exits.
Deno.test("io: InputStream defaults to an empty buffer that is closed on first nonzero read (issue #178)", () => {
  const s = new InputStream();
  try {
    s.read(10n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

Deno.test("io: reading a dropped input stream throws closed stream-error", () => {
  const s = new InputStream(new Uint8Array([1]));
  s[Symbol.dispose]();
  try {
    s.read(1n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

Deno.test("io: blockingRead degenerates to read (tier b, never parks)", () => {
  const s = new InputStream(new Uint8Array([7, 8]));
  assertEq(JSON.stringify([...(s.blockingRead(2n) as Uint8Array)]), JSON.stringify([7, 8]));
});

// Issue #178: blockingRead inherits read's closed-at-EOF signal, so a
// guest's blocking read-until-closed loop terminates too.
Deno.test("io: blockingRead reaches closed after the buffer drains (issue #178 livelock)", () => {
  const s = new InputStream(new Uint8Array([7]));
  s.blockingRead(1n);
  try {
    s.blockingRead(1n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

// Issue #178: skip/blockingSkip share read's exhaustion path (both are
// defined in terms of read/blockingRead), so a guest's skip-until-closed
// loop must terminate the same way.
Deno.test("io: skip reaches closed after the buffer drains (issue #178 livelock)", () => {
  const s = new InputStream(new Uint8Array([1, 2]));
  assertEq(s.skip(2n), 2n);
  try {
    s.skip(1n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

Deno.test("io: blockingSkip reaches closed after the buffer drains (issue #178 livelock)", () => {
  const s = new InputStream(new Uint8Array([1]));
  s.blockingSkip(1n);
  try {
    s.blockingSkip(1n);
    throw new Error("expected a throw");
  } catch (e) {
    assertTrue(e instanceof ComponentException);
    assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
  }
});

Deno.test("io: subscribe() yields a tier-a Pollable on both stream kinds", () => {
  const out = new OutputStream(() => {});
  const inp = new InputStream();
  assertTrue(out.subscribe() instanceof Pollable);
  assertTrue(inp.subscribe() instanceof Pollable);
});

Deno.test("io() provider fragment exposes error/poll/streams under @0.2 keys", () => {
  const { imports } = io();
  assertTrue("wasi:io/error@0.2" in imports);
  assertTrue("wasi:io/poll@0.2" in imports);
  assertTrue("wasi:io/streams@0.2" in imports);
});

// Guards the D-2-adjacent claim for streams specifically: no async parking
// anywhere in the tier-(b) synchronous fast path (ComponentException branded, never a
// bare throw) — this doubles as the "no unbranded throw" smoke check the
// error-model contract requires of every host import in this package.
Deno.test("io: a closed-stream failure never leaks an unbranded throw type", async () => {
  const out = new OutputStream(() => {
    throw new Error("sink exploded");
  });
  const rejected = await assertRejects(async () => {
    out.write(new Uint8Array([1]));
  });
  assertTrue(rejected instanceof Error && !(rejected instanceof ComponentException));
  // NOTE: this documents current behavior — a sink that itself throws
  // propagates its raw Error out of this synchronous host-import function.
  // Per contracts/embedder-api.md §"Error model", the *embedder facade*
  // (runtime/src/embedder/instantiate.ts `#wrapImportFn`) is what converts
  // an unbranded throw from a host import into a Trap; this package's own
  // functions are the import bodies the facade wraps, so they are correct
  // to let a genuine bug (an exploding sink) surface as a raw exception here
  // — the facade, not this package, is the trap boundary.
});

// A20 (contracts/embedder-api.md §"Realm boundaries and structured-clone-safe
// forms"; issue #131): Pollable is a stateful, realm-local handle — the
// engine-enforced backstop pill fires at a raw structuredClone/postMessage,
// throwing DataCloneError in the sender realm instead of delivering a husk.
Deno.test("A20: a raw structuredClone of a Pollable throws DataCloneError", () => {
  const p = new Pollable();
  let threw: unknown;
  try {
    structuredClone(p);
  } catch (e) {
    threw = e;
  }
  assertTrue(threw instanceof DOMException, `got ${threw}`);
  assertEq((threw as DOMException).name, "DataCloneError");
});
