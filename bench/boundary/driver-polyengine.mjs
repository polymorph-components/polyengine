// The polyengine lane of the boundary microbench: runs under BOTH plain
// `node` (callback ABI, no engine flag) and `deno run -A`.
//
//   node driver-polyengine.mjs <bundle.mjs> <translator.wasm> <shape> <mode> \
//       <iters> <size> [reps] [jspi]
//
// The bundle is the embedder surface — the LOCAL tree's
// (tools/release-bundle/build.ts output) for tracking this repo, or a
// pinned release asset for cross-version comparison. shape: send | recv
// | send-sync | stream-sink | stream-source | stream-pass | lift-ops |
// lower-ops; mode: immediate | microtask (see host.mjs; ignored by the
// stream-*/*-ops shapes, which have no host import — the host drives the
// stream endpoint or the ops array directly). jspi selects jspi-mode
// suspension (needs --experimental-wasm-jspi under node).
//
// For the calls-per-second shapes (send/recv/send-sync), `iters` is the
// number of boundary crossings and `size` the payload size; emits
// { lane, shape, mode, size, iters, medianMs, callsPerSec }.
//
// For the stream-* shapes, `iters` is reused as the CHUNK COUNT and
// `size` as the CHUNK SIZE (bytes) — total bytes moved per timed run is
// `iters * size`; emits { lane, shape, mode: "n/a", size, iters,
// totalBytes, medianMs, mbPerSec, kind: "stream" }.
//
// For the compound-element shapes (issue #261: lift-ops/lower-ops),
// `iters` is reused as the ELEMENT COUNT and `size` is unused (passed
// through as "n/a", same convention as mode for the stream shapes);
// emits { lane, shape, mode: "n/a", size: n, iters: n, medianMs,
// nsPerElement, kind: "element" }. ns/element (not calls/s or MB/s) is
// the unit that makes these numbers comparable to #261's reported
// figure — each element is a whole variant-over-records lift/lower, not
// a byte or a call.
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
} else if (shape === "lift-ops" || shape === "lower-ops") {
  // Compound-element lanes (issue #261): `iters` is reused as the
  // element count `n`; `size` is unused.
  const n = iters;

  // Host-side generator mirroring the guest's `build_ops` exactly (same
  // 16-case cycle, same string/list shapes, same option-branch split —
  // see wit/bench.wit for why the type is this wide/shaped) so both
  // directions exercise the same distribution of cases/branches. The
  // embedder facade's variant shape is `{ kind, value? }`
  // (runtime/src/embedder/values.ts) and a record's `option<T>` field is
  // an optional property, not a boxed `{some}`/`{none}` — see the
  // `toHost` record case there. Record field labels are camelCased
  // (`new-parent` -> `newParent`); a nested variant field (`updateKind`)
  // is itself a `{ kind }` value, payload-free cases included.
  function optionU16(i) {
    return i % 3 === 0 ? undefined : i % 0xffff;
  }
  function smallBytes(i) {
    const len = 2 + (i % 4);
    return Uint8Array.from({ length: len }, (_, j) => (i + j) % 256);
  }
  function makeOps(count) {
    const ops = [];
    for (let i = 0; i < count; i++) {
      switch (i % 16) {
        case 0: {
          const rec = { id: i, tag: `div${i}` };
          const p = optionU16(i);
          if (p !== undefined) rec.parent = p;
          ops.push({ kind: "insert-element", value: rec });
          break;
        }
        case 1:
          ops.push({ kind: "remove-element", value: i });
          break;
        case 2:
          ops.push({ kind: "set-attribute", value: { id: i, key: "class", value: `c${i}` } });
          break;
        case 3:
          ops.push({ kind: "remove-attribute", value: { id: i, key: "data-x" } });
          break;
        case 4:
          ops.push({ kind: "set-text", value: { id: i, text: `text${i}` } });
          break;
        case 5: {
          const rec = { id: i, text: `t${i}` };
          const p = optionU16(i);
          if (p !== undefined) rec.parent = p;
          ops.push({ kind: "insert-text", value: rec });
          break;
        }
        case 6: {
          const rec = { id: i, index: i % 64 };
          const p = optionU16(i);
          if (p !== undefined) rec.newParent = p;
          ops.push({ kind: "move-node", value: rec });
          break;
        }
        case 7:
          ops.push({ kind: "clear-children", value: i });
          break;
        case 8:
          ops.push({ kind: "set-class-list", value: { id: i, classes: smallBytes(i) } });
          break;
        case 9:
          ops.push({ kind: "set-style", value: { id: i, style: smallBytes(i) } });
          break;
        case 10:
          ops.push({ kind: "add-event-listener", value: { id: i, event: "click" } });
          break;
        case 11:
          ops.push({ kind: "remove-event-listener", value: { id: i, event: "click" } });
          break;
        case 12:
          ops.push({ kind: "focus", value: i });
          break;
        case 13:
          ops.push({ kind: "blur" });
          break;
        case 14:
          ops.push({ kind: "scroll-into-view" });
          break;
        default: {
          const kinds = ["inserted", "updated", "removed", "moved"];
          ops.push({
            kind: "checkpoint",
            value: { id: i, updateKind: { kind: kinds[i % 4] } },
          });
          break;
        }
      }
    }
    return ops;
  }

  async function runLiftOps() {
    const ops = await inst.exports.liftOps(n);
    if (ops.length !== n) throw new Error(`lift-ops: got ${ops.length} elements, expected ${n}`);
  }

  // Built ONCE outside the timed region: this lane measures LOWERING,
  // not host array construction (the guest-construction footnote below
  // applies only to lift-ops, where the guest builds its Vec inside the
  // timed region — see README.md).
  const hostOps = shape === "lower-ops" ? makeOps(n) : null;
  let lastChecksum = null;
  async function runLowerOps() {
    const checksum = await inst.exports.lowerOps(hostOps);
    if (lastChecksum === null) lastChecksum = checksum;
    else if (checksum !== lastChecksum) {
      throw new Error(`lower-ops: checksum ${checksum} != ${lastChecksum} across reps`);
    }
  }

  const run = shape === "lift-ops" ? runLiftOps : runLowerOps;
  await run(); // warmup
  const times = [];
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    await run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(JSON.stringify({
    lane, shape, mode: "n/a", size: n, iters: n,
    medianMs: median,
    nsPerElement: (median * 1e6) / n,
    kind: "element",
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
