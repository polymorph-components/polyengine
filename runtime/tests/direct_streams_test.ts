// Direct-access byte edges at the RAW seam (contracts/embedder-api.md
// §"Streams and futures", §"Streams and futures", 2026-08-22, polyengine#128).
//
// WHAT direct-access byte edge IS
// ===========
//
// For `stream<u8>` only, a host end may park a *direct session* instead of a
// chunk: at every rendezvous with a peer operation of nonzero capacity, the
// session's callback runs exactly once, synchronously, inside the rendezvous,
// against a scoped view of the peer's bytes. When the peer is a guest, that
// view aliases guest linear memory, so the embedder's own `set()` IS the
// single canonical-ABI copy.
//
// The implementation is split in two, and so are these tests:
//
//   * task/streams.ts holds the SEAM — `rendezvousCopy` plus the routing of
//     its three direct outcomes at the two copy sites of
//     `SharedStreamImpl.read`/`.write` (definitions.py:1032/1050). Every
//     non-direct path must stay byte-identical to the reference, which is
//     what the `"chunk"` outcome is: `dst.write(src.read(n))`, verbatim.
//   * exec/host_streams.ts holds the SESSION — the scoped callback object,
//     mark accounting, the `"more"`/`"done"` cadence and the promise.
//
// HOW THE "GUEST" IS MODELLED HERE
// ================================
//
// These tests drive `SharedStreamImpl` directly with real `GuestBuffer`s over
// a real `WebAssembly.Memory`, standing in for the guest's `stream.read` /
// `stream.write` trampoline (intrinsics/stream_builtins.ts `streamCopy`).
// The one simplification: the stand-in reclaims the pending buffer inside
// `on_copy` rather than at event-delivery time. That models the post-pump
// state a real guest reaches — `HostActivity.pump()` runs synchronously
// inside every host operation and delivers the armed event — and it is the
// same model `HostBuffer`-backed host ends already use.

import { assertEq } from "./support/asserts.ts";
import { CopyResult, GuestBuffer, SharedStreamImpl } from "../src/task/mod.ts";
import { LiftLowerContext, mkCanonicalOptions } from "../src/cabi/context.ts";
import type { ValType } from "../src/cabi/types.ts";
import type {
  DirectDestination,
  DirectSource,
} from "../src/exec/host_streams.ts";
import { hostStream } from "../src/exec/mod.ts";

