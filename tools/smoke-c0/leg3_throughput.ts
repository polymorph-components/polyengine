// Leg 3 — translator throughput on the multi-MB consumer corpus.
//
//   deno run --allow-read leg3_throughput.ts
//
// Times `translateRaw` cold + 3 warm per artifact, records envelope size and
// plan shape, and dumps `errorDetail` verbatim for rejections (rejections are
// FINDINGS for the consumer-smoke discrepancy table, not failures of this leg).
// Baseline datum: 94 KB component in ~28 ms.

import {
  ARTIFACTS,
  fmtSurface,
  loadTranslator,
  ms,
  planShape,
  readArtifact,
  sha256Hex,
  translateOnce,
} from "./common.ts";

const CORPUS: Array<[string, string]> = [
  ["compose-async-tdz/composed.wasm", ARTIFACTS.tdz],
  ["iroh_exec_model_guest.wasm", ARTIFACTS.execModel],
  ["engine-go/main.wasm", ARTIFACTS.engineGo],
  ["client-core/composed-client.wasm", ARTIFACTS.composedClient],
  ["proxy/composed-proxy.wasm", ARTIFACTS.composedProxy],
  ["iroh_endpoint.wasm", ARTIFACTS.irohEndpoint],
];

const t = await loadTranslator();

console.log("=== Leg 3: translator throughput ===\n");
console.log(
  "| artifact | bytes | sha256[0..16] | cold ms | warm ms (3) | envelope B | verdict |",
);
console.log("|---|---:|---|---:|---|---:|---|");

const rejections: string[] = [];
const shapes: string[] = [];

for (const [label, path] of CORPUS) {
  const bytes = await readArtifact(path);
  const sha = await sha256Hex(bytes);
  const cold = translateOnce(t, bytes);
  const warm: number[] = [];
  for (let i = 0; i < 3; i++) warm.push(translateOnce(t, bytes).ms);
  const verdict = cold.ok ? "ACCEPTED" : `REJECTED [${cold.errorPhase}]`;
  console.log(
    `| ${label} | ${bytes.length} | ${sha.slice(0, 16)} | ${
      cold.ms.toFixed(1)
    } | ${warm.map((w) => w.toFixed(1)).join(", ")} | ${cold.envelopeBytes} | ${verdict} |`,
  );
  if (cold.ok && cold.plan) {
    shapes.push(`--- ${label}\n  ${planShape(cold.plan)}\n${
      cold.plan.imports.length ? fmtSurface(cold.plan) : "  (no imports)"
    }`);
  } else {
    rejections.push(
      `--- ${label}\n  phase:   ${cold.errorPhase}\n  message: ${cold.errorMessage}\n  detail:  ${cold.errorDetail}`,
    );
  }
}

console.log("\n=== plan shapes + import surfaces (accepted) ===");
for (const s of shapes) console.log(s);

console.log("\n=== rejections (verbatim errorDetail) ===");
if (rejections.length === 0) console.log("  (none)");
for (const r of rejections) console.log(r);

console.log(
  `\nleg3 verdict: ${
    rejections.length === 0
      ? `PASS (${CORPUS.length}/${CORPUS.length} accepted, zero rejections)`
      : `${rejections.length} REJECTED — see the errorDetail dumps above (findings, not leg failures)`
  }`,
);
console.log(`leg3 done (${ms(performance.now())} total process time)`);
