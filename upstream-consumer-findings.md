# Upstream consumer-repo findings

Single source for issues/PRs to file against the **polymorph consumer
repositories** (docs/consumers.md) — and the upstream toolchains their
components are built with — discovered while running their artifacts under
polyengine. Mirrors the conventions of
`upstream-component-model-repo-findings.md`: entries carry status
(`DRAFT` → `FILED #n` → `RESOLVED`), evidence, and proposed fixes. All
filing is the operator's (foreign repos).

---

## IROH-1 — endpoint holds a `RefCell` borrow across a post-resolution `block_on` (RESOLVED-BY-HOST via polyengine#43; see Disposition)

**Repo:** polymorph-iroh. **Where:** `endpoint/src/endpoint_impl.rs:13`
(claim: "the `RefCell` borrows never cross an await") vs the actual path:

```
State::drain()                      # under shared.borrow_mut()
  -> noq/rustls handshake
    -> Signer::sign                 # core/src/crypto/sign.rs:104
      -> wit_bindgen::block_on(polymorph:webcrypto/signature#signing-key.sign)
```

`block_on` on an async import blocks the thread mid-frame (sync
`waitable-set.wait` under the callback ABI); whether other same-instance
tasks may run during that window is the load-bearing question — see the
sharpened semantics below. Every other endpoint task parks in `wait_until`
(`endpoint_impl.rs:939`) whose first act is `shared.borrow_mut()` →
`RefCell already borrowed` → `unreachable` trap.

**Evidence:** found by `exams/iroh-endpoint/` (polyengine C3 exam).
Instrumenting the host's `SigningKey.sign` shows the trap always lands
inside the TLS CertificateVerify signature window; relay-auth signs
(at bind, no poller parked yet) never trip it. Measured under
polyengine: ~90% of runs with `accept` parked across the
handshake. The 5 ms bounded-polling cadence (their jco workaround)
re-arms `wait_until` on the same timescale as the signing window, making
the collision near-certain on any host that interleaves there.