const U8: ValType = { kind: "u8" };
const U32: ValType = { kind: "u32" };

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function caught(p: PromiseLike<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

function caughtSync(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A live `MemInst` over a real `WebAssembly.Memory`
// ---------------------------------------------------------------------------
//
// Structurally what exec/boundary.ts `LiveMemory` is: `bytes`/`view` are
// GETTERS that re-derive from `memory.buffer`, so a `memory.grow` (which
// detaches the old ArrayBuffer) is invisible to holders of the MemInst. That
// is exactly the property direct-access byte edge's "views are re-derived per `remaining()` call"
// rule depends on.

function mkMemory(initial = 1) {
  const memory = new WebAssembly.Memory({ initial });
  const view = {
    addrType: "i32" as const,
    get bytes() {
      return new Uint8Array(memory.buffer);
    },
    get view() {
      return new DataView(memory.buffer);
    },
    get length() {
      return memory.buffer.byteLength;
    },
    ptrType: () => "i32" as const,
    ptrSize: () => 4 as const,
  };
  return { memory, view };
}

function mkCx(view: unknown): LiftLowerContext {
  // deno-lint-ignore no-explicit-any
  return new LiftLowerContext(mkCanonicalOptions({ memory: view as any }));
}

/** One instance sentinel per side; the rendezvous compares them by identity. */
const GUEST_A = Object.freeze({ guest: "a" });
const GUEST_B = Object.freeze({ guest: "b" });

interface GuestOp {
  buf: GuestBuffer;
  /** Events the guest end observed, in order (result + progress at delivery). */
  events: { result: CopyResult; progress: number }[];
}

function guestOp(
  shared: SharedStreamImpl,
  kind: "read" | "write",
  cx: LiftLowerContext,
  ptr: number,
  len: number,
  inst: unknown = GUEST_A,
  t: ValType | null = U8,
): GuestOp {
  const buf = new GuestBuffer(t, cx, ptr, len);
  const events: { result: CopyResult; progress: number }[] = [];
  const onCopy = (reclaim: () => void) => {
    reclaim();
    events.push({ result: CopyResult.COMPLETED, progress: buf.progress });
  };
  const onCopyDone = (result: CopyResult) =>
    events.push({ result, progress: buf.progress });
  if (kind === "read") shared.read(inst, buf, onCopy, onCopyDone);
  else shared.write(inst, buf, onCopy, onCopyDone);
  return { buf, events };
}

/** The bytes of guest memory at `[ptr, ptr+len)`. */
function memBytes(memory: WebAssembly.Memory, ptr: number, len: number) {
  return [...new Uint8Array(memory.buffer, ptr, len)];
}

function fill(memory: WebAssembly.Memory, ptr: number, vs: number[]) {
  new Uint8Array(memory.buffer).set(Uint8Array.from(vs), ptr);
}

// ===========================================================================
// 1. The two arrival orders, both directions
// ===========================================================================

Deno.test("direct-access byte edge writeDirect: parked session, guest read arrives", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  let aliased = false;
  let capacity = -1;
  const session = hs.writable.writeDirect((dest: DirectDestination) => {
    const win = dest.remaining();
    // ONE-COPY PIN: the view the producer is handed IS guest linear memory,
    // so its `set()` is the canonical-ABI copy and nothing else copies.
    aliased = win.buffer === memory.buffer;
    capacity = win.length;
    win.set(Uint8Array.from([7, 8, 9]));
    dest.markWritten(3);
    return "done";
  });

  // The session parks synchronously; only now does the reader arrive.
  const g = guestOp(shared, "read", cx, 64, 5);
  assertEq(await session, 3, "session total");
  assert(aliased, "the destination view aliases the guest's memory buffer");
  // The BUFFER_MAX_LENGTH sentinel the parked session reports to the
  // rendezvous never surfaces: the capacity is the reader's actual remaining.
  assertEq(capacity, 5, "capacity is the reader's remaining, not the sentinel");
  assertEq(memBytes(memory, 64, 5), [7, 8, 9, 0, 0], "bytes land at ptr");
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
  assertEq(g.buf.progress, 3, "the guest read completes with progress 3");
});

Deno.test("direct-access byte edge writeDirect: guest read parked, session arrives", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const g = guestOp(shared, "read", cx, 128, 4);
  let capacity = -1;
  const n = await hs.writable.writeDirect((dest) => {
    capacity = dest.remaining().length;
    dest.remaining().set(Uint8Array.from([1, 2, 3, 4]));
    dest.markWritten(4);
    return "done";
  });
  assertEq(n, 4, "session total");
  assertEq(capacity, 4);
  assertEq(memBytes(memory, 128, 4), [1, 2, 3, 4]);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 4 }]);
});

Deno.test("direct-access byte edge readDirect: parked session, guest write arrives", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  fill(memory, 256, [10, 20, 30]);

  let aliased = false;
  const got: number[] = [];
  const session = hs.readable.readDirect((src: DirectSource) => {
    const win = src.remaining();
    aliased = win.buffer === memory.buffer;
    got.push(...win);
    src.markRead(win.length);
    return "done";
  });

  const g = guestOp(shared, "write", cx, 256, 3);
  assertEq(await session, 3);
  assert(aliased, "the source view aliases the guest's memory buffer");
  assertEq(got, [10, 20, 30]);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
});

Deno.test("direct-access byte edge readDirect: guest write parked, session arrives (partial take)", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  fill(memory, 300, [1, 2, 3, 4, 5, 6]);

  const g = guestOp(shared, "write", cx, 300, 6);
  const got: number[] = [];
  const n = await hs.readable.readDirect((src) => {
    // A PARTIAL take is normal Component Model behaviour: the writer's copy
    // completes with the marked count and it re-offers on its own schedule.
    got.push(...src.remaining().subarray(0, 2));
    src.markRead(2);
    return "done";
  });
  assertEq(n, 2, "session total is the marked prefix");
  assertEq(got, [1, 2]);
  assertEq(
    g.events,
    [{ result: CopyResult.COMPLETED, progress: 2 }],
    "the guest write completes with progress 2, not 6",
  );
});

