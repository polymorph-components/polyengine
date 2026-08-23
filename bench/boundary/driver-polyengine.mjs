// The polyengine lane of the boundary microbench: runs under BOTH plain
// `node` (callback ABI, no engine flag) and `deno run -A`.
//
//   node driver-polyengine.mjs <bundle.mjs> <translator.wasm> <shape> <mode> \
//       <iters> <size> [reps] [jspi]
//
// The bundle is the embedder surface — the LOCAL tree's
// (tools/release-bundle/build.ts output) for tracking this repo, or a
// pinned release asset for cross-version comparison. shape: send | recv
// | send-sync | stream-sink | stream-source | stream-pass; mode:
// immediate | microtask (see host.mjs; ignored by the stream-* shapes,
// which have no host import — the host drives the stream endpoint
// directly). jspi selects jspi-mode suspension (needs
// --experimental-wasm-jspi under node).
//
// For the calls-per-second shapes (send/recv/send-sync), `iters` is the
// number of boundary crossings and `size` the payload size; emits
// { lane, shape, mode, size, iters, medianMs, callsPerSec }.
//
// For the stream-* shapes, `iters` is reused as the CHUNK COUNT and
// `size` as the CHUNK SIZE (bytes) — total bytes moved per timed run is
// `iters * size`; emits { lane, shape, mode: "n/a", size, iters,
// totalBytes, medianMs, mbPerSec, kind: "stream" }.
import { makeHost } from "./host.mjs";

const isDeno = typeof Deno !== "undefined";
const readFile = isDeno
  ? (p) => Deno.readFile(p)
  : async (p) => new Uint8Array(await (await import("node:fs/promises")).readFile(p));
const argv = isDeno ? Deno.args : process.argv.slice(2);
const [bundlePath, translatorPath, shape, mode, itersS, sizeS, repsS, jspiFlag] = argv;
const iters = Number(itersS), size = Number(sizeS), reps = Number(repsS ?? 5);

const cwd = isDeno ? Deno.cwd() : process.cwd();
const polyengine = await import(new URL(bundlePath, `file://${cwd}/`).href);
const translator = await polyengine.Translator.create(await readFile(translatorPath));
const componentBytes = await readFile(
  new URL("./guest/target/wasm32-wasip2/release/boundary_bench_guest.wasm", import.meta.url).pathname,
);
const { plan, adapters } = translator.translate(componentBytes);

const imports = {
  ...polyengine.wasi(),
  "bench:boundary/host@0.1.0": makeHost(mode),
};
const inst = await polyengine.instantiate(
  { plan, componentBytes, adapters },
  imports,
  jspiFlag === "jspi" ? { jspi: true } : { jspi: false },
);

const engine = isDeno ? "deno" : "node";
const lane = `polyengine-${engine}-${jspiFlag === "jspi" ? "jspi" : "callback"}`;

if (shape.startsWith("stream-")) {
  // Bytes-moved timing for the stream-shaped lanes (issue #68): each
  // timed run feeds/drains `iters * size` bytes through one export call.
  const chunkCount = iters, chunkSize = size;
  const totalBytes = chunkCount * chunkSize;
  const payload = new Uint8Array(totalBytes).fill(0xa5);

  async function runStreamSink() {
    const { stream, writer } = polyengine.createStream();
    const call = inst.exports.streamSink(stream);
    const feed = (async () => {
      for (let off = 0; off < totalBytes; off += chunkSize) {
        await writer.writeAll(payload.subarray(off, Math.min(off + chunkSize, totalBytes)));
      }
      await writer.close();
    })();
    const [count] = await Promise.all([call, feed]);
    return Number(count);
  }

  async function runStreamSource() {
    const out = await inst.exports.streamSource(totalBytes);
    let n = 0;
    for (;;) {
      const chunk = await out.read(chunkSize);
      if (chunk.length === 0) break;
      n += chunk.length;
    }
    out.drop();
    return n;
  }

  async function runStreamPass() {
    const { stream, writer } = polyengine.createStream();
    const outP = inst.exports.streamPass(stream);
    const feed = (async () => {
      for (let off = 0; off < totalBytes; off += chunkSize) {
        await writer.writeAll(payload.subarray(off, Math.min(off + chunkSize, totalBytes)));
      }
      await writer.close();
    })();
    const out = await outP;
    let n = 0;
    for (;;) {
      const chunk = await out.read(chunkSize);
      if (chunk.length === 0) break;
      n += chunk.length;
    }
    await feed;
    out.drop();
    return n;
  }

  const run = { "stream-sink": runStreamSink, "stream-source": runStreamSource, "stream-pass": runStreamPass }[shape];
  if (!run) throw new Error(`unknown stream shape: ${shape}`);

  await run(); // warmup
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    const moved = await run();
    times.push(performance.now() - t0);
    if (moved !== totalBytes) {
      throw new Error(`${shape}: moved ${moved} bytes, expected ${totalBytes}`);
    }
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(JSON.stringify({
    lane, shape, mode: "n/a", size, iters, totalBytes,
    medianMs: median,
    mbPerSec: (totalBytes / (1024 * 1024)) / (median / 1000),
    kind: "stream",
  }));
} else {
  const fn = { send: inst.exports.send, recv: inst.exports.recv, "send-sync": inst.exports.sendSync }[shape];

  await fn(Math.min(iters, 1000), size); // warmup
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    await fn(iters, size);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(JSON.stringify({ lane, shape, mode, size, iters, medianMs: median, callsPerSec: Math.round(iters / (median / 1000)) }));
}
