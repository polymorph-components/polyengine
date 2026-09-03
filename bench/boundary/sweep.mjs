// Run the full boundary sweep and print the comparison table. Invoked by
// `just bench-boundary [with-jco]` with the bundle + translator paths;
// lanes: polyengine on plain node (callback + jspi) and deno, plus jco under
// node when the npm tree + transpile are present (with-jco).
//
//   node sweep.mjs <bundle.mjs> <translator.wasm> [--with-jco]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const [bundle, translator, withJco] = process.argv.slice(2);
const SHAPES = ["send", "recv", "send-sync"];
const MODES = ["immediate", "microtask"];
const SIZES = [0, 1200];
const rows = [];

// Stream-shaped lanes (issue #68): calls-per-second doesn't apply — these
// move a payload once via the embedder's Stream rendezvous, so what's
// measured is bytes/s. `chunks * size` is picked per size so a timed run
// lands in the tens-of-ms range (calibrated on the dev box; see
// README.md). polyengine drivers only — jco's p3 stream support isn't under
// test here.
const STREAM_SHAPES = ["stream-sink", "stream-source", "stream-pass"];
const STREAM_CONFIGS = [
  { size: 1200, chunks: 8000 }, // ~9.6 MB/run
  { size: 16384, chunks: 4500 }, // ~74 MB/run
  { size: 262144, chunks: 600 }, // ~150 MB/run
];
const streamRows = [];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: new URL(".", import.meta.url).pathname });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").at(-1));
}

const jco = withJco === "--with-jco" && existsSync(new URL("./generated/bench.js", import.meta.url));
for (const shape of SHAPES) {
  for (const mode of MODES) {
    for (const size of SIZES) {
      rows.push(run("node", ["driver-polyengine.mjs", bundle, translator, shape, mode, "50000", String(size), "5"]));
      rows.push(run("node", ["--experimental-wasm-jspi", "driver-polyengine.mjs", bundle, translator, shape, mode, "20000", String(size), "5", "jspi"]));
      rows.push(run("deno", ["run", "-A", "driver-polyengine.mjs", bundle, translator, shape, mode, "50000", String(size), "5"]));
      if (jco) {
        const iters = shape === "send-sync" ? "50000" : "1500";
        rows.push(run("node", ["--experimental-wasm-jspi", "driver-jco.mjs", shape, mode, iters, String(size), "5"]));
      }
    }
  }
}

for (const shape of STREAM_SHAPES) {
  for (const { size, chunks } of STREAM_CONFIGS) {
    streamRows.push(run("node", ["driver-polyengine.mjs", bundle, translator, shape, "n/a", String(chunks), String(size), "5"]));
    streamRows.push(run("node", ["--experimental-wasm-jspi", "driver-polyengine.mjs", bundle, translator, shape, "n/a", String(chunks), String(size), "5", "jspi"]));
    streamRows.push(run("deno", ["run", "-A", "driver-polyengine.mjs", bundle, translator, shape, "n/a", String(chunks), String(size), "5"]));
    // jco lane skipped: jco's p3 stream support is not under test here.
  }
}

// Compound-element lanes (issue #261): no bulk-copy path exists for these
// (a variant over records — the interpreted per-element lift/lower loop is
// exactly what's under test), so unlike the flat scalar shapes above,
// there's no size dimension — just an element count `n`, calibrated
// (10000) so a timed run lands in the tens-of-ms range on this box.
// polyengine drivers only, same reason as the stream shapes: jco is not
// under test here.
const ELEMENT_SHAPES = ["lift-ops", "lower-ops"];
const ELEMENT_N = 10000;
const elementRows = [];

for (const shape of ELEMENT_SHAPES) {
  elementRows.push(run("node", ["driver-polyengine.mjs", bundle, translator, shape, "n/a", String(ELEMENT_N), "0", "5"]));
  elementRows.push(run("node", ["--experimental-wasm-jspi", "driver-polyengine.mjs", bundle, translator, shape, "n/a", String(ELEMENT_N), "0", "5", "jspi"]));
  elementRows.push(run("deno", ["run", "-A", "driver-polyengine.mjs", bundle, translator, shape, "n/a", String(ELEMENT_N), "0", "5"]));
}

const lanes = [...new Set(rows.map((r) => r.lane))];
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("shape", 10) + pad("mode", 11) + pad("size", 6) + lanes.map((l) => String(l).padStart(22)).join(""));
for (const shape of SHAPES) {
  for (const mode of MODES) {
    for (const size of SIZES) {
      const cells = lanes.map((lane) => {
        const r = rows.find((x) => x.lane === lane && x.shape === shape && x.mode === mode && x.size === size);
        return (r ? `${r.callsPerSec.toLocaleString("en-US")}/s` : "-").padStart(22);
      });
      console.log(pad(shape, 10) + pad(mode, 11) + pad(size, 6) + cells.join(""));
    }
  }
}

console.log();
console.log("stream lanes (bytes/s; jco lane skipped — see README.md):");
const streamLanes = [...new Set(streamRows.map((r) => r.lane))];
console.log(pad("shape", 14) + pad("size", 10) + streamLanes.map((l) => String(l).padStart(22)).join(""));
for (const shape of STREAM_SHAPES) {
  for (const { size } of STREAM_CONFIGS) {
    const cells = streamLanes.map((lane) => {
      const r = streamRows.find((x) => x.lane === lane && x.shape === shape && x.size === size);
      return (r ? `${r.mbPerSec.toLocaleString("en-US", { maximumFractionDigits: 1 })} MB/s` : "-").padStart(22);
    });
    console.log(pad(shape, 14) + pad(size, 10) + cells.join(""));
  }
}

console.log();
console.log(`compound-element lanes (ns/element; n=${ELEMENT_N}; jco lane skipped — see README.md):`);
const elementLanes = [...new Set(elementRows.map((r) => r.lane))];
console.log(pad("shape", 12) + elementLanes.map((l) => String(l).padStart(26)).join(""));
for (const shape of ELEMENT_SHAPES) {
  const cells = elementLanes.map((lane) => {
    const r = elementRows.find((x) => x.lane === lane && x.shape === shape);
    return (r ? r.nsPerElement.toLocaleString("en-US", { maximumFractionDigits: 1 }) : "-").padStart(26);
  });
  console.log(pad(shape, 12) + cells.join(""));
}
