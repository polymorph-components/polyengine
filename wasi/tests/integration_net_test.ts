// Integration gate: the REAL `wasi:sockets@0.2` surface end to end —
// the net-probe fixture (examples/guests/net-probe, wasm32-wasip2:
// std::net through wasi-libc) instantiated behind the runtime, with the
// 0.2 sockets track serving real loopback sockets. The composed path a
// ported networking program actually takes:
//
//   std::net -> wasi-libc -> two-phase start/finish ops looping on
//   would-block with pollable.block (the io.ts parking kernel,
//   embedder-api.md §"The WASI parking kernel") ->
//   wasi:io socket streams (non-blocking read + subscribe,
//   check-write/write/blocking-flush) -> node:net / node:dgram
//
// The guest runs a listener + client self-echo over loopback and a UDP
// pair entirely inside itself, so the gate needs no host-side peer.
// Blocking socket ops park: instantiation is jspi (default mode
// selection picks it from the park-capable marks).
//
// Skip-if-absent on the shim + fixture corpus, like the other gates.

import { assertEq, assertTrue } from "./asserts.ts";
import { Translator } from "@polyengine/runtime/shim";
import { instantiate } from "@polyengine/runtime/embedder";
import { wasi } from "../src/mod.ts";
import { sockets } from "../src/sockets.ts";

const FIXTURE = new URL(
  "../../examples/guests/build/net-probe.component.wasm",
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

Deno.test({
  name: "integration: std::net battery over the 0.2 sockets track (self-echo + udp pair)",
  ignore: !ready,
  async fn() {
    const calls: string[] = [];
    const translator = await Translator.create(shimWasm!);
    const { plan, adapters } = translator.translate(componentBytes!);
    const c = await instantiate(
      { plan, componentBytes: componentBytes!, adapters },
      {
        ...wasi(),
        ...sockets({ onCall: (call) => calls.push(call) }).imports,
      },
    );
    const summary = await c.exports.run() as string;
    assertEq(summary, "net probe ok");
    // The driving sequence proves the poll-shaped path was exercised.
    for (const expected of [
      "tcp-create-socket.create-tcp-socket",
      "tcp-socket.start-bind",
      "tcp-socket.finish-bind",
      "tcp-socket.start-listen",
      "tcp-socket.finish-listen",
      "tcp-socket.start-connect",
      "tcp-socket.finish-connect",
      "tcp-socket.accept",
      "tcp-socket.shutdown",
      "udp-create-socket.create-udp-socket",
      "udp-socket.start-bind",
      "udp-socket.stream",
      "incoming-datagram-stream.receive",
      "outgoing-datagram-stream.check-send",
      "outgoing-datagram-stream.send",
    ]) {
      assertTrue(calls.includes(expected), `${expected} dispatched`);
    }
  },
});
