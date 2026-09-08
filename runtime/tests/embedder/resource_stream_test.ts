// Streams whose elements are OWNED HOST RESOURCES — the wasi:sockets@0.3
// TCP `listen` shape (`func() -> result<stream<tcp-socket>, error-code>`),
// probed via the `resource-stream` fixture with a one-u32 `ticket`
// resource.
//
// Pinned properties (contracts/embedder-api.md §"Streams and futures"):
//   * host-minted instances lower as `own` stream elements and arrive in
//     the guest as live handles (methods dispatch on them);
//   * each guest-side drop runs the host dtor — element handles are real
//     own<R> handles, not copies;
//   * elements the producer LOWERED but the reader never TOOK (the guest
//     dropped its read end mid-stream) are released, dtors run — never
//     leaked. This is what makes a `listen` provider safe: an un-taken
//     element is a live accepted connection that must be closed.

import { assertEq } from "../support/asserts.ts";
import { caught, guest, haveFixture, instantiateFixture } from "./support.ts";
import { createStream } from "../../src/embedder/mod.ts";
import type { Stream } from "@polyengine/protocol";
import { PeerTrappedError, StreamProducerError } from "@polyengine/protocol";

const FIXTURE = guest("resource-stream");
const have = await haveFixture(FIXTURE);
const hostFixture = "runtime/tests/embedder/stream-host.wasm";
const haveHost = await haveFixture(hostFixture);

class Ticket {
  static disposed: number[] = [];
  static created = 0;
  readonly v: number;
  constructor(v: number) {
    this.v = v;
    Ticket.created++;
  }
  value(): number {
    return this.v;
  }
  [Symbol.dispose](): void {
    Ticket.disposed.push(this.v);
  }
}

function reset(): void {
  Ticket.disposed = [];
  Ticket.created = 0;
}

for (const mode of ["pump", "write", "writeAll"] as const) {
  Deno.test({
    name:
      `resource streams: ${mode} packing failure releases lowered prefix exactly once`,
    ignore: !haveHost,
    async fn() {
      reset();
      const c = await instantiateFixture(hostFixture, {
        "host:streams/api": { ticket: Ticket },
      });
      const first = new Ticket(1);
      if (mode === "pump") {
        let out: Stream<Ticket> | undefined;
        const error = await caught(async () => {
          out = await c.exports.passTickets([[first, null]]);
          await out!.read(1);
        });
        assertEq(error instanceof StreamProducerError, true, String(error));
        out?.drop();
      } else {
        const { stream, writer } = createStream<Ticket>();
        const out = await c.exports.passTickets(stream) as Stream<Ticket>;
        assertEq(
          await caught(() => writer[mode]([first, null as never])) instanceof
            TypeError,
          true,
        );
        assertEq(Ticket.disposed, [1]);
        const retry = writer[mode]([new Ticket(2)]);
        const [ticket] = await out.read(1);
        assertEq(ticket.v, 2);
        assertEq(await retry, 1);
        ticket[Symbol.dispose]();
        await writer.close();
        out.drop();
      }
      assertEq(Ticket.disposed, mode === "pump" ? [1] : [1, 2]);
    },
  });
}

for (const mode of ["pump", "write", "writeAll"] as const) {
  for (const trap of [false, true]) {
    Deno.test({
      name:
        `resource streams: ${mode} releases only the untaken tail on guest ${
          trap ? "fault" : "drop"
        }`,
      ignore: !haveHost,
      async fn() {
        reset();
        const c = await instantiateFixture(hostFixture, {
          "host:streams/api": { ticket: Ticket },
        });
        const { stream, writer } = createStream<Ticket>();
        const out = await c.exports.passTickets(
          mode === "pump" ? [[new Ticket(1), new Ticket(2)]] : stream,
        ) as Stream<Ticket>;
        const pending = mode === "pump"
          ? null
          : writer[mode]([new Ticket(1), new Ticket(2)]);
        // Writer methods bind asynchronously; the fixture takes one element
        // synchronously, so let this offer park before entering the guest.
        await Promise.resolve();
        const error = await caught(() => c.exports.takeTicket(out, trap));
        assertEq(error instanceof Error, trap, String(error));
        if (pending !== null) {
          if (trap) {
            const fault = await caught(() => pending);
            assertEq(fault instanceof PeerTrappedError, true, String(fault));
            assertEq((fault as PeerTrappedError).progress, 1);
          } else {
            assertEq(await pending, 1);
          }
        }
        // Pump cleanup has a generator-finally continuation after the write.
        await new Promise((r) => setTimeout(r, 0));
        assertEq(
          Ticket.disposed.sort(),
          [1, 2],
          "delivered guest drop and untaken cleanup each run once",
        );
      },
    });
  }
}

