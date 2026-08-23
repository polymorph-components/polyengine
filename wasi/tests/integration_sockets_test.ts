// Integration gate: the REAL `wasi:sockets@0.3.0` TCP surface end to end —
// the tcp-echo fixture (examples/guests/tcp-echo, WIT vendored verbatim
// from upstream) instantiated behind the runtime, with the à la carte
// sockets provider serving genuine loopback sockets. This is the composed
// path the unit suites approximate from either side:
//
//   guest wit-bindgen calls -> plan dispatch -> conventions adapter
//   (A12 future results, A13 resource-element streams) -> provider ->
//   Deno sockets -> real TCP -> back
//
// Two legs:
//   * client — the wosh listener's exact driving shape
//     (create/connect/send-stream/receive-stream) against a host echo
//     server, with the onCall log read back as the wire's exact sequence;
//   * server — listen/accept with `stream<tcp-socket>` elements arriving
//     in the guest as live resources, served while NO export call is in
//     flight (the A11 settlement pump drives the detached task), and the
//     guest dropping its accept stream must close the provider's OS
//     listener through the A13 producer-cancellation hook — asserted by
//     the port refusing a fresh dial afterwards.
//
// Skip-if-absent: needs the translator shim (`just shim`) and the guest
// fixture corpus (`just fixtures`), exactly like the runtime's own
// embedder tests.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import type { Future } from "@polyengine/protocol";
import { sockets } from "../src/sockets.ts";

const FIXTURE = new URL(
  "../../examples/guests/build/tcp-echo.component.wasm",
  import.meta.url,
);
const SHIM_WASM = new URL(
  "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
  import.meta.url,
);

async function readIfPresent(path: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

const componentBytes = await readIfPresent(FIXTURE);
const shimWasm = await readIfPresent(SHIM_WASM);
const ready = componentBytes !== null && shimWasm !== null;

// deno-lint-ignore no-explicit-any
async function instantiateFixture(calls?: string[]): Promise<any> {
  const translator = await Translator.create(shimWasm!);
  const { plan, adapters } = translator.translate(componentBytes!);
  return await instantiate({ plan, componentBytes: componentBytes!, adapters }, {
    ...sockets(calls === undefined ? {} : { onCall: (c) => calls.push(c) })
      .imports,
  });
}

/** Write all of `bytes` to a raw conn. */
async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let at = 0;
  while (at < bytes.length) at += await conn.write(bytes.subarray(at));
}

/** Read a raw conn to EOF. */
async function readToEnd(conn: Deno.Conn): Promise<number[]> {
  const buf = new Uint8Array(4096);
  const got: number[] = [];
  for (;;) {
    const n = await conn.read(buf);
    if (n === null) return got;
    got.push(...buf.subarray(0, n));
  }
}

Deno.test({
  name: "integration: guest tcp client echoes through a live loopback server",
  ignore: !ready,
  async fn() {
    const listener = Deno.listen({ transport: "tcp", hostname: "127.0.0.1", port: 0 });
    const { port } = listener.addr as Deno.NetAddr;
    const serverDone = (async () => {
      const conn = await listener.accept();
      const buf = new Uint8Array(4096);
      for (;;) {
        const n = await conn.read(buf);
        if (n === null) break;
        let at = 0;
        while (at < n) at += await conn.write(buf.subarray(at, n));
      }
      conn.close();
      listener.close();
    })();

    const calls: string[] = [];
    const c = await instantiateFixture(calls);
    // A payload larger than one stream chunk, patterned for corruption
    // detection.
    const payload = Uint8Array.from({ length: 8192 }, (_, i) => i % 251);
    const echoed = await c.exports.echoClient(port, payload) as Uint8Array;
    assertEq(echoed.length, payload.length);
    assertEq(
      JSON.stringify([...echoed.subarray(0, 64)]),
      JSON.stringify([...payload.subarray(0, 64)]),
    );
    assertTrue(
      echoed.every((b, i) => b === payload[i]),
      "the echo is byte-identical",
    );
    await serverDone;

    // The guest wire's exact driving sequence (the polymorph-iroh#69 exam
    // idiom): create, connect, then one send and one receive.
    assertEq(
      JSON.stringify(calls),
      JSON.stringify([
        "tcp-socket.create",
        "tcp-socket.connect",
        "tcp-socket.send",
        "tcp-socket.receive",
      ]),
    );
  },
});

Deno.test({
  name:
    "integration: guest tcp server — accepts arrive as live resources; dropping the accept stream closes the listener (A13)",
  ignore: !ready,
  async fn() {
    const c = await instantiateFixture();
    const [port, done] = await c.exports.startEchoServer(2) as [
      number,
      Future<number>,
    ];
    assertTrue(port !== 0, "the guest reports its ephemeral port");

    // Two dials, served by the guest's DETACHED task — no export call is
    // in flight while these echo (A11 settlement pump + stream activity).
    const payloads = [[1, 2, 3], [4, 5, 6, 7]];
    for (const p of payloads) {
      const conn = await Deno.connect({ transport: "tcp", hostname: "127.0.0.1", port });
      await writeAll(conn, Uint8Array.from(p));
      await conn.closeWrite(); // FIN: the guest reads to end, echoes, FINs
      assertEq(JSON.stringify(await readToEnd(conn)), JSON.stringify(p));
      conn.close();
    }

    // The completion future carries the byte total; the guest resolved it
    // AFTER dropping the accept stream and the listener socket.
    assertEq(await done, 7);

    // The A13 chain, observed from the OS: guest dropped its accept
    // stream -> pump cancel -> provider closed the listener -> the port
    // refuses a fresh dial.
    let refused = false;
    try {
      const conn = await Deno.connect({ transport: "tcp", hostname: "127.0.0.1", port });
      conn.close();
    } catch (e) {
      refused = e instanceof Deno.errors.ConnectionRefused;
    }
    assertTrue(refused, "the listener's port refuses new dials after the guest quit");
  },
});