// ===========================================================================
// 2. Multi-rendezvous sessions
// ===========================================================================

Deno.test('direct-access byte edge: a "more" session drains across several guest reads', async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const payload = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
  let sent = 0;
  const caps: number[] = [];
  const session = hs.writable.writeDirect((dest) => {
    const win = dest.remaining();
    caps.push(win.length);
    const k = Math.min(win.length, payload.length - sent);
    win.set(payload.subarray(sent, sent + k));
    dest.markWritten(k);
    sent += k;
    return sent < payload.length ? "more" : "done";
  });

  // Three guest reads of 3, 3 and 3: the third finds only one byte left.
  const g1 = guestOp(shared, "read", cx, 400, 3);
  const g2 = guestOp(shared, "read", cx, 410, 3);
  const g3 = guestOp(shared, "read", cx, 420, 3);
  assertEq(await session, 7, "session total across three rendezvous");
  assertEq(caps, [3, 3, 3], "each invocation sees the reader's own capacity");
  assertEq(memBytes(memory, 400, 3), [1, 2, 3]);
  assertEq(memBytes(memory, 410, 3), [4, 5, 6]);
  assertEq(memBytes(memory, 420, 3), [7, 0, 0]);
  assertEq(g1.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
  assertEq(g2.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
  assertEq(g3.events, [{ result: CopyResult.COMPLETED, progress: 1 }]);
});

Deno.test('direct-access byte edge: a "more" readDirect session drains across several guest writes', async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  fill(memory, 500, [1, 2, 3]);
  fill(memory, 510, [4, 5, 6]);

  const got: number[] = [];
  const session = hs.readable.readDirect((src) => {
    const win = src.remaining();
    got.push(...win);
    src.markRead(win.length);
    return got.length >= 6 ? "done" : "more";
  });
  const g1 = guestOp(shared, "write", cx, 500, 3);
  const g2 = guestOp(shared, "write", cx, 510, 3);
  assertEq(await session, 6);
  assertEq(got, [1, 2, 3, 4, 5, 6]);
  assertEq(g1.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
  assertEq(g2.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
});

// ===========================================================================
// 3. Retraction — "done" with zero marked
// ===========================================================================

Deno.test("direct-access byte edge retraction: the arriving reader stays parked, with no event", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const session = hs.writable.writeDirect((dest) => {
    // The speculative-park correction: demand arrived while the ring
    // happened to be empty. Nothing marked, so nothing is acknowledged.
    dest.remaining();
    return "done";
  });
  const g = guestOp(shared, "read", cx, 600, 4);
  assertEq(await session, 0, "the session resolves with its running total");
  assertEq(g.events, [], "no event is delivered to the parked reader");

  // The reader is still PARKED: a later chunk write completes it.
  assertEq(await hs.writable.write(Uint8Array.from([5, 6]) as never), 2);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
  assertEq(memBytes(memory, 600, 4), [5, 6, 0, 0]);
});

Deno.test("direct-access byte edge retraction: the parked guest reader is untouched when the session arrives second", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const g = guestOp(shared, "read", cx, 700, 4);
  assertEq(await hs.writable.writeDirect(() => "done"), 0);
  assertEq(g.events, [], "no event for the parked reader");
  assertEq(await hs.writable.write(Uint8Array.from([9]) as never), 1);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 1 }]);
  assertEq(memBytes(memory, 700, 2), [9, 0]);
});

Deno.test("direct-access byte edge retraction: readDirect leaves a parked guest writer parked", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  fill(memory, 800, [3, 4]);

  const g = guestOp(shared, "write", cx, 800, 2);
  assertEq(await hs.readable.readDirect(() => "done"), 0);
  assertEq(g.events, []);
  // Still parked: a chunk read drains it.
  assertEq([...(await hs.readable.read(8)) as unknown as Uint8Array], [3, 4]);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
});

// ===========================================================================
// 4. Misuse — the session fails, the peer survives, the stream lives
// ===========================================================================