for (const mode of ["write", "writeAll"] as const) {
  Deno.test({
    name:
      `resource streams: ${mode} cancellation releases only untaken owns and permits retry`,
    ignore: !haveHost,
    async fn() {
      reset();
      const c = await instantiateFixture(hostFixture, {
        "host:streams/api": { ticket: Ticket },
      });
      const { stream, writer } = createStream<Ticket>();
      const out = await c.exports.passTickets(stream) as Stream<Ticket>;
      const pending = writer[mode]([new Ticket(1), new Ticket(2)]);
      await Promise.resolve();
      const [delivered] = await out.read(1);
      assertEq(Ticket.disposed, []);
      writer.cancelWrite();
      assertEq(await pending, 1);
      assertEq(Ticket.disposed, [2]);
      const retry = writer[mode]([new Ticket(3)]);
      const [next] = await out.read(1);
      assertEq(next.v, 3);
      assertEq(await retry, 1);
      delivered[Symbol.dispose]();
      next[Symbol.dispose]();
      await writer.close();
      out.drop();
      assertEq(Ticket.disposed.sort(), [1, 2, 3]);
    },
  });
}

Deno.test({
  name:
    "resource streams: packing rollback continues after a destructor throws",
  ignore: !haveHost,
  async fn() {
    reset();
    class ThrowingTicket extends Ticket {
      override [Symbol.dispose](): void {
        super[Symbol.dispose]();
        if (this.v === 1) throw new Error("ticket disposal failed");
      }
    }
    const c = await instantiateFixture(hostFixture, {
      "host:streams/api": { ticket: ThrowingTicket },
    });
    const { stream, writer } = createStream<ThrowingTicket>();
    const out = await c.exports.passTickets(stream) as Stream<ThrowingTicket>;
    const error = await caught(() =>
      writer.write([
        new ThrowingTicket(1),
        new ThrowingTicket(2),
        null as never,
      ])
    );
    assertEq(
      error instanceof TypeError,
      true,
      "packing error keeps attribution",
    );
    assertEq(Ticket.disposed, [1, 2]);
    await writer.close();
    out.drop();
  },
});

Deno.test({
  name: "resource streams: pump reports tail cleanup throwing undefined",
  ignore: !haveHost,
  async fn() {
    reset();
    class ThrowingTicket extends Ticket {
      override [Symbol.dispose](): void {
        super[Symbol.dispose]();
        if (this.v === 2) throw undefined;
      }
    }
    const c = await instantiateFixture(hostFixture, {
      "host:streams/api": { ticket: ThrowingTicket },
    });
    const out = await c.exports.passTickets([[
      new ThrowingTicket(1),
      new ThrowingTicket(2),
      new ThrowingTicket(3),
    ]]) as Stream<ThrowingTicket>;
    const [delivered] = await out.read(1);
    out.drop();
    await new Promise((r) => setTimeout(r, 0));
    const error = await caught(() => out.read(1));
    assertEq(
      error instanceof StreamProducerError,
      true,
      "cleanup fault is not clean EOS",
    );
    assertEq((error as StreamProducerError).cause, undefined);
    assertEq(
      Ticket.disposed,
      [2, 3],
      "cleanup continues past the throwing tail",
    );
    delivered[Symbol.dispose]();
    assertEq(
      Ticket.disposed,
      [2, 3, 1],
      "delivered own belongs only to its receiver",
    );
  },
});

for (const trap of [false, true]) {
  Deno.test({
    name: `resource streams: throwing tail cleanup ${
      trap ? "preserves peer fault" : "surfaces its own failure"
    }`,
    ignore: !haveHost,
    async fn() {
      reset();
      class ThrowingTicket extends Ticket {
        override [Symbol.dispose](): void {
          super[Symbol.dispose]();
          if (this.v === 2) throw new Error("ticket disposal failed");
        }
      }
      const c = await instantiateFixture(hostFixture, {
        "host:streams/api": { ticket: ThrowingTicket },
      });
      const { stream, writer } = createStream<ThrowingTicket>();
      const out = await c.exports.passTickets(stream) as Stream<ThrowingTicket>;
      const pending = writer.writeAll([
        new ThrowingTicket(1),
        new ThrowingTicket(2),
        new ThrowingTicket(3),
      ]);
      await Promise.resolve();
      await caught(() => c.exports.takeTicket(out, trap));
      const error = await caught(() => pending);
      if (trap) {
        assertEq(error instanceof PeerTrappedError, true, String(error));
        assertEq((error as PeerTrappedError).progress, 1);
      } else {
        assertEq(String(error).includes("ticket disposal failed"), true);
      }
      assertEq(
        Ticket.disposed,
        [1, 2, 3],
        "all tails released, delivered own dropped only by guest",
      );
    },
  });
}

