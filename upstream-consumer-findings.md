# Upstream consumer-repo findings

Historical integration findings from consumer artifacts run under polyengine.
These are **snapshots, not a current audit of foreign repositories**. Paths,
versions and measurements below identify the observed artifact or source;
unless explicitly stated, they have not been rechecked in the current
consumer tree. `DRAFT` means unfiled, not confirmed still reproducible.

Current integration guidance lives in [docs/consumers.md](docs/consumers.md).
Reproduce against current sources and obtain operator authorization before
filing publicly. Existing links below are evidence, not new filing claims.

---

## IROH-1 — endpoint holds a `RefCell` borrow across a post-resolution `block_on` (RESOLVED-BY-HOST via polyengine#43; see Disposition)

**Status:** RESOLVED-BY-HOST; no consumer filing needed.
**Snapshot:** August 2026 polymorph-iroh endpoint exam, before polyengine#43.

The observed path held `shared.borrow_mut()` through `State::drain()`, a
noq/rustls handshake, `Signer::sign`, and `wit_bindgen::block_on` of the
webcrypto signing import. With another endpoint task parked in `wait_until`,
pre-fix polyengine could resume that task during signing and trap on its
second mutable borrow.

**Corrected interpretation:** this was a polyengine gate-lifetime bug, not
a consumer violation. The instance-entry gate spans the entire core
invocation, including post-`task.return` blocking. The reference and
surveyed wasmtime source agreed; polyengine's removed release-at-resolution
rule admitted the conflicting task. Deferred-entry status timing is a
separate scheduler choice; see
[CM-4](upstream-component-model-repo-findings.md#cm-4-sync-streamswast145-overfits-wasmtimes-scheduler--entry-status-timing-is-not-normative).

**Disposition:** [polyengine#43](https://github.com/polymorph-components/polyengine/issues/43)
corrected the host rule, pinned by `runtime/tests/entry_deferral_test.ts`.
The historical exam passed the affected handshake scenarios after that fix.
Its old retry rates and proposed wasmtime latency reproduction do not describe
current behavior. Mechanism evidence is archived at
`4f3351f:exams/wasmtime-exclusivity/`; no current consumer workaround is asserted.

---

## WEBCRYPTO-PORT-1 — resource classes must be published under the DEFINING interface (RESOLVED in-tree; upstream doc note optional)

**Status:** Historical port correction, not a consumer bug.

The former in-tree `ports/webcrypto` published `signing-key-options` under
`ed25519-sign`, which only `use`d the resource from
`polymorph:webcrypto/signature`. Components linking both needed the class
under its defining interface. The port was corrected to publish it there
as well. The general constraint remains: `use` imports may re-export a
resource, but do not replace its defining interface's binding. The old
`ports/` path is historical, not a current source location.

---

## POLYMORPH-TEST-HARNESS-1 — freshCases re-pick is a linear name() scan (quadratic in suite size)

**Status:** DRAFT, historical consumer-harness observation.

The observed `js/viewer/harness.mjs` `runCases` implementation re-enumerated
fresh cases and scanned from the front, calling `name()` until it found the
requested case. Across an n-case suite this makes about n²/2 host-boundary
calls. No current consumer implementation is asserted here.

Polyengine's `ct-runner/src/run-suite.ts` `findByName` tries the census index
first, verifies the name, then falls back to the scan if the index drifted.
That optimization preserves name-based selection and is a candidate for the
consumer harness if the original scan remains.

---

## IROH-2 — post-#71 redundant tier-(c) overrides: delete in favor of the wasi-shims parking kernel (DRAFT)

**Status:** DRAFT, snapshot after polyengine#71 and polymorph-iroh#40/#41.

The observed `experiments/iroh-relay-ws/host/sockets.ts` duplicated pollables,
polling and monotonic-clock parking already supplied by the engine's WASI
package. Its async `block()`/`poll()` always returned Promises, including for
ready pollables; the engine kernel has synchronous ready paths. The observed
consumer still used the old `@deltic/wasi-shims` package name. Its current
pin and overrides have not been checked.

**Candidate change:** after verifying the consumer's package API, use its
WASI kernel's `Pollable` and remove the duplicated poll/clock import entries.
The historical constructor shapes matched; do not assume they still do.
Related integration work was recorded in
[polyengine#74](https://github.com/polymorph-components/polyengine/issues/74).

---

## CGO-1 — `cabi_realloc` can call clock imports under GC pacing: traps (and poisons) under any conforming CM host (DRAFT)

**Status:** DRAFT, historical componentize-go artifact finding; no current
toolchain reproduction or wasmtime poisoning result is claimed.

**Evidence:** [polyengine#145](https://github.com/polymorph-components/polyengine/issues/145)
and [wosh#71](https://github.com/lann/wosh/pull/71) recorded two composed wosh
builds trapping during cross-instance `list<u8>` lowering:

```text
Trap: cannot leave component instance 1 (may_leave violation)
    at clock_time_get (wasm)
    at runtime.clock_time_get (Go runtime)
    at runtime.walltime1
    at time.now
```

The recorded call originated in `cabi_realloc`: allocation pressure caused
the Go runtime's GC pacing to read the clock within the realloc frame.

**Spec basis:** `LiftLowerContext.reallocate` in the pinned `definitions.py`
sets `may_leave = False` around realloc, and `canon_lower` checks that guard.
Thus realloc cannot transitively leave the component through a lowered
import. The observed clock call violated that constraint. Polyengine
poisoning was reproduced; the old assertion of wasmtime store-poisoning was
an inference, not a measured result.

**Candidate fix:** prevent GC-pacing clock imports during canonical realloc,
for example by deferring those reads or allocating from pre-reserved space.
The choice belongs to the toolchain and requires a current reproduction.
The related historical host-entry guard gap was tracked separately in
[polyengine#147](https://github.com/polymorph-components/polyengine/issues/147);
it is not evidence of a current runtime gap.

---

## POLYVISOR-1 — docs spike vendors a full deltic-0.1.0 engine bundle (DRAFT)

**Status:** DRAFT, snapshot from the 2026-08-22 consumer brand-key audit.

The observed `polyvisor/docs/spike-todomvc/app.js` contained a vendored
deltic-0.1.0 engine, including the old protocol brands. If revived alongside
a newer engine, its disjoint brand namespace could leave cross-copy values
unrecognized without a version-mismatch diagnostic. The bundle was inert
documentation in that audit; neither its continued presence nor its status
as the only old-brand occurrence is asserted now.

**Candidate fix:** regenerate or delete the bundle if the spike is revived.

---

## Out of scope here, tracked where they belong

- Spec/reference findings: `upstream-component-model-repo-findings.md`.
- The former `ports/webrtc` foreign-entry npm resolution problem was a Deno
  import-map requirement, not a consumer defect. Its old port/exam paths
  are historical and are not current integration instructions.