Deno.test('direct-access byte edge misuse: "more" with zero marked rejects TypeError', async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const session = hs.writable.writeDirect(() => "more");
  const g = guestOp(shared, "read", cx, 900, 4);
  const e = await caught(session);
  assert(e instanceof TypeError, `TypeError, got ${e}`);
  assert(
    String(e.message).includes("without marking any"),
    `names the rule: ${e}`,
  );
  assertEq(g.events, [], "no event: never a zero-progress COMPLETED copy");
  assertEq(shared.dropped, false, "the stream stays alive");
  // The reader is still parked and the host may fall back to the chunk form.
  assertEq(await hs.writable.write(Uint8Array.from([1, 2]) as never), 2);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
});

Deno.test("direct-access byte edge misuse: a throwing callback rejects and discards its marks", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  const boom = new Error("producer blew up");

  const session = hs.writable.writeDirect((dest) => {
    // Bytes physically written past the acknowledged progress must be
    // unobservable to the peer: the mark is discarded with the throw.
    dest.remaining().set(Uint8Array.from([0xff, 0xff, 0xff]));
    dest.markWritten(3);
    throw boom;
  });
  const g = guestOp(shared, "read", cx, 1000, 4);
  assertEq(await caught(session), boom, "rejects with the callback's error");
  assertEq(g.events, [], "no event");
  assertEq(g.buf.progress, 0, "the peer's progress did not move");

  // The parked reader survives, and a chunk write delivers UNPOLLUTED data:
  // whatever the failed callback scribbled is past the acknowledged
  // progress, so the reader's own copy overwrites it.
  assertEq(await hs.writable.write(Uint8Array.from([1, 2]) as never), 2);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
  assertEq(memBytes(memory, 1000, 2), [1, 2], "peer sees only its own copy");
});

Deno.test("direct-access byte edge misuse: the same failures leave a PARKED guest reader parked", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const g = guestOp(shared, "read", cx, 1100, 4);
  const e = await caught(hs.writable.writeDirect(() => "more"));
  assert(e instanceof TypeError, `TypeError, got ${e}`);
  assertEq(g.events, [], "the parked reader got no event");
  assertEq(await hs.writable.write(Uint8Array.from([4, 5]) as never), 2);
  assertEq(g.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
});

Deno.test("direct-access byte edge misuse: over-marking throws inside the callback", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  let inner: unknown;
  const session = hs.writable.writeDirect((dest) => {
    dest.markWritten(2);
    inner = caughtSync(() => dest.markWritten(3)); // 2 + 3 > 4
    return "done";
  });
  guestOp(shared, "read", cx, 1200, 4);
  assertEq(await session, 2, "only the legal marks were acknowledged");
  assert(inner instanceof TypeError, `TypeError, got ${inner}`);
  assert(
    String((inner as Error).message).includes("cumulative"),
    `names the rule: ${inner}`,
  );

  // Negative / non-integer marks are refused the same way.
  const hs2 = hostStream<number>(U8);
  const shared2 = hs2.value as unknown as SharedStreamImpl;
  let bad: unknown[] = [];
  const s2 = hs2.writable.writeDirect((dest) => {
    bad = [
      caughtSync(() => dest.markWritten(-1)),
      caughtSync(() => dest.markWritten(1.5)),
    ];
    dest.markWritten(1);
    return "done";
  });
  guestOp(shared2, "read", cx, 1300, 4);
  assertEq(await s2, 1);
  assert(bad.every((e) => e instanceof TypeError), `both refused: ${bad}`);
});

Deno.test("direct-access byte edge scoping: the view is dead once the callback returns", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  let escaped: DirectDestination | null = null;
  const session = hs.writable.writeDirect((dest) => {
    escaped = dest;
    dest.markWritten(1);
    return "done";
  });
  guestOp(shared, "read", cx, 1400, 4);
  assertEq(await session, 1);

  const d = escaped as unknown as DirectDestination;
  for (
    const [what, fn] of [
      ["remaining", () => d.remaining()],
      ["markWritten", () => d.markWritten(1)],
    ] as const
  ) {
    const e = caughtSync(fn);
    assert(e instanceof TypeError, `${what} after return: TypeError, got ${e}`);
    assert(
      String(e.message).includes("scoped to the synchronous callback"),
      `${what} names the scoping rule: ${e}`,
    );
  }
});