Deno.test({
  name:
    "resource streams: writer arriving second releases its short-write tail",
  ignore: !haveHost,
  async fn() {
    reset();
    const c = await instantiateFixture(hostFixture, {
      "host:streams/api": { ticket: Ticket },
    });
    const { stream, writer } = createStream<Ticket>();
    const out = await c.exports.passTickets(stream) as Stream<Ticket>;
    const read = out.read(1);
    assertEq(await writer.write([new Ticket(1), new Ticket(2)]), 1);
    assertEq(Ticket.disposed, [2]);
    (await read)[0][Symbol.dispose]();
    await writer.close();
    out.drop();
    assertEq(Ticket.disposed.sort(), [1, 2]);
  },
});

/** One ticket per chunk: the pump lowers (and parks on) one element at a time. */
function ticketSource(count: number): AsyncIterable<Ticket> {
  return (async function* () {
    for (let i = 1; i <= count; i++) yield new Ticket(i);
  })();
}

Deno.test({
  name:
    "resource streams: own<R> elements arrive live; each guest drop runs the dtor",
  ignore: !have,
  async fn() {
    reset();
    const c = await instantiateFixture(FIXTURE, {
      ticket: Ticket,
      tickets: (count: number) => ticketSource(count),
    });
    // sum-tickets drains 1..4, calling value() on each and dropping it.
    assertEq(await c.exports.sumTickets(4), 10);
    assertEq(Ticket.created, 4);
    assertEq(
      [...Ticket.disposed].sort((a, b) => a - b),
      [1, 2, 3, 4],
      "every element's dtor ran on the guest's drop",
    );
  },
});

Deno.test({
  name:
    "resource streams: un-taken elements are released when the reader drops",
  ignore: !have,
  async fn() {
    reset();
    const c = await instantiateFixture(FIXTURE, {
      ticket: Ticket,
      tickets: (count: number) => ticketSource(count),
    });
    // take-then-drop reads 2 of a long stream, then drops the reader. The
    // producer had already lowered the next element into the parked write;
    // that element must be released (dtor run), and the producer's
    // generator must be retired so no further tickets are minted.
    assertEq(await c.exports.takeThenDrop(100, 2), 3); // 1 + 2
    // Let the pump's teardown settle.
    await new Promise((r) => setTimeout(r, 20));
    assertEq(
      Ticket.created <= 4,
      true,
      `production stops at the drop (created ${Ticket.created})`,
    );
    assertEq(
      Ticket.created,
      Ticket.disposed.length,
      `every created ticket is disposed (created ${Ticket.created}, ` +
        `disposed [${Ticket.disposed.join(",")}])`,
    );
  },
});

Deno.test({
  name:
    "resource streams: a parked producer is cancel()ed when the reader drops (the accept shape)",
  ignore: !have,
  async fn() {
    reset();
    let cancelled = false;
    let unpark!: () => void;
    const parked = new Promise<Ticket | null>((r) => (unpark = () => r(null)));
    // The accept shape: after one element the producer parks on an external
    // event (a listener's accept()); its cancel() — the resource stream producer-
    // cancellation hook — settles the park, standing in for closing the
    // listener.
    const source = (async function* () {
      yield new Ticket(1);
      const next = await parked;
      if (next !== null) yield next;
    })();
    const c = await instantiateFixture(FIXTURE, {
      ticket: Ticket,
      tickets: () =>
        Object.assign(source, {
          cancel: () => {
            cancelled = true;
            unpark();
          },
        }),
    });
    // The guest takes the one element, then drops the reader while the
    // producer is parked.
    assertEq(await c.exports.takeThenDrop(100, 1), 1);
    await new Promise((r) => setTimeout(r, 20));
    assertEq(cancelled, true, "the pump invoked the producer's cancel()");
    assertEq(
      Ticket.created,
      Ticket.disposed.length,
      `every created ticket is disposed (created ${Ticket.created})`,
    );
  },
});
