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
import { guest, haveFixture, instantiateFixture } from "./support.ts";

const FIXTURE = guest("resource-stream");
const have = await haveFixture(FIXTURE);

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

/** One ticket per chunk: the pump lowers (and parks on) one element at a time. */
function ticketSource(count: number): AsyncIterable<Ticket> {
  return (async function* () {
    for (let i = 1; i <= count; i++) yield new Ticket(i);
  })();
}

Deno.test({
  name: "resource streams: own<R> elements arrive live; each guest drop runs the dtor",
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
  name: "resource streams: un-taken elements are released when the reader drops",
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