Deno.test("direct-access byte edge: non-u8 and zero-width element types are refused", () => {
  for (const [label, t] of [["u32", U32], ["zero-width", null]] as const) {
    const hs = hostStream<number>(t);
    const w = caughtSync(() => hs.writable.writeDirect(() => "done"));
    const r = caughtSync(() => hs.readable.readDirect(() => "done"));
    for (const [who, e] of [["writeDirect", w], ["readDirect", r]] as const) {
      assert(e instanceof TypeError, `${label} ${who}: TypeError, got ${e}`);
      assert(
        String(e.message).includes("stream<u8> only"),
        `${label} ${who} names direct-access byte edge's scope: ${e}`,
      );
    }
  }
});

Deno.test("direct-access byte edge: the one-in-flight-per-end rule covers the direct forms", async () => {
  const hs = hostStream<number>(U8);

  // A parked chunk write blocks writeDirect, and vice versa.
  const w = hs.writable.write(Uint8Array.from([1]) as never);
  const e1 = caughtSync(() => hs.writable.writeDirect(() => "done"));
  assert(e1 instanceof TypeError, `write||writeDirect: ${e1}`);
  hs.writable.cancelWrite();
  await w;

  const wd = hs.writable.writeDirect((d) => {
    d.markWritten(0);
    return "done";
  });
  const e2 = caughtSync(() => hs.writable.write(Uint8Array.from([1]) as never));
  assert(e2 instanceof TypeError, `writeDirect||write: ${e2}`);
  const e3 = caughtSync(() => hs.writable.writeDirect(() => "done"));
  assert(e3 instanceof TypeError, `writeDirect||writeDirect: ${e3}`);
  hs.writable.cancelWrite();
  await wd;

  // The read end is independent (that is the pass-through data plane) but
  // has the same rule within itself.
  const r = hs.readable.read(4);
  const e4 = caughtSync(() => hs.readable.readDirect(() => "done"));
  assert(e4 instanceof TypeError, `read||readDirect: ${e4}`);
  hs.readable.cancelRead();
  await r;

  const rd = hs.readable.readDirect(() => "done");
  const e5 = caughtSync(() => hs.readable.read(4));
  assert(e5 instanceof TypeError, `readDirect||read: ${e5}`);
  const e6 = caughtSync(() => hs.readable.readDirect(() => "done"));
  assert(e6 instanceof TypeError, `readDirect||readDirect: ${e6}`);
  hs.readable.cancelRead();
  await rd;
});

// ===========================================================================
// 5. Zero-length probes (Concurrency.md "Stream Readiness")
// ===========================================================================

Deno.test("direct-access byte edge: a zero-length probe completes without invoking the callback", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);

  // Reader direction: a parked writeDirect answers a zero-length read with
  // immediate COMPLETED — the armed session IS the readiness claim.
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  let calls = 0;
  const wsession = hs.writable.writeDirect((d) => {
    calls++;
    d.markWritten(1);
    return "done";
  });
  const probe = guestOp(shared, "read", cx, 1500, 0);
  assertEq(calls, 0, "the producer was not invoked by the probe");
  assertEq(probe.events, [{ result: CopyResult.COMPLETED, progress: 0 }]);
  // The session is still parked, and a real read still drives it.
  const real = guestOp(shared, "read", cx, 1500, 4);
  assertEq(await wsession, 1);
  assertEq(calls, 1);
  assertEq(real.events, [{ result: CopyResult.COMPLETED, progress: 1 }]);

  // Writer direction: a zero-length write against a parked readDirect.
  const hs2 = hostStream<number>(U8);
  const shared2 = hs2.value as unknown as SharedStreamImpl;
  let consumed = 0;
  const rsession = hs2.readable.readDirect((s) => {
    consumed++;
    s.markRead(1);
    return "done";
  });
  const probe2 = guestOp(shared2, "write", cx, 1600, 0);
  assertEq(consumed, 0, "the consumer was not invoked by the probe");
  assertEq(probe2.events, [{ result: CopyResult.COMPLETED, progress: 0 }]);
  guestOp(shared2, "write", cx, 1600, 2);
  assertEq(await rsession, 1);
  assertEq(consumed, 1);
});

// ===========================================================================
// 6. Teardown: drop and cancel
// ===========================================================================

