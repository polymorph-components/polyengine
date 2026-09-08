# bench/boundary — the host-boundary microbench

A manual instrument for host calls, stream transfer, and compound-value
lift/lower. The guest uses synthetic loops and trivial host bodies, not a real
application workload. The Node lanes share one Node executable, reducing engine
version differences, but GC, JIT, process scheduling, and thermal variation do
not cancel. Deno is a separate engine build.

```sh
just bench-boundary            # polyengine lanes: node callback+jspi, deno
just bench-boundary with-jco   # + the incumbent jco lane (npm ci + transpile on first use)
```

The recipe builds the local guest, embedder bundle, and translator shim. It
requires Rust with `wasm32-wasip2` and `wasm32-unknown-unknown`, Node, Deno, and
optionally npm for the jco lane. `sweep.mjs` currently passes
`--experimental-wasm-jspi` to the Node JSPI lanes; callback lanes explicitly
disable JSPI. Consult [architecture](../../docs/architecture.md) for engine
support, rather than inferring requirements from this historical runner flag.

The tables below are **historical measurements, not current-tree performance
claims**. Compare fresh interleaved runs on the same machine and record the
engine versions, component/toolchain pins, and source revision. These
microbenchmarks are not gates or evidence of application throughput.

## Shapes

| export | import it loops | boundary shape |
| --- | --- | --- |
| `send` | `ping: async func(list<u8>) -> u32` | UDP-send-shaped: payload guest→host |
| `recv` | `fetch: async func(u32) -> list<u8>` | UDP-receive-shaped: payload host→guest |
| `send-sync` | `ping-sync: func(list<u8>) -> u32` | the sync-lowered control |

Host settlement `mode`: `immediate` (a plain return value) and `microtask`
(an async host function returning an already-resolved Promise). The latter
does not simulate network delay. Payload sizes 0
(pure call overhead) and 1200 B (QUIC-ish MTU). Medians of 5 timed
export calls after a warmup call; each export call runs `iters`
boundary crossings.

`send-sync` uses a plain synchronous host function in both mode rows; the
`microtask` label does not make that control suspend. Timing also includes
guest work: `send` clones its payload on each iteration, while `send-sync`
borrows its buffer.

## Stream shapes ([#68](https://github.com/polymorph-components/polyengine/issues/68))

| export | what it measures |
| --- | --- |
| `stream-sink: async func(s: stream<u8>) -> u64` (guest drains, returns count) | host→guest payload via rendezvous |
| `stream-source: async func(n: u32) -> stream<u8>` (guest pumps n bytes) | guest→host payload |
| `stream-pass: async func(s: stream<u8>) -> stream<u8>` (guest returns its input unchanged, never reads) | host↔host rendezvous after identity transfer (contracts/embedder-api.md §"Streams and futures") |

These shapes do not involve a host import: the host creates stream pairs with
`createStream()` and reads or writes handles directly. See the
[embedder contract](../../contracts/embedder-api.md) for stream semantics.
Timing includes export dispatch, rendezvous, and any payload allocation/copy
inside the timed region, not an isolated copy primitive.

The driver labels throughput `MB/s` but computes **MiB/s** (bytes divided by
`1024 * 1024`, then by elapsed seconds). The historical tables retain their
original labels. Results are medians of five timed runs after a warmup.
`STREAM_CONFIGS` in `sweep.mjs` sets chunk sizes and counts. Only polyengine
drivers run these shapes; jco stream support is not measured.

## Compound element shapes ([#261](https://github.com/polymorph-components/polyengine/issues/261))

| export | what it measures |
| --- | --- |
| `lift-ops: async func(n: u32) -> list<op>` (guest returns `n` elements) | compound-element LIFT |
| `lower-ops: async func(ops: list<op>) -> u64` (guest folds, returns a checksum) | compound-element LOWER |

`op` is a 16-case variant over records, based on #261's DOM-mutation workload.
It contains strings, options, byte lists, and a nested payload-free variant.
Unlike the bulk byte-copy shapes, these rows exercise per-element compound
conversion. Lift and lower are measured separately; the old per-element
layout/case scans that motivated these rows have since been optimized.

Reported as ns/element: `iters` is the element count `n`, and the input `size`
argument is unused (the JSON result records `size: n`). `ELEMENT_N` in
`sweep.mjs` is 10000. Each result is the median of five timed runs after a
warmup. Only polyengine drivers run these shapes; jco is not measured.

`lift-ops`'s guest caches its `Vec<Op>` by `n`; warmup builds it and timed calls
clone it, so cloning remains in the measurement. The original investigation
measured that clone at about 15 ns/element on its dev box using a temporary
export, not a standing benchmark. `lower-ops` builds its host array outside
the timed loop.

The sink also collects received bytes into a guest vector, and `lower-ops`
folds the received values into a checksum. These costs are part of the timed
work, not subtracted overhead estimates.

## Historical baseline (2026-08-11, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60; post-#63/#67 bulk list copies)

