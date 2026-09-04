# bench/boundary — the host-boundary microbench

Calls-per-second across the host import boundary, per ABI shape — the
instrument behind [#17](https://github.com/polymorph-components/polyengine/issues/17)'s
jco-vs-polyengine baseline, [#54](https://github.com/polymorph-components/polyengine/issues/54)'s
lift-throughput finding, and [#8](https://github.com/polymorph-components/polyengine/issues/8)'s
cost ledger. The design goal is attribution, not realism: the guest is a
tight loop over echo-shaped imports whose host bodies are trivial, so
what the clock sees is lift/lower + dispatch + (for async shapes) the
suspension machinery — and both stacks run on **the same engine** (plain
`node` runs the polyengine callback ABI with no flag; the jco lane and
polyengine's jspi mode share `--experimental-wasm-jspi`), so V8/GC/JIT
variables cancel.

```sh
just bench-boundary            # polyengine lanes: node callback+jspi, deno
just bench-boundary with-jco   # + the incumbent jco lane (npm ci + transpile on first use)
```

The polyengine lanes measure the CURRENT TREE: the recipe builds the local
embedder bundle (`tools/release-bundle/build.ts`) and the local
translator shim. Numbers are box-relative — compare lanes within one
run, or the same lane across commits on one box, never absolute values
across machines.

## Shapes

| export | import it loops | boundary shape |
| --- | --- | --- |
| `send` | `ping: async func(list<u8>) -> u32` | UDP-send-shaped: payload guest→host |
| `recv` | `fetch: async func(u32) -> list<u8>` | UDP-receive-shaped: payload host→guest |
| `send-sync` | `ping-sync: func(list<u8>) -> u32` | the sync-lowered control |

Host settlement `mode`: `immediate` (a plain return value — the fast
path) and `microtask` (an async host fn, i.e. an already-resolved
promise — the wakeup-shaped path a real receive takes). Payload sizes 0
(pure call overhead) and 1200 B (QUIC-ish MTU). Medians of 5 timed
export calls after a warmup call; each export call runs `iters`
boundary crossings.

## Stream shapes ([#68](https://github.com/polymorph-components/polyengine/issues/68))

| export | what it measures |
| --- | --- |
| `stream-sink: async func(s: stream<u8>) -> u64` (guest drains, returns count) | host→guest payload via rendezvous |
| `stream-source: async func(n: u32) -> stream<u8>` (guest pumps n bytes) | guest→host payload |
| `stream-pass: async func(s: stream<u8>) -> stream<u8>` (guest returns its input unchanged, never reads) | host↔host rendezvous after identity transfer (contracts/embedder-api.md §"Streams and futures") |

Unlike the calls-per-second shapes above, none of these involve a host
import: the host drives the stream endpoint directly via the embedder's
`Stream` API (`contracts/embedder-api.md` §"Streams and futures"), so
what's measured is the rendezvous/copy cost in isolation. Reported as
MB/s (bytes moved ÷ elapsed), medians of 5 timed runs after a warmup,
same convention as the calls-per-second table. Chunk sizes 1200 B,
16 KiB, 256 KiB; the chunk COUNT per size is chosen (`sweep.mjs`,
`STREAM_CONFIGS`) so one timed run lands in the tens-of-ms range —
smaller chunks need more of them to reach a measurable duration, larger
chunks need fewer. **polyengine drivers only**: jco's p3 stream support is
not under test here, so the jco lane is skipped for these rows.

## Compound element shapes ([#261](https://github.com/polymorph-components/polyengine/issues/261))

| export | what it measures |
| --- | --- |
| `lift-ops: async func(n: u32) -> list<op>` (guest returns `n` elements) | compound-element LIFT |
| `lower-ops: async func(ops: list<op>) -> u64` (guest folds, returns a checksum) | compound-element LOWER |

`op` is a 16-case variant over records — the width and payload mix
mirror #261's reported 17-case consumer schema (a DOM-mutation op
stream, records carrying `string`, `option<u16>`, `list<u8>`, and a
nested payload-free variant `node-update-kind`), because two of the
costs #261 identifies — `maxCaseAlignment` (`runtime/src/cabi/layout.ts`)
and the embedder facade's variant case resolution
(`runtime/src/embedder/values.ts` `toHost`) — are both O(case count) per
element. Every other shape in this instrument — `list<u8>`, `u32`,
`stream<u8>` — is a flat scalar and takes a bulk copy path (issues
#63/#67); before this lane, NOTHING in `bench/boundary` exercised the
per-element interpreted lift/lower loop that compound types (records,
variants, options, strings) actually walk. Both directions are measured
separately because `load.ts`'s per-element path and `store.ts`'s
per-element path are separate code with the same defect.

Reported as ns/element (`iters` reused as the element count `n`; `size`
is unused, passed through as "n/a" like `mode` is for the stream shapes)
— the unit that makes these numbers comparable to a whole variant-over-
records lift/lower rather than a byte or a call. Medians of 5 timed runs
after a warmup, same convention as the other tables. Element count
10000, calibrated (`sweep.mjs`, `ELEMENT_N`) so a timed run lands in the
tens-of-ms range. **polyengine drivers only**, same reason as the stream
shapes: jco is not under test here.

Methodology footnote: `lift-ops`'s guest caches its `Vec<Op>` in a
`thread_local!` keyed on `n` — the warmup call builds it, every timed
call clones the cached vector, measured in isolation at ~15 ns/element
on this box (a temporary export cloned without crossing the boundary).
`lower-ops`'s host array is built ONCE outside the timed loop, since
that lane measures lowering, not host array construction.

## Baseline (2026-08-11, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60; post-#63/#67 bulk list copies)

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
  lane over-measures by one guest alloc+fill per run. Consistent across
  runs, so trend-tracking is unaffected; just don't read sink-vs-source
  deltas as pure copy-direction cost.
- "size" means write granularity for `stream-sink` but host *read*
  granularity for `stream-source`/`stream-pass` (their producers offer
  everything at once; `wit_stream`'s writer does its own internal
  chunking). One dimension, two meanings — split it if a finding ever
  hinges on the distinction.

### Compound element shapes baseline (2026-09-03, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60) — before #261's optimization PRs (#263/#264/#265 landed after this was recorded)

```
compound-element lanes (ns/element; n=10000; jco lane skipped — see README.md):
shape         polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback
lift-ops                       3,804.4                   3,909.3                   3,184.6
lower-ops                      3,482.3                   3,646.8                   3,285.3
```

This is the "before" baseline for #261, recorded before any optimization
of the per-element interpreted path lands. ~3.2-3.9 µs/element here vs.
#261's reported ~5 µs/element on a similar box — same order of
magnitude, within ~1.6x; the residual gap reads as box/config drift.
See the 2026-09-04 block below for the "after" numbers.

## Baseline (2026-09-04 — post-#261, linux-arm64 dev box, Node 24.18 / Deno 2.9.5, guest wit-bindgen 0.60; #263 layout-node cache + #264 adapter tables + #265 flatten-count memoization)

```
compound-element lanes (ns/element; n=10000; jco lane skipped — see README.md):
shape         polyengine-node-callback      polyengine-node-jspi  polyengine-deno-callback
lift-ops                         677.8                     704.2                     867.1
lower-ops                        630.4                     661.4                     694.6
```

The compound-element drop against the 2026-09-03 "before" table is
3.7x-5.6x fewer ns/element depending on lane (#263's layout-node cache
plus #264's adapter tables). The calls-per-second table is NOT refreshed
here: this box cannot currently reproduce it — `send immediate 0` /
`polyengine-node-jspi` alone read 780,785/s (2026-08-11), 1,023,625/s
(an interleaved run today), and 521,044/s (this sweep), a 2x spread on
identical code, so a fresh table would be noise with a date on it. What
is known instead, from interleaved before/after pairs (medians of paired
differences, `immediate`, size 0, attributable to #265's per-call
flatten-count memoization, reproduced across two passes): `send-sync`
+27%/+32%, `send` +22%/+28%, `recv` +34%/+31% calls/sec — a delta, not a
new absolute baseline. The 2026-08-11 table remains the recorded
calls-per-second baseline, known to understate the current tree, until a
quiet box allows a real re-measurement. Stream rows are also NOT
re-measured: `stream-sink` at 256 KiB spans 2,900-10,800 MB/s across four
interleaved runs with no consistent before/after sign, and none of
#263/#264/#265 touch the `stream<u8>` bulk-copy path, so the 2026-08-11
stream rows above still stand as the current record.

## What the baselines say

- **Async import round-trips**: polyengine's callback ABI sustains 0.3–1.1 M
  crossings/s; jco's async path costs ~3 ms per call flat
  (timer-quantized — its sync path is healthy at ~300 k/s, so the cost
  is the async task loop, the same machinery behind lann/jco#11 and
  polymorph-iroh's 5 ms polling workaround). For the UDP direct path
  (#4) this is the difference between "boundary is free" and "boundary
  is the bottleneck".
- **#54 (fixed in #63; sentinel rows)**: `recv @ 1200` once ran ~18 k/s
  (~22 MB/s, a per-element interpreted store); it now tracks the empty
  call within ~1 % — the payload copy is bulk in both directions, and
  these rows are the regression sentinel. #67 extended the bulk copies
  to the remaining flat element types (not separately represented here;
  the shapes are `list<u8>`).
- **jspi vs callback** (same runtime, same engine): parity on
  immediate-settled paths, ~2–4× behind on deferred (microtask) paths —
  the suspend/resume cost, recorded for #8.
- **#68 stream shapes**: `stream-pass` (host↔host rendezvous, no guest
  memory touched — contracts/embedder-api.md §"Streams and futures")
  consistently beats `stream-sink` and
  `stream-source` (host↔guest, which pay a real memory copy through the
  guest's linear memory) at every chunk size, confirming the identity
  transfer is doing what it claims. All three scale up sharply with
  chunk size — per-rendezvous overhead amortizes over more bytes.
- **#261 compound elements**: the first instrument for the interpreted
  per-element lift/lower path — every prior shape here is flat and
  bulk-copies. #263 (layout-node cache) + #264 (adapter tables) moved
  `lift-ops`/`lower-ops` from ~3.2-3.9 µs/element to ~0.6-0.9 µs/element
  — same sentinel role #54/#67 played for flat types, now proven out.

The jco lane pins the family's own toolchain (the lann/jco all-fixes
transpile + preview2-shim release tarballs, the vendored
`jco-transpile.mjs` wrapper, and polymorph-test's `bindImports` for the
WASI spellings — the exact stack the consumer repos' jco legs run). It
exists as the incumbent baseline and retires with the jco era.