Deno.test("direct-access byte edge: a peer drop mid-session resolves with the running total", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const session = hs.writable.writeDirect((d) => {
    d.markWritten(2);
    return "more";
  });
  guestOp(shared, "read", cx, 1700, 2);
  guestOp(shared, "read", cx, 1710, 2);
  // The reader goes away while the session is still parked.
  shared.drop();
  assertEq(await session, 4, "resolves with everything acknowledged so far");
});

Deno.test("direct-access byte edge: cancelWrite/cancelRead retract a parked session", async () => {
  const { view } = mkMemory();
  const cx = mkCx(view);

  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;
  const w = hs.writable.writeDirect((d) => {
    d.markWritten(1);
    return "more";
  });
  guestOp(shared, "read", cx, 1800, 1);
  hs.writable.cancelWrite();
  assertEq(await w, 1, "cancel resolves with the running total");

  const hs2 = hostStream<number>(U8);
  const r = hs2.readable.readDirect(() => "more");
  hs2.readable.cancelRead();
  assertEq(await r, 0, "a never-rendezvoused session cancels to zero");
});

// ===========================================================================
// 7. External byte movers: a SharedArrayBuffer-backed source
// ===========================================================================

Deno.test("direct-access byte edge: a SAB-backed producer copies straight into the guest view", async () => {
  const { memory, view } = mkMemory();
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  // The motivating shape: bytes live in a shared ring the runtime must never
  // see a second copy of. `set()` from a SAB-backed view into the guest view
  // is the one ABI copy.
  const ring = new Uint8Array(new SharedArrayBuffer(4));
  ring.set([11, 12, 13, 14]);
  const session = hs.writable.writeDirect((dest) => {
    dest.remaining().set(ring);
    dest.markWritten(ring.length);
    return "done";
  });
  guestOp(shared, "read", cx, 1900, 4);
  assertEq(await session, 4);
  assertEq(memBytes(memory, 1900, 4), [11, 12, 13, 14]);
});

// ===========================================================================
// 8. memory.grow between two rendezvous of one parked session
// ===========================================================================