```
shape     mode       size    polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback         jco-node-jspi
send      immediate  0                  932,496/s             780,785/s             912,448/s                 544/s
send      immediate  1200               554,477/s             508,132/s             715,925/s                 421/s
send      microtask  0                  407,627/s             119,069/s             328,809/s                 343/s
send      microtask  1200               288,646/s             102,759/s             343,579/s                 344/s
recv      immediate  0                1,063,271/s             905,595/s           1,297,820/s                 347/s
recv      immediate  1200             1,052,361/s             975,889/s           1,272,385/s                 450/s
recv      microtask  0                  401,310/s             123,669/s             445,292/s                 339/s
recv      microtask  1200               411,979/s             111,910/s             452,194/s                 405/s
send-sync immediate  0                1,536,391/s           1,406,726/s           1,766,432/s             351,160/s
send-sync immediate  1200               795,639/s             589,574/s             894,576/s             311,567/s
send-sync microtask  0                1,653,656/s             788,044/s           1,682,381/s             349,784/s
send-sync microtask  1200               761,535/s             615,453/s             997,213/s             313,497/s

stream lanes (bytes/s; jco lane skipped — see above):
shape         size        polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback
stream-sink   1200                    437 MB/s              277 MB/s            417.8 MB/s
stream-sink   16384               3,421.8 MB/s          2,487.2 MB/s          3,604.7 MB/s
stream-sink   262144              7,538.4 MB/s          6,936.1 MB/s          4,711.9 MB/s
stream-source 1200                  496.4 MB/s            334.1 MB/s            409.5 MB/s
stream-source 16384               3,318.8 MB/s          3,152.1 MB/s          4,410.3 MB/s
stream-source 262144             14,814.9 MB/s          7,725.9 MB/s         10,997.9 MB/s
stream-pass   1200                  756.5 MB/s            625.9 MB/s              838 MB/s
stream-pass   16384               6,665.9 MB/s            5,847 MB/s          7,231.2 MB/s
stream-pass   262144             13,716.5 MB/s         14,229.4 MB/s         22,863.2 MB/s
```

Two methodology footnotes for the stream rows:

- `stream-source` allocates and fills its whole payload inside the guest
  within the timed region (one `vec![0x5a; n]` per run), where
  `stream-sink`'s host payload is preallocated outside it — the source
  lane includes one guest alloc+fill per run. Do not read sink-vs-source
  deltas as pure copy-direction cost, or assume allocation cost is stable.
- In the current driver, "size" means host write granularity for `stream-sink`,
  host read granularity for `stream-source`, and both host write and read
  granularity for `stream-pass`. The guest source offers its payload to the
  stream writer, whose internal chunking is separate.

### Compound element shapes baseline (2026-09-03, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60) — before #261's optimization PRs (#263/#264/#265 landed after this was recorded)

```
compound-element lanes (ns/element; n=10000; jco lane skipped — see README.md):
shape         polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback
lift-ops                       3,804.4                   3,909.3                   3,184.6
lower-ops                      3,482.3                   3,646.8                   3,285.3
```

This is the pre-optimization record for #261. The 2026-09-04 block below records
the post-optimization run; neither table predicts the current tree's cost.
The original #261 consumer report was about 5 microseconds/element on a similar
machine, but that was a different workload/configuration, not a matched lane.

## Historical baseline (2026-09-04 — post-#261, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60; #263 layout-node cache + #264 adapter tables + #265 flatten-count memoization)

```
compound-element lanes (ns/element; n=10000; jco lane skipped — see README.md):
shape         polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback
lift-ops                         677.8                     704.2                     867.1
lower-ops                        630.4                     661.4                     694.6
```

The recorded compound-element time fell by 3.7x-5.6x relative to 2026-09-03.
Calls/sec and stream tables were not refreshed on 2026-09-04 because repeated
measurements varied substantially. For `send immediate 0` in the Node JSPI lane,
the recorded values were 780,785/s on 2026-08-11, then 1,023,625/s in an
interleaved run and 521,044/s in the September sweep. Paired September passes
reported `send-sync` +27%/+32%, `send` +22%/+28%, and `recv` +34%/+31% calls/sec
for #265 (`immediate`, size 0). Those are historical relative observations, not
a replacement absolute baseline. `stream-sink` at 256 KiB ranged from
2,900 to 10,800 in the driver's `MB/s` units across four interleaved runs, with
no consistent before/after sign.

## Interpreting comparisons

The August table captured a large async-call difference against the pinned jco
toolchain and a callback/JSPI difference on microtask-settled imports. It does
not establish current jco performance or isolate a single scheduling cost.
Likewise, stream throughput does not prove ownership-transfer correctness;
functional tests establish that. The byte-copy rows are useful regression
probes for #54/#63/#67, and the compound rows for #261/#263/#264/#265, but each
new claim needs a fresh controlled comparison.

For historical context, #54 reported about 18,000 calls/sec (about 22 MB/s as
originally reported) for `recv` at 1200 bytes before #63's bulk-copy change.
That earlier finding is not a current measurement or a row from the dated
tables above.

The optional jco lane uses the toolchain pinned in `package.json` and
`package-lock.json`, the local `jco-transpile.mjs` wrapper, and `bindImports`
for WASI spellings. It is a comparison with that pinned stack, not necessarily
the current stack in any consumer repository.