**The precise semantics (corrected 2026-08-10; see
`upstream-component-model-repo-findings.md` CM-4 and
[polyengine#43](https://github.com/polymorph-components/polyengine/issues/43); exam kit archived
at `4f3351f:exams/wasmtime-exclusivity/`):** the
collision window was **polyengine-specific**, not spec-pinned.

- *Before* `task.return`, a callback task's instance-entry gate holds
  across mid-frame blocks on every implementation surveyed (polyengine,
  wasmtime, and `definitions.py` alike) — borrows held across a
  pre-resolution `block_on` are safe.
- *After* `task.return`: **wasmtime keeps holding the gate** for the rest
  of the invocation (`do_not_enter` spans each core invocation; source +
  trace verified), and gates event delivery to other same-instance tasks
  the same way (`GuestCall::is_ready`, concurrent.rs:765). Under wasmtime
  the poller *cannot* be resumed inside the pump's parked signing window
  — the collision is **unreachable by semantics**, not by timing.
  `definitions.py` agrees on the gate lifetime. **polyengine was the
  outlier** until #43 landed: its since-removed release-at-resolution
  rule (the 2026-08-09 CM-4 working assumption) admitted same-instance
  tasks during the post-resolution parked span — that admitted window is
  where this trap lived. The official suite (`sync-streams.wast`) pins
  neither gate rule; its STARTED assertion is schedule-dependent (CM-4,
  adjudicated 2026-08-10: an upstream test defect overfitting wasmtime's
  deferred-entry scheduler policy).

The endpoint's pump does its `block_on(sign)` **after** `bind` resolved,
inside the window polyengine's since-removed rule admitted, with the
`RefCell` borrow live.

**Why the wasmtime leg is green — a semantics guarantee, not timing
luck (corrected 2026-08-10):** the previous revision of this entry
predicted latency injection would reproduce the trap on wasmtime; the
corrected model predicts the opposite — under wasmtime the poller's
timer event sits gated in `pending` until the pump's invocation exits,
at any signing latency. (Falsifiable both ways: add ~1 ms to the
wasmtime host's `sign`; the corrected model says it stays green.) Under
pre-#43 polyengine the same window was open by our own rule, and the 5 ms
poll cadence landed in it ~90% of the time with a `crypto.subtle` signer.

**Disposition (2026-08-10, updated after polyengine#43 landed):** polyengine now
implements wasmtime's hold + deferred-entry model
([polyengine#43](https://github.com/polymorph-components/polyengine/issues/43)) — the admitted
window this trap lived in **no longer exists on any surveyed host**, by
semantics (pinned by `runtime/tests/entry_deferral_test.ts`). Empirical:
`just iroh-exam` scenarios 1/2/4/5 pass post-#43, including the
IROH-1-shaped legs (accept parked across a handshake, scenarios 2 and 4);
the exam's retry workaround for scenarios 2–4 is expected redundant and
can be retired after a few more green runs. (Scenario 3 fails on this
machine with a WebRTC backend-resolution error — differentially confirmed
pre-existing on pristine main, unrelated to #43.) **This entry is
RESOLVED-BY-HOST; no consumer filing needed.** The guest-side hygiene
below remains advisable independent of host (borrows across any
`block_on` are fragile under future spec evolution and under hosts
exploring allowed nondeterminism).

**Proposed fix (guest-side, now optional hardening):** scope the borrow
inside `drain`'s inner steps, or move signing out of the borrowed region
(take what `sign` needs, release, sign, re-borrow).

**Workaround in-tree:** the exam retries scenarios 2–4 (observed 8/20
attempts trip it); residual all-attempts-fail probability < 1%.

---

## WEBCRYPTO-PORT-1 — resource classes must be published under the DEFINING interface (RESOLVED in-tree; upstream doc note optional)

Not a consumer bug — recorded for the eventual upstreaming of
`ports/webcrypto`: `signing-key-options` is defined by
`polymorph:webcrypto/signature` (webcrypto.wit:604,613) and only `use`d
by `ed25519-sign`; a component linking both resolves the resource type
against the definer. Fixed in `ports/webcrypto/src/signature.ts` (the
class is published under both). General rule for all ports: every
resource class goes under its defining interface; `use`rs may re-export.

---

## POLYMORPH-TEST-HARNESS-1 — freshCases re-pick is a linear name() scan (quadratic in suite size)

`runCases`' freshCases branch re-enumerates and scans front-to-back,
calling `name()` per entry until the match (js/viewer/harness.mjs:181-189).
For an n-case suite that is Σi ≈ n²/2 `name()` round-trips per run —
~182M for polymorph-webcrypto's 19k-case shared suite — and every
`name()` is a host-boundary crossing on any runner. polyengine's ct-runner
mirrored the scan verbatim and now fronts it with a same-index-first
fast path (census index as a hint, full scan as the fallback, drift
semantics unchanged — `ct-runner/src/run-suite.ts` `findByName`); the
same fix transplants to harness.mjs directly. Filing upstream is the
operator's call.

---

## IROH-2 — post-#71 redundant tier-(c) overrides: delete in favor of the wasi-shims parking kernel (DRAFT)

**Repo:** polymorph-iroh. **Where:**
`experiments/iroh-relay-ws/host/sockets.ts` (main, post their #40/#41 —
the polyengine-leg rewrite): its `Pollable`, `poll` and `monotonic-clock`
sections (~200 lines) re-implement the tier-(c) parking that
[polyengine#71](https://github.com/polymorph-components/polyengine/pull/71) shipped in
the engine's own WASI package (`@deltic/wasi-shims` when #71 landed; the
package is `@polyengine/wasi` today — this project renamed from deltic to
polyengine, and iroh still pins the `@deltic` line) — written before the
kernel existed, against
the same jco-shim ancestor, so the designs converged.

**Why deleting wins (beyond dedup):** their `block()`/`poll()` are
`async` functions — EVERY call returns a Promise, so every call suspends
and pays the engine's continuation hop (polyengine jspi pin (j)) even when
the pollable is already ready; the kernel's implementations take sync
fast paths. Their duck-typed `PollableLike` seam (foreign pollables
without `waitPromise`) exists only because two `Pollable` classes
coexist; the kernel's publicly-constructible
`new Pollable(ready, wait)` is the interop seam that dissolves it — the
sockets provider mints kernel pollables and the whole foreign-pollable
distinction disappears.

**Proposed fix:** on their next engine pin bump (past #71), drop the
`wasi:io/poll@0.2` and `wasi:clocks/monotonic-clock@0.2` entries from
`syntheticNetImports()` (wasiShims() now provides parking versions) and
replace the local `Pollable` with the kernel's. Their sockets surface is
unaffected (it constructs pollables; the constructor shape is
identical). Filing upstream is the operator's call.

**Related:** [polyengine#74](https://github.com/polymorph-components/polyengine/issues/74)
tracks adopting their sockets surface + routing hooks into wasi-shims,
sequenced after this convergence so they swap once.

---

## CGO-1 — `cabi_realloc` can call clock imports under GC pacing: traps (and poisons) under any conforming CM host (DRAFT)

**Repo:** componentize-go (upstream Go component toolchain; exact repo per
operator). **Where:** the generated `cabi_realloc` / Go runtime allocation
path.

**Evidence:** [polyengine#145](https://github.com/polymorph-components/polyengine/issues/145) —
consistently captured across ~10 reproductions against two
separately-composed wosh builds (downstream report:
[wosh#71](https://github.com/lann/wosh/pull/71)):

```
Trap: cannot leave component instance 1 (may_leave violation)
    at clock_time_get (wasm)
    at runtime.clock_time_get (Go runtime)
    at runtime.walltime1
    at time.now
```

from inside `cabi_realloc`, during the copy window of a cross-instance
`list<u8>` lowering. Under allocation pressure the Go runtime decides an
allocation crosses a GC-pacing threshold and reads the wall clock — from
inside the callee's realloc.

**Spec basis (why this is theirs, not a host bug):** the reference sets
`may_leave = False` around the entire realloc call
(`definitions.py:670-683` `LiftLowerContext.reallocate`) and `canon_lower`
traps when it is false (`definitions.py:2244`); CanonicalABI.md's
"realloc must be called reentrantly…" paragraph makes the guard
load-bearing — it is what licenses compiling realloc calls as plain
synchronous calls instead of the specced fresh-thread semantics. Net
constraint: **`cabi_realloc` must not (transitively) call imports.** A
Go runtime that reserves the right to read the clock in any allocation
violates it on every conforming host: polyengine instance-poisons
(verified), wasmtime store-poisons (presumed from shared semantics;
unverified on wasmtime's host-lowering path — its native gates simply
never generated the same allocation pressure).

**Proposed fix (at the source, fixes every host):** make the generated
`cabi_realloc` unable to trigger GC pacing — a pre-reserved arena sized
per copy, a GC hold across the realloc frame, or a runtime knob
deferring pacing clock reads while inside the CABI entry. Any of these
also removes the load-dependent flakiness (polyengine#145: the trap needs an
allocation to cross a GC threshold *inside* the window, so it only shows
under flood).

**Related:** polyengine#145 (asks 1–3; ask 1 — refusals naming the poison
cause — implemented host-side),
[polyengine#147](https://github.com/polymorph-components/polyengine/issues/147) (polyengine's own
host-entry lowering runs realloc outside the window — the lenient gap
that made #145 reproduce only under composition). Filing upstream is the
operator's call.

---

## POLYVISOR-1 — docs spike vendors a full deltic-0.1.0 engine bundle (DRAFT)

**Repo:** polyvisor. **Where:** `docs/spike-todomvc/app.js` — a checked-in
minified bundle containing an entire deltic-era engine copy (protocol
brands, canonical classes, plan validation, CABI; `RUNTIME_VERSION`
"0.1.0", `deltic.*/1` brand keys, `DELTIC_SCHED_SEED`).

**Why it matters:** this is the one raw `deltic.witError/1` spelling left
anywhere in the consumer family (audited 2026-08-22 during embedder-api
amendment A19; every live consumer imports the canonical classes via
`@deltic/runtime/embedder` or `@polyengine/runtime/embedder`, none
hand-roll brands or import the protocol package directly). A vendored
bundle is exactly the multi-copy scenario A18/A19 leave undiagnosed: its
brand namespace is disjoint from both the current `@deltic@0.2.x` line
and every `@polyengine` line, so if the spike is ever revived next to a
current engine copy, values simply go unrecognized — no error names the
mismatch.

**Proposed fix:** regenerate (or delete) the bundle when polyvisor takes
its migration turn; until then it is inert documentation. Filing is the
operator's call.

---

## Out of scope here, tracked where they belong

- Spec/reference findings: `upstream-component-model-repo-findings.md`.
- `ports/webrtc` foreign-entry npm resolution (import-map requirement):
  documented in `ports/webrtc/README-import-map note` and the exam's
  deno.json; a Deno resolution mechanic, not a consumer defect.