Deno.test("direct-access byte edge: views are re-derived, so memory.grow between rendezvous is safe", async () => {
  const { memory, view } = mkMemory(1);
  const cx = mkCx(view);
  const hs = hostStream<number>(U8);
  const shared = hs.value as unknown as SharedStreamImpl;

  const buffers: ArrayBufferLike[] = [];
  let round = 0;
  const session = hs.writable.writeDirect((dest) => {
    const win = dest.remaining();
    buffers.push(win.buffer);
    win.set(Uint8Array.from([round + 1, round + 1]));
    dest.markWritten(2);
    round++;
    return round < 2 ? "more" : "done";
  });

  const g1 = guestOp(shared, "read", cx, 2000, 2);
  const before = memory.buffer;
  // Growing DETACHES the old ArrayBuffer; a view cached across the rendezvous
  // would be zero-length and its writes would go nowhere.
  memory.grow(1);
  assert(memory.buffer !== before, "grow produced a fresh buffer");
  const hiPtr = 65536 + 16;
  const g2 = guestOp(shared, "read", cx, hiPtr, 2);
  assertEq(await session, 4);

  assertEq(buffers[0] === before, true, "first view was over the old buffer");
  assertEq(
    buffers[1] === memory.buffer,
    true,
    "second view is over the NEW buffer",
  );
  assertEq(g1.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
  assertEq(g2.events, [{ result: CopyResult.COMPLETED, progress: 2 }]);
  assertEq(memBytes(memory, hiPtr, 2), [2, 2], "the second copy landed");
});

// ===========================================================================
// 9. Host <-> host (contract: "at the same floor")
// ===========================================================================

Deno.test("direct-access byte edge host<->host: writeDirect against a chunk read(max)", async () => {
  // Both arrival orders; the marked prefix of the scratch becomes the
  // delivered chunk, handed through `taken()` unsliced.
  for (const order of ["read-first", "direct-first"] as const) {
    const hs = hostStream<number>(U8);
    let cap = -1;
    const produce = (d: DirectDestination) => {
      cap = d.remaining().length;
      d.remaining().set(Uint8Array.from([1, 2, 3]));
      d.markWritten(3);
      return "done" as const;
    };
    let chunk: Promise<number[]>, session: Promise<number>;
    if (order === "read-first") {
      chunk = hs.readable.read(8) as unknown as Promise<number[]>;
      session = hs.writable.writeDirect(produce);
    } else {
      session = hs.writable.writeDirect(produce);
      chunk = hs.readable.read(8) as unknown as Promise<number[]>;
    }
    const got = await chunk as unknown as Uint8Array;
    assertEq(await session, 3, `${order}: session total`);
    assertEq(cap, 8, `${order}: capacity is the reader's max`);
    assertEq(got instanceof Uint8Array, true, `${order}: u8 chunk shape`);
    assertEq([...got], [1, 2, 3], `${order}: payload`);
  }
});

Deno.test("direct-access byte edge host<->host: readDirect against a chunk write borrows the offered chunk", async () => {
  for (const order of ["write-first", "direct-first"] as const) {
    const hs = hostStream<number>(U8);
    const offered = Uint8Array.from([4, 5, 6, 7]);
    let aliased = false;
    const got: number[] = [];
    const consume = (s: DirectSource) => {
      const win = s.remaining();
      // ZERO extra copy: the window IS the offered chunk (the stream/future round-trip borrow,
      // scoped to the callback).
      aliased = win.buffer === offered.buffer;
      got.push(...win);
      s.markRead(win.length);
      return "done" as const;
    };
    let w: Promise<number>, session: Promise<number>;
    if (order === "write-first") {
      w = hs.writable.write(offered as never);
      session = hs.readable.readDirect(consume);
    } else {
      session = hs.readable.readDirect(consume);
      w = hs.writable.write(offered as never);
    }
    assertEq(await session, 4, `${order}: session total`);
    assertEq(await w, 4, `${order}: the chunk write completes`);
    assert(aliased, `${order}: the view aliases the offered chunk`);
    assertEq(got, [4, 5, 6, 7], `${order}: payload`);
  }
});

Deno.test("direct-access byte edge host<->host: two direct sessions cannot rendezvous", async () => {
  const hs = hostStream<number>(U8);
  let produced = 0;
  const w = hs.writable.writeDirect((d) => {
    produced++;
    d.remaining().set(Uint8Array.from([42]));
    d.markWritten(1);
    return "more";
  });
  // The ARRIVING side is the one refused.
  const e = await caught(hs.readable.readDirect(() => "done"));
  assert(e instanceof TypeError, `TypeError, got ${e}`);
  assert(
    String(e.message).includes("at least one side"),
    `names the rule: ${e}`,
  );
  assertEq(produced, 0, "the parked producer was never invoked");

  // The parked session is undisturbed: a chunk read still drives it.
  const got = await hs.readable.read(4) as unknown as Uint8Array;
  assertEq([...got], [42], "the parked writeDirect still serves chunk reads");
  assertEq(produced, 1);
  hs.writable.cancelWrite();
  assertEq(await w, 1);
});

// ===========================================================================
// 10. Parity: the seam collapses to the reference copy when nobody is direct
// ===========================================================================

Deno.test("direct-access byte edge parity: guest<->guest and chunk paths are unchanged", async () => {
  const { memory, view } = mkMemory();
  const cxA = mkCx(view);
  const shared = new SharedStreamImpl(U8);
  fill(memory, 2100, [1, 2, 3, 4, 5]);

  // guest -> guest, partial: `min(remain, remain)` and both sides notified.
  const w = guestOp(shared, "write", cxA, 2100, 5, GUEST_A);
  const r = guestOp(shared, "read", cxA, 2200, 3, GUEST_B);
  assertEq(memBytes(memory, 2200, 3), [1, 2, 3]);
  assertEq(w.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);
  assertEq(r.events, [{ result: CopyResult.COMPLETED, progress: 3 }]);

  // A non-u8 element type still rendezvouses (the seam is u8-blind for
  // chunks; only the DIRECT forms are u8-only).
  const s32 = new SharedStreamImpl(U32);
  const hs32 = hostStream<number>(U32);
  const shared32 = hs32.value as unknown as SharedStreamImpl;
  void s32;
  const pending = hs32.readable.read(4);
  new DataView(memory.buffer).setUint32(2300, 42, true);
  guestOp(shared32, "write", cxA, 2300, 1, GUEST_A, U32);
  assertEq([...await pending], [42]);
});
