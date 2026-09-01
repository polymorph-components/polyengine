// Leg 4 (best-effort, translate-only) — the polymorph-websocket
// conformance suite.
//
//   deno run --allow-read leg4_websocket.ts
//
// Both artifacts were ALREADY BUILT in the consumer tree (see
// polymorph-websocket/conformance/driver-ct/justfile `compose-suite`), so this
// leg only reads them — nothing here builds, composes, or writes anything in
// the consumer working trees.
//
//   bare:     target/wasm32-wasip2/release/conformance_guest_ct.wasm
//             — the suite with `polymorph:websocket` still IMPORTED. Its
//               import surface is the definitive minimal shim list.
//   composed: target/wasm32-wasip2/release/composed/conformance_guest_ct.wasm
//             — `wac plug`ged with the guest provider + the TLS component, so
//               websocket is satisfied in-guest and only WASI (incl. sockets)
//               remains. This is the shape a Deno-native leg would run.
//
// Deliverable: the enumerated, interface-by-interface import surface of each.

import {
  fmtSurface,
  loadTranslator,
  planShape,
  POLYMORPH,
  readArtifact,
  sha256Hex,
  translateOnce,
} from "./common.ts";

const WS = `${POLYMORPH}/polymorph-websocket/target/wasm32-wasip2/release`;
const TARGETS: Array<[string, string]> = [
  ["bare suite (websocket imported)", `${WS}/conformance_guest_ct.wasm`],
  ["composed suite (provider + TLS plugged)", `${WS}/composed/conformance_guest_ct.wasm`],
  ["websocket guest provider", `${WS}/websocket_guest_provider.wasm`],
];

console.log("=== Leg 4: polymorph-websocket conformance suite (translate-only) ===\n");

let failures = 0;
for (const [label, path] of TARGETS) {
  console.log(`--- ${label}`);
  console.log(`    ${path}`);
  let bytes: Uint8Array;
  try {
    bytes = await readArtifact(path);
  } catch (e) {
    console.log(`    SKIP — not present: ${e}`);
    continue;
  }
  console.log(`    bytes:  ${bytes.length}`);
  console.log(`    sha256: ${await sha256Hex(bytes)}`);

  const t = await loadTranslator();
  const cold = translateOnce(t, bytes);
  const warm: number[] = [];
  for (let i = 0; i < 3; i++) warm.push(translateOnce(t, bytes).ms);
  if (!cold.ok) {
    failures++;
    console.log(`    VERDICT: REJECTED [${cold.errorPhase}]`);
    console.log(`      message: ${cold.errorMessage}`);
    console.log(`      detail:  ${cold.errorDetail}`);
    console.log();
    continue;
  }
  console.log(
    `    VERDICT: ACCEPTED — cold ${cold.ms.toFixed(1)} ms, warm ${
      warm.map((w) => w.toFixed(1)).join("/")
    } ms, envelope ${cold.envelopeBytes} B`,
  );
  console.log(`    ${planShape(cold.plan!)}`);
  console.log(`    exports:`);
  for (const e of cold.plan!.exports) console.log(`      ${e.kind} ${e.name}`);
  console.log(`    IMPORT SURFACE (the shim shopping list):`);
  console.log(fmtSurface(cold.plan!));
  console.log();
}

console.log(`leg4 verdict: ${failures === 0 ? "PASS (all translated)" : `FAIL (${failures} rejected)`}`);
if (failures > 0) Deno.exit(1);
