# Embedder API conventions (host-facing)

Status: **v0.2 — C1 deliverable (docs/milestones.md), normative for the C2
implementation; amendment A1 (2026-08-10) makes sync-import suspension a
declared, per-function capability (`suspending()`), replacing v0.1's
undeclared "permitted cast"; amendment A2 (2026-08-10) extends A1 to
host-resource methods/statics (class-prototype authority), adds the
stage-3 decorator form, and makes interface members receive their
containing object as `this`; amendment A3 (2026-08-11) lets `instantiate`
accept untranslated artifacts (`{ componentBytes, translator }`) and run
the translation internally; amendment A4 (2026-08-11) blesses the
translation envelope as the build-time artifact
(`artifactsFromEnvelope`); amendment A5 (2026-08-11) makes host wrapping
of one stream/future idempotent (pass-through round trips —
host→guest→host — hand back the same handle machinery instead of
asserting), legalizes host↔host rendezvous for every element type, and
pins u8 stream chunks as `Uint8Array` in both directions; amendment A6
(2026-08-11) ships the wasi-shims parking kernel always-on (§"WASI
examination", renumbered from a colliding second "A5"); amendment A7
(2026-08-11) makes component faults loud on host stream/future
operations (`PeerTrappedError`, never a hang or a fake end-of-stream)
and limits host ends to one in-flight operation per direction; amendment
A8 (2026-08-10, polyengine#90/#97) makes `Future.drop()` before writing an
**abandonment** (total, never-throwing; a guest reader observes a trap at
its rendezvous, never DROPPED) and documents host `cancelRead` as
indistinguishable from end-of-stream by design; amendment A9 (2026-08-11)
makes every cross-boundary brand a process-global registry symbol carried
by the new dependency-free `@polyengine/protocol` package — class identity is
not part of the embedder API — and adds loud multi-copy diagnostics
(issue #83); amendment A10 (2026-08-11) renames `WitError` to
`ComponentException` (`isWitError` → `isComponentException`) and the
variant-family discriminant properties `{ tag, val }` to `{ kind, value }`,
aligning with the draft web-embedding direction
(WebAssembly/component-model PR #686's canonical variant dictionary and
exception naming) while it is still cheap — semantics unchanged
(payloadless cases still omit `value`); the **wire vocabulary is
untouched**: the brand key stays `deltic.witError/1` (an opaque constant,
CEWD-style, so pre-A10 copies and hand-rolled brands keep interoperating)
and plan-format op discriminants (a different contract) keep `tag`;
A10 release note (2026-08-12): the rename changes `@deltic/protocol`'s
export surface, so the JSR package moves to **0.2.0** — immutable `0.1.0`
keeps the pre-A10 names for pre-A10 runtime prereleases (`^0.1.0` never
resolves across), and post-A10 workspace publishes depend on `^0.2.0`;
**A10's brand-key freeze and its `@deltic/protocol` version reasoning are
both historical as of A18, which renames the project, the scope and the
keys together**;
amendment A11 (2026-08-12) makes between-calls guest liveness normative:
host-import settlements are serviced by a settlement pump while no export
call is in flight, so background tasks parked on host-call wakeups (clocks,
fetches) progress without embedder traffic — embedder-never-acts operations
still hang (never trap) and failures still surface on the next driving
call; amendment A12 (2026-08-12) makes result-position future sources
normative for imports: an import whose WIT result type is `future<T>`
treats a thenable return as the FUTURE SOURCE (the import completes
immediately; the future settles on the producer's schedule) — see
§"Streams and futures"; amendment A13 (2026-08-13) makes resource-element
streams first-class: `stream<own<R>>` elements lower as live handles, a
world-level host resource's class registers under the resource's own
(camelCase) name with its member leaves dispatching on it, and elements a
producer lowered that the reader never takes are DESTROYED (dtors run),
never leaked — see §"Streams and futures"; amendment A14 (2026-08-14)
marks the p2 stream `blocking-*` declarations park-capable: the wasi
package's buffer-backed base streams keep their sync fast path (never
park), while genuinely-async stream impls — the host-stdio cli — return
Promises and park through the A6 kernel; the A2 mark-relay (prototype
declares, instances behave) is what lets duck-typed stream impls park
through the registered resource types; amendment A15 (2026-08-21) makes
host-activity arm liveness equal host retention (issue #162): the
"embedder may still act" deadlock-verdict suppression expires when the
host hands its last end back to a guest — a lifted stream/future lowered
back in (the identity round trip) disarms, a re-lift re-arms, and every
drop path (including the teardown walks) releases the arm — and reading
through a `Stream`/`Future` handle already passed to a guest is refused
loudly (`TypeError`) instead of operating a phantom duplicate of an end
the guest now owns; `StreamWriter` operations after the pass stay legal
(the host retains the writable end) — see §"Streams and futures";
amendment A16 (2026-08-21, polyengine#182) settles the semantics of handle
disposal on a future whose host end has not materialized:
`Future.cancel()`, like `drop()`, is a total fire-and-forget handle
operation and never surfaces the producing call's failure — see §"Streams and futures"; amendment A17 (2026-08-21,
polyengine#184) scopes the world-digest handshake to the GENERATED typed
entry point (bindgen emits an `instantiate` wrapper that verifies before
instantiating) — the runtime's untyped `instantiate` has no world to
check against and does not verify — see §"Module wiring and
instantiation"; amendment A18 (2026-08-21) renames the project from
`deltic` to `polyengine` and, with it, every brand key in the registry
(`deltic.witError/1` → `polyengine.witError/1` and siblings) — a hard
break with no compatibility spelling, superseding A10's freeze; the brand
GENERATION stays `1` — see §"Module identity and @polyengine/protocol";
amendment A19 (2026-08-22) renames the brand key
`polyengine.witError/1` → `polyengine.componentException/1`, retiring the
last leaf that named the pre-A10 class — a rename that should have ridden
A18's break and didn't. Same shape as A18: a hard break with no
compatibility spelling and no diagnostic, and the generation stays `1`
(a spelling change already yields a disjoint symbol set). The rest of the
vocabulary was audited and stands: every other leaf matches its current
class or concept; `wasiExit` keeps its package prefix deliberately
(`exit` is too generic for a flat namespace), and the digest's `cewd`
constant stays frozen — it is hashed wire content nobody reads or
hand-rolls, so A10's opaque-constant argument still holds there —
see §"Module identity and @polyengine/protocol";
amendment A20 (2026-08-22, issue #131) defines realm-boundary crossings:
`@polyengine/protocol` gains `toCloneable`/`fromCloneable` — a
structured-clone-safe envelope for the branded error taxonomy,
error-contexts, and wasi exit unwinds, round-trip exact for every matcher
this contract offers — while realm-local values (streams, stream writers,
futures, resource wrappers, pollables) refuse `toCloneable` and carry an
own enumerable function-valued property `"polyengine.realmLocal/1"` (the
**realm-local pill**) so a raw structured clone throws `DataCloneError`
at the sender instead of delivering a husk; error-context becomes
**message-valued** at lowering (any branded carrier of a string `message`
mints a fresh local context, superseding "lowering accepts only lifted
instances"); the envelope is version-internal, never a wire format — see
§"Realm boundaries and structured-clone-safe forms".**
This document supersedes `descriptor-ir.md`'s interim
"host value mapping" table as the destination for host-facing value shapes.
The runtime's *raw* boundary (`instance.exports`, `HostImports`) keeps the
`definitions.py` interpreter shapes as an **internal** surface; the
conventions below are implemented by the bindgen-generated ergonomic layer
(see "Implementation strategy"). Reference consumers: the polymorph host
modules (`webrtc.js`, `webcrypto.js`, `websocket.js`) and the C2 WASI shim
package. Design evidence: `tools/smoke-c0/REPORT.md` §"C1 design-input
notes" (friction findings 1–8), the R-fix review's stream-API advisories,
and docs/consumers.md.

## Principles

1. **Fresh design; jco compatibility is a non-goal** (docs/architecture.md §2). Where jco's
   choice is also the right choice (camelCase, enum strings), we
   converge by merit — deliberately, so consumer ports stay small. Where
   the emerging standard direction points elsewhere, we align upstream
   instead (A10: `{kind, value}` variants per the PR #686 draft, a
   deliberate divergence from jco's `{tag, val}`).
2. **Footguns are design defects.** Every convention here is judged against
   the defensive code the polymorph modules had to write under jco
   (bare-payload error throws, convention-only stream contracts,
   hand-transcribed mangled keys).
3. **One way to do each thing.** No dual error channels, no alternative
   value spellings. Liberal *acceptance* is allowed only where the TS type
   still names a single canonical form.
4. **TS-first.** Every shape must be expressible as a precise TypeScript
   type that bindgen can emit; discriminated unions over clever encodings.
5. **WASI interfaces must come out natural.** The conventions are validated
   on paper against wasi p2/p3 idioms (appendix) — the ecosystem's most
   important interfaces, and what every adopter's shims will be written
   against.
6. **Async is the point.** Exports are uniformly Promise-shaped; async host
   imports are plain async functions (C0 finding #5: that path "already
   feels finished" — it is named here and frozen).

## Naming and casing

| WIT construct | JS/TS |
|---|---|
| function, method, static, record field, flag name, function param (docs only — calls are positional) | camelCase (`get-resolution` → `getResolution`) |
| resource name | PascalCase class (`tcp-socket` → `TcpSocket`) |
| enum value, variant/result case name (the `kind` value) | **kebab-case verbatim** as string literals (`connection-refused`) — they are data, not identifiers |
| interface key in the imports/exports record | fully-qualified WIT id **verbatim, version included**: `wasi:clocks/monotonic-clock@0.3.0` |
| world-level (bare) imports/exports | camelCase name at the record's top level |

Version resolution follows the Component Model's **canonical interface
names** design and wasmtime's linker semantics — see "Version
canonicalization" below. What remains banned is *unversioned* folding
(C0 finding D-1's actual defect: version-agnostic keys merged distinct
semver tracks). Helpers may expand a wildcard over interface *names*
within one track, never across tracks.

## Version canonicalization

> Correction (same day as v0.1): the initial draft ruled "version-exact
> keys, never fuzzy-matched." That was stricter than both authorities and
> would have forced the C2 shim to triplicate implementations the
> ecosystem expects to unify. Authorities: Explainer.md §"canonical
> interface names" (`canonversion`, 🔗-gated) and wasmtime's
> `wasmtime-environ::component::names::{NameMap, alternate_lookup_key}`
> (used by both `component::Linker` and `Component::get_export`).

Every version belongs to a **compatibility track**, per the spec's
canonicalization split (identical to wasmtime's `alternate_lookup_key`):

| version | track key | notes |
|---|---|---|
| `1.2.3`, `1.0.0`, `2.1.2+abc` | `@1`, `@1`, `@2` | major > 0 → major is the track |
| `0.2.6`, `0.2.12` | `@0.2` | major 0 → minor is the track |
| `0.0.1` | none | patch-only versions are compatible with nothing |
| any prerelease (`0.2.0-rc-…`) | none (resolution) | wasmtime treats prereleases as exact-only; the historical WASI `0.2.0-rc` snapshots differed at the same track, which is D-1's phenomenon with a tag |

**Resolution rule (normative for `instantiate` and the C2 shim):** an
import name is matched (1) **exactly** against provided entries, then
(2) against the provider registered for the import's *track*, where a
track slot is claimed by the **highest-versioned** entry registered on
that track (wasmtime's max-wins rule). Structural type-checking of the
resolved instance does the real safety work — backwards *and* limited
forwards compatibility fall out of "the guest only uses functions the
provider actually has", exactly as the spec describes.

**Registration forms (providers):** register full-versioned keys
(`…/monotonic-clock@0.2.12` — track alternate derived automatically), or
register the **track key itself** (`…/monotonic-clock@0.2`) as an
explicitly canonical provider serving the whole track. Registering both
a track key and full-versioned keys on the same track is refused at
registration (ambiguity is an error, not a precedence rule).
**Unversioned interface ids** (C2 amendment) are legal exact-match keys —
unversioned WIT interfaces exist — but an unversioned key never serves a
versioned import nor vice versa; only *folding* (treating an unversioned
key as a cross-track wildcard) is banned.

**What this resolves from C0:** D-2 (p2 at `0.2.6`/`0.2.9`/`0.2.12`) —
one `@0.2` provider serves all three, as WASI intends. D-1
(`monotonic-clock@0.3.0` naming different function sets across artifact
families) — same track, divergent drafts: served by a **union** provider,
with per-leaf structural resolution selecting what each component
actually imports; no version machinery can or should distinguish them.

**Forward note (wasmtime-bump era):** the 🔗 canonical-names feature puts
`canonversion` in binaries with the split-off `versionsuffix` carried as
a separate field on imports/exports; wasmparser 0.252 predates it.
When the pin moves: the plan format gains an optional `versionSuffix` on
import/export entries, and resolution degenerates to the trivial string
equality the spec intends (note `semver::Version::parse("0.2")` fails, so
canonical names never generate alternates — the two mechanisms compose
without interference).

## Value mapping (normative)

| Component type | TS type | Notes |
|---|---|---|
| `bool` | `boolean` | |
| `u8 s8 u16 s16 u32 s32 f32 f64` | `number` | range-checked at lower |
| `u64 s64` | `bigint` | range-checked at lower |
| `char` | `string` (single code point) | validated at lower |
| `string` | `string` | lower applies USVString replacement (docs/architecture.md §7) |
| `list<u8>` | `Uint8Array` | always a copy; never a view into guest memory |
| `list<T>` (T ≠ u8) | `T[]` | plain arrays; no typed-array widening (a future perf opt-in, never a silent shape change) |
| `tuple<A, B, …>` | `[A, B, …]` | real TS tuple |
| `record` | plain object, camelCase fields | fields of option type are optional properties: lift emits **absent** (not `undefined`-valued) for none; lower accepts either spelling (C2 amendment) |
| `enum` | string literal union of kebab-case case names | `"offer" \| "answer" \| …` |
| `variant` | `{ kind: "case" }` \| `{ kind: "case", value: T }` | `value` **absent** (not `undefined`) for payloadless cases |
| `option<T>` | `T \| undefined`; **nested** options box | see rule below |
| `result<T, E>` **as a value** (nested in other types, or in parameter position) | `{ kind: "ok", value: T } \| { kind: "err", value: E }` | `value` absent for empty sides — same family as `variant` |
| `result<T, E>` **as a function result** (return position only) | return `T` / throw `ComponentException<E>` | empty sides: resolves `undefined` / `ComponentException.payload === undefined`; see "Error model" |
| `map<K, V>` | its despecialization `list<tuple<K, V>>` → `[K, V][]` | C2 amendment |
| `flags` | object of camelCase booleans | lift: every flag present; lower: absent = `false` |
| `own<R>` / `borrow<R>` | the resource class instance | see "Resources" |
| `stream<T>` / `future<T>` / `error-context` | `Stream<T>` / `Future<T>` / `ErrorContext` | see "Streams and futures" |

**Terminology note.** The spec calls variant alternatives **cases**
(Explainer, definitions.py `case_label`); prose here follows that. The
discriminant *property* is named `kind` with payload `value` (A10),
matching the canonical variant dictionary in the draft web embedding
(WebAssembly/component-model PR #686) — if that shape holds, native
support and this API agree for free. v0.2 named them `{ tag, val }` after
jco's convention; A10 supersedes that argument. `case` itself stays out:
it is a JS reserved word — legal as a property, but `v.case` reads like
syntax. The value of `kind` is always the case name, kebab-case verbatim.

**Why a discriminant property rather than `{ [case]: value }`** (the
single-key form the internal definitions.py-shaped boundary uses):
(1) exhaustiveness — `switch (v.kind)` + `assertNever` is compiler-checked
case coverage; `in`-chains are not switchable and lose it; (2) payloadless
cases get one uniform shape (`value` absent) instead of a null/undefined
sentinel adjacent to `option` payloads; (3) generic code reads `v.kind`
typed and allocation-free where single-key needs an untypeable
`Object.keys(v)[0]` cast, and per-case key shapes make every
variant-touching site polymorphic for the engine; (4) case names stay
data (kebab-case verbatim) rather than entering the identifier-casing
regime as keys. Conceded cost: literal construction is wordier —
bindgen may emit per-variant constructor helpers (`Message.binary(bytes)`)
as an optional nicety; the value shape is unaffected.

**Option rule.** The *outermost* option in a chain maps to
`T | undefined`; every option nested **directly inside another option**
uses the variant family: `{ kind: "some", value: … } | { kind: "none" }`.
Only option maps to `undefined`, so this is the only ambiguity and the
boxing is exactly as deep as needed. Example (`option<option<u32>>`, the
values-fixture Some(None) edge):

```ts
undefined                            // none
{ kind: "none" }                     // some(none)
{ kind: "some", value: 7 }           // some(some(7))
```

**Worked example** (C0 finding #7 asked for exactly this shape) —
`result<tuple<own<counter>, own<counter>>, error>`:

- as a **function result**: the call resolves to `[Counter, Counter]`
  (a real two-element tuple of class instances, ownership transferred to
  the caller), or rejects/throws `ComponentException` whose `.payload` is
  the `error` variant value, e.g. `{ kind: "timed-out" }`.
- **nested as a value** (say inside `list<…>`):
  `{ kind: "ok", value: [Counter, Counter] } | { kind: "err", value: Error… }`.

## Error model

```ts
class ComponentException<E = unknown> extends Error {
  readonly payload: E;          // the WIT err value, shaped per the table
  constructor(payload: E, message?: string);
}
class Trap extends Error { … }  // existing; component-fatal, never a value
class PeerTrappedError extends Error {  // A7: a stream/future op whose peer instance trapped
  readonly cause: unknown;      // chains to the Trap
  readonly progress?: number;   // write ops: elements delivered before the fault
}
```

- **Guest export with `result<T, E>`**: the call resolves to `T` on ok and
  rejects (throws, for sync paths) with `ComponentException<E>` on err.
  `Trap` rejections are always distinguishable by class.
- **Host import with `result<T, E>`**: the host function returns `T` for
  ok and `throw`s `new ComponentException(payload)` for err — the ergonomic
  throw-for-error pattern, **branded**. (The name matches PR #686's draft
  `ComponentException`; ours does not derive from `DOMException` — absent
  in the bare `sm`/`jsc` shell lanes — and carries the structured
  `payload` instead. Revisit inheritance if the draft's shape stabilizes.)
- **An unbranded throw from a host import is a host bug and becomes a
  trap** (with a message naming the import), never a guest-visible err —
  the inversion of jco's convention, where any stray `TypeError` was fed
  to the lift and the polymorph modules had to wrap every platform call
  defensively (`platformCall` in webcrypto.js). Here the defensive wrapper
  is unnecessary by construction: only `ComponentException` crosses as an
  err value.
- Host code must never catch-and-swallow `Trap` (re-throw if observed);
  traps poison the instance per docs/architecture.md §7 regardless.
- **`Trap.message` is diagnostic text, not API.** Match on the `Trap`
  brand (or future structured fields), never on message text. In
  particular, a raw core-wasm trap (e.g. `unreachable`) carries the
  *engine's own* wording behind a `guest trapped:` provenance prefix —
  V8, SpiderMonkey, and JSC each phrase the same trap differently, and
  the runtime deliberately does not normalize them (the conformance
  harness reconciles suite-expected wording at comparison time instead;
  see `TRAP_MESSAGE_EQUIVALENTS` in harness/src/runner.ts). Runtime-
  *authored* traps (FACT adapter codes, deadlock detection, handle-table
  errors) have stable wording chosen by this project, but the same rule
  applies: text is for humans and logs.
- Results nested inside values never throw anywhere — they are plain
  `{ kind, value }` data (table above).
- **Recognition is by brand, not class** (amendment A9): every class above
  carries a process-global brand symbol, and the runtime's checks read the
  brand. Same-copy `instanceof` still works and stays the documented
  spelling in single-copy graphs; `@polyengine/protocol` exports predicates
  (`isComponentException`, `isTrap`, `isPeerTrappedError`, …) as the
  multi-copy-robust form. See §"Module identity and @polyengine/protocol".

## Functions and async

- **Exports are uniformly Promise-shaped**: bindgen types every export as
  returning `Promise<T>`, sync-typed or not (a sync completion resolves
  immediately). One calling convention; async-first per docs/architecture.md §1. Exactly
  two exceptions (C2 amendments): resource constructors (synchronous —
  see Resources) and `future<T>`-typed results (eager handles — see
  Streams and futures).
- **Imports match their WIT type**: an `async func` import may be a plain
  `async` JS function (or return a value synchronously); a sync `func`
  import is typed to return `T` synchronously. Returning a Promise from a
  sync-typed import parks the calling **wasm frame** and is a *declared*
  capability (amendment A1): wrap the function in `suspending()` (defined
  in `@polyengine/protocol` since A9; re-exported unchanged from the embedder
  surface). The marker
  - is per-declaration — only marked imports are handed to wasm as
    `WebAssembly.Suspending`, so unmarked imports keep the plain calling
    convention and sync-only components keep their zero-cost pin;
  - is auto-detection evidence — a marked import selects jspi mode without
    an explicit `jspi: true` (an explicit `jspi: false` still forces plain,
    where a returned Promise is refused as before);
  - carries real costs, deliberately visible: every call through a marked
    import pays the engine's continuation hop even when it returns
    synchronously (`contracts/intrinsics.md` pin (j)), and a marked import
    reached from a `start` function traps (pin (c): a start function may
    not block — the trap fires even for synchronous returns);
  - rides the engine floor: on a non-JSPI engine a marked import that
    returns a Promise is refused at the call site (`NeedsJspi`), never
    silently degraded.
  Scope (as extended by A2): plain function imports (bare and interface
  members), host-resource **methods and statics** — mark instance methods
  on the class (the CLASS PROTOTYPE is the per-declaration brand
  authority, read at wrap time; instance-level overrides change the
  dispatched body, never suspendability), statics on the function itself.
  Constructors are never markable (synchronous by the C2 amendment). Two
  spellings, one brand: the direct call (`f: suspending(fn)` — canonical,
  the only form available in record literals) and a stage-3 method
  decorator (`@suspending` on instance or static methods). The decorator
  refuses non-method positions and the legacy `experimentalDecorators`
  calling convention loudly, at class-definition time. Semantics of the
  park: the reference's `thread.wait_until(subtask.resolved)`
  (definitions.py canon_lower) — a plain non-cancellable wait; the
  instance-entry gate stays held (the #43 hold rule); result lowering runs
  at resume time under the suspension point's attribution claim.
- **Interface members are invoked with their containing object as
  receiver** (A2): a class instance is a fully supported spelling of an
  interface provider — methods reading instance state work, matching the
  resource static arm's behavior. World-level bare imports have no
  containing object and are called unbound.
- Params are positional; param names appear only in types/docs (they are
  excluded from the world digest — `contracts/digest.md`).
- **Between-calls liveness** (amendment A11, 2026-08-12): guest progress
  does not require an in-flight export call. A host import that settles
  while no call is being driven is serviced then — a background task parked
  on a waitable set whose pending host call resolves (a clock subscription,
  a fetch) resumes at settlement time, not at the embedder's next call.
  This is the JS-host analogue of dwelling in wasmtime's `run_concurrent`,
  and what makes guest-encapsulated keep-alive tickers (componentize-go's
  goroutine bridge over `wasi:clocks.wait-for`) self-driving under polyengine.
  Two prior bounds are unchanged: an operation waiting on the *embedder's*
  half of a host stream/future still hangs until the embedder acts (never
  a trap — see Streams and futures), and a settlement-time failure
  surfaces on the next call into the instance, as before.

## Resources

Two directions, one surface: **a resource is a class instance on both
sides of the boundary.** The C0 friction findings 1–3 (bare-number reps,
hand-rolled identity tables, hand-transcribed `[method]…` keys) are
resolved here by making identity mapping and name mangling bindgen/runtime
obligations, never the embedder's.

**Guest-implemented resources** (host holds handles): bindgen emits a
class per resource — constructor calls the guest constructor; methods and
statics camelCase; `[Symbol.dispose]()` and `drop()` both drop the handle
(TS `using` works); a `FinalizationRegistry` backstop drops leaked handles
(docs/architecture.md §7). Passing an instance where `own<R>` is expected **invalidates
the wrapper** (further use throws); passing as `borrow<R>` leaves it
usable after the call returns.

**Host-implemented resources** (guest holds handles): the host provides a
plain class implementing the bindgen-emitted interface (camelCase methods;
statics as static members; the WIT constructor as the JS constructor). The
runtime owns the instance↔rep mapping. When the guest drops its last own
handle, the runtime calls `instance[Symbol.dispose]?.()` (dtor). Method
`self` is the instance — no reps, no side tables.

**Constructors are synchronous** (C2 amendment): a JS class constructor
cannot await, so `new R(...)` is the one exception to Promise-shaped
exports. A guest constructor that does not complete synchronously raises
a named error rather than half-constructing; if a consumer ever needs a
suspending constructor, the escape hatch is a generated async static
factory — deferred until demanded.

Ownership at the boundary, both directions:

| WIT position | guest-implemented R | host-implemented R |
|---|---|---|
| host receives `own<R>` | new class instance (host now owns; drop/`using` it) | the host's own instance back; the guest's handle is gone; no dispose call |
| host receives `borrow<R>` | instance valid **only during the call** (retention throws) | the host's own instance; borrow scoping is guest-side bookkeeping |
| host passes `own<R>` | wrapper invalidated (transferred) | instance registered; guest owns its handle |
| host passes `borrow<R>` | wrapper stays valid | guest must not retain past the call (runtime-enforced per CABI); a never-registered instance gets a rep allocated for the call's duration (C2 amendment) |

### Pattern (non-normative): binding platform classes directly

A host-implemented resource does not need a hand-written class: when a WIT
resource's shape matches a native platform class, pass the class itself —
the pattern the draft web embedding builds its import story on
(WebAssembly/component-model PR #686 "interface object" imports; tracked
in polyengine#115), available here today because the pieces already line up:
method dispatch is a per-call `self[camelCase(member)]` lookup, WIT
constructor args flow to `new Class(...)`, and the value conventions are
the natural JS shapes (`Uint8Array` IS a `BufferSource`; a record is a
plain camelCase object, i.e. an options bag).

```ts
const instance = await instantiate(artifacts, {
  "test:platform/web": { params: URLSearchParams, decoder: TextDecoder },
});
```

Executable reference: `runtime/tests/embedder/platform_class_test.ts` +
`platform-class.wat` (kebab→camel `to-string`→`toString`, string/bool/
`list<u8>`/record conversions, and each limit below, pinned with exact
failure modes).

The limits, and the one-line bridges (a `class X extends Native { … }`
wrapper stays inside the pattern):

1. **Getter-backed properties are not methods.** WIT has no attributes, so
   a `size: func() -> u32` bound against an accessor (`URLSearchParams.
   prototype.size`) finds no callable member: the call traps ("the
   <Class> instance has no method 'size'"). The wrap-time suspending
   probe reads only DATA properties — it never invokes accessors, so
   merely binding such a class is safe; the limit surfaces per-call, and
   only for guests that call the member. (Consequence: an A2 suspending
   mark cannot ride an accessor-backed member.) Bridge: a real method
   delegating to the property.
2. **Platform "absent" is `null`; WIT `none` is `undefined`.** A native
   returning `null` where WIT expects `option<T>` takes the `some` branch
   and fails the inner conversion: the call rejects with the conversion
   layer's `TypeError` naming the import — not a trap, never `none`.
   Bridge: `get(k) { return super.get(k) ?? undefined; }`.
3. **Platform exceptions are unbranded, so they trap** — even from a
   `result`-typed import (§"Error model"): a result-typed WIT signature
   does not convert host exceptions into `err` values. Bridge: try/catch
   in a subclass override, rethrowing `new ComponentException(payload)`.

Named types in the imported interface (a `record decoder-options` the
constructor takes, say) need no imports-object entry — only functions and
resource classes are read from the embedder.

## Streams and futures

Handles, not raw shared objects (`SharedStreamImpl` identity stays
internal):

```ts
interface Stream<T> {
  readable(): ReadableStream<Chunk<T>>;    // web-native; Chunk<u8> = Uint8Array, else T[]
  [Symbol.asyncIterator](): AsyncIterator<Chunk<T>>;
  read(max: number): Promise<Chunk<T>>;    // low-level; empty chunk = end
  readDirect(                              // stream<u8> only — amendment A21
    consume: (src: DirectSource) => "more" | "done",
  ): Promise<number>;
  cancelRead(): void;
  drop(): void;                            // [Symbol.dispose] alias
}
interface Future<T> extends PromiseLike<T> {  // await it directly
  drop(): void; cancel(): void;
}
// Direct-access byte edges (amendment A21, stream<u8> only). The writer-side
// mirror lives on StreamWriter:
//   writeDirect(produce: (dest: DirectDestination) => "more" | "done"): Promise<number>
// Both objects are DEAD once the callback returns — every later method call
// throws.
interface DirectDestination {
  remaining(): Uint8Array;     // scoped view over the reader's unfilled landing zone
  markWritten(n: number): void; // cumulative within the invocation
}
interface DirectSource {
  remaining(): Uint8Array;     // scoped view of the writer's unread bytes; read-only by contract
  markRead(n: number): void;
}
class ErrorContext { readonly message: string }  // lift-only constructor-wise (C2 amendment); lowering also accepts any branded string-`message` carrier by minting a fresh local context (A20)
class DroppedError extends Error { … }    // awaiting a dropped future rejects with this
```

- **Future results are eager handles** (C2 amendment): an export whose WIT
  result is `future<T>` returns `Future<T>` **directly**, not
  `Promise<Future<T>>` — JS promise resolution unconditionally adopts
  thenables, so a Promise can never resolve *to* a PromiseLike handle;
  wrapping would make `drop`/`cancel` unreachable. `await exportFn()`
  still yields `T` (the handle is thenable); call without awaiting to
  hold the handle. Streams are unaffected (`Stream` is not thenable).
- **Lifted** `stream<T>`/`future<T>` values arrive as `Stream<T>`/
  `Future<T>`. Awaiting a future whose write end dropped without a value
  rejects with `DroppedError` (discriminated — R-fix review note 4).
- **Handle disposal is total and silent** (amendment A16, 2026-08-21,
  polyengine#182). `drop()` and `cancel()` on a `Future<T>` are plain handle
  operations: they never throw, never return a promise, and never surface
  a failure of the call that produces the future's host end. A future
  obtained from an export call is DEFERRED — its host end materializes
  when that call completes — so a handle held without awaiting (the
  blessed spelling above) can outlive a failing producer; disposing such a
  handle discards the failure rather than raising it out of band. The
  failure is not lost: it still surfaces to anyone awaiting the future (or
  reading it), which is the only place the embedder asked for a value.
  Runtimes must therefore attach rejection handling at the handle itself,
  so that neither `cancel()`, `drop()`, nor a handle abandoned untouched
  can raise an unhandled rejection at the process level.
- **Lowering accepts the natural JS producers**: where the guest expects a
  `stream<T>`, the host may pass a `ReadableStream`, an `AsyncIterable`,
  an array (finite), or a `Stream<T>` handle; for `future<T>`, a
  `Promise<T>` or `Future<T>`. Bindgen adapts and **owns the pumping**:
  the driving arms auto-close on end/`DROPPED` (eliminating the
  deadlock-masking activity-lifetime footgun — R-fix review note 2), and
  cross-store reuse is a runtime-asserted error, not silent misbehavior
  (note 3).
- **An import whose WIT result type is `future<T>` returns the future
  source** (amendment A12, 2026-08-12). A thenable returned by the host
  method — a `Promise<T>` or a `Future<T>` handle — is lowered as the
  future itself: the import call completes immediately, and the future
  settles on the producer's schedule. It is **not** adopted as the call's
  async completion (the pre-A12 dispatch behavior, under which a sync-typed
  import returning a Promise was a JSPI park request — and under which a
  `Future` handle, being `PromiseLike`, was silently awaited and
  re-lowered). The natural spelling of the `wasi:sockets@0.3` TCP `send`
  shape — `send: func(data: stream<u8>) -> future<result<_, error-code>>`
  as an `async` JS method whose promise resolves when transmission
  completes — depends on this: the future settles only after post-return
  guest action (the guest writes `data` after `send` returns), so adopting
  the thenable is a livelock, not a semantics choice. A **rejected**
  future-source promise stays a producer failure on the host-failure
  channel (site-named, surfacing on the consuming call — same as every
  producer), never a guest-visible err value: a fallible payload rides
  *inside* the future (`future<result<…>>`), resolved as a result value.
  Executable spec: `examples/guests/future-import` +
  `runtime/tests/embedder/future_result_test.ts`.
- **Streams of resources are first-class** (amendment A13, 2026-08-13 —
  the `wasi:sockets@0.3` TCP `listen` shape,
  `func() -> result<stream<tcp-socket>, error-code>`). A host producer
  for `stream<own<R>>` yields resource-class instances; each element
  lowers through the normal `own` transfer (host-implemented R: the
  instance registers, the guest's drop runs `[Symbol.dispose]`;
  guest-implemented R: the wrapper transfers). Two obligations come with
  the shape:
  - **Un-taken elements are destroyed, never leaked.** An element the
    producer lowered that the reader never takes — the reader dropped
    mid-stream, or the peer instance trapped (`PeerTrappedError.progress`
    marks the delivered prefix) — has its destructor run at the pump's
    teardown, exactly as if the guest had taken and dropped the handle.
    This is what makes a `listen` provider safe: an un-taken element is a
    live accepted connection. Top-level `own` is the supported element
    shape; composite elements carrying nested owns stay out of scope
    until a consumer links one.
  - **Producers are cancellable.** When the stream dies (reader drop, or
    the A7 teardown walk) while the producer is PARKED — an accept-shaped
    source awaiting an external event, with no write in flight for the
    pump to observe — the pump cancels it: a `ReadableStream` source via
    `reader.cancel()`, an (async-)iterable source via its optional
    `cancel(): void` method (close your listener there; the pump then
    drains the pending pull, so a straggler element still reaches the
    un-taken release path). A source with no cancel hook keeps the
    pre-A13 behavior: parked until its next element, the documented
    embedder-negligence hang class.
  - **World-level host resources register under the resource's own
    (camelCase) name**, and their mangled member leaves
    (`[method]r.m`, `[static]r.m`, `[constructor]r`) dispatch on that
    class — the world-level analogue of "the resource CLASS sits at the
    resource's position" for interface imports.
  Executable spec: `examples/guests/resource-stream` +
  `runtime/tests/embedder/resource_stream_test.ts`.
- **Stream values survive round trips** (amendment A5). A `stream`/`future`
  is an identity: lifting one that the host already handled — a
  host-created stream a guest passed back (result or import position), or
  a guest-created stream on its second hop — is **idempotent**, yielding a
  handle over the same underlying end rather than the v0.2
  double-wrap error. Consequences, all normative:
  - host → guest → host pass-through works with the guest never reading;
    the payload then moves host↔host without touching guest memory;
  - a readable end may hop the boundary any number of times (each lower
    transfers it, exactly as between two guests);
  - host↔host rendezvous is legal for **every** element type — the
    same-instance restriction applies to component instances only;
  - a `Stream.create()` writer keeps feeding the same stream across hops
    (the writer half addresses the shared end, not a particular handle).
- **Deadlock-verdict suppression tracks host retention** (amendment A15,
  2026-08-21 — issue #162). While the host retains a way to act on a
  stream/future — a retained end, a parked host operation, or an
  unfinished producer pump — a stalled guest is reported as the
  documented embedder-may-act hang, never a deadlock trap. That claim
  **expires with retention**: lowering a lifted handle back into a guest
  (the `identity: async func(s: stream<u8>) -> stream<u8>` round trip)
  hands the host's only end back, so the store's deadlock verdicts are
  live again immediately; a later re-lift of the same shared object (the
  A5 cache-hit wrapper) restores the suppression; and every drop path —
  either end, the A7 teardown walk, instance retirement — releases it.
  (Pre-A15, one identity round trip suppressed deadlock verdicts for the
  store's remaining lifetime, presenting every later genuine deadlock as
  the embedder-may-act hang.) Companion refusal: `read` through a
  `Stream` handle — and awaiting a `Future` — that was already passed to
  a guest rejects with a `TypeError` naming the transfer; a post-transfer
  host read would operate a phantom duplicate of an end the guest now
  owns. `StreamWriter` operations are unaffected (the writer half
  addresses the host-retained writable end across hops, per A5).
  Retention-by-choice is unchanged: a host that returns a *different*
  stream while quietly keeping the original's end is genuine retention,
  and the embedder-negligence hang class remains.
- **u8 chunks are `Uint8Array` in both directions** (amendment A5, the
  write-side mirror of `Chunk<u8>`): `StreamWriter.write`/`writeAll` take
  `Chunk<T>`, and a `Uint8Array` chunk is treated as already-lowered bytes
  — passed by reference to the rendezvous (borrowed until the returned
  promise settles) and copied exactly once, at the rendezvous itself.
  Reads hand back that copy unchanged: one copy end-to-end for
  host↔host, one memory copy each way when a guest is the peer.
- **Foreign-copy handles are recognized and refused, loudly** (amendment
  A9). A `Stream`/`Future` (or `ErrorContext`, or a resource wrapper)
  minted by a *different runtime copy* is recognized by its brand at
  lowering and raises a named cross-copy error listing both copies' URLs —
  never the silent producer-adaptation fallback (which would pump a
  foreign `Stream` by its async iterator, quietly voiding A5's identity
  guarantees). Remediation is by value, explicitly: pipe a foreign stream
  via `.readable()`, a foreign future via `Promise.resolve(f)`. Handles
  are stateful — their machinery lives in the copy that minted them — so
  brands make foreign handles *diagnosable*, never *usable*. (Error-
  contexts left this class in amendment A20: they are message-valued, so
  a branded foreign one carrying a string `message` lowers by minting a
  fresh local context — see §"Realm boundaries and structured-clone-safe
  forms".)
- Writer-side host ends (`hostStream()`-era API) remain the low-level seam
  underneath; the conventions layer exposes them as
  `Stream.create<T>(): { stream: Stream<T>, writer: StreamWriter<T> }`
  with `write`/`writeAll`/`writeDirect`/`cancelWrite`/`close`.
- **Component faults are loud on stream/future operations** (amendment
  A7). When the component instance holding the peer end traps, its live
  ends are retired: a parked host `read`/`write`/`writeAll`/future-await
  **rejects with `PeerTrappedError`** (`cause` chains to the trap; a
  write's `progress` reports elements delivered before the fault), and so
  does any operation started afterwards. A fault is never presented as a
  clean end-of-stream or a bare `DroppedError` — the same
  no-wrong-data-as-success rule the producer direction has
  (`StreamProducerError`) — with one precision: an operation that
  genuinely COMPLETED before the trap keeps its result (a full write, a
  read that copied data), and the fault surfaces on the export call and
  on the handle's next operation. A trapping host **import** drops the
  lifted stream/future arguments it abandoned, so their peers settle with
  the truthful short count / end-of-stream. Only embedder negligence —
  lowering a host end and never acting on it — still hangs, as documented
  since v0.2.
- **One in-flight operation per host end, per direction** (amendment A7):
  a second `write` while one is parked (or a second `read`, or a second
  future operation) throws a `TypeError` synchronously — the host-side
  spelling of the `CopyEnd` busy trap. Reading while a write is parked on
  the same stream stays legal (they are different ends). Previously the
  second operation could "rendezvous" against the first one's parked
  buffer and report data as taken by a peer that never existed.
- **Dropping an unwritten future is abandonment, not DROPPED** (amendment
  A8, polyengine#90). The CABI forbids a writable future end from dropping
  before delivering its value (definitions.py:1183-1184) — a guest doing
  so traps. The host-side spelling: `Future.drop()`/`[Symbol.dispose]` on
  a **lowered**, never-written future never throws and is idempotent; the
  guest-held readable end observes a **trap at its rendezvous point**
  ("the host dropped the writable end without writing a value") — pending
  read, later read, or waitable-set delivery alike — never a DROPPED
  event (which the CABI says a future reader cannot see) and never a
  hang. An unlowered future (the guest never saw it) just releases state.
  Producer failures (`Promise` rejection under `lowerFutureSource`) keep
  their A7-era reporting: the in-flight call fails site-named via the
  host-failure channel.
- **`cancelRead` is indistinguishable from end-of-stream — by design**
  (amendment A8, polyengine#97). A host-side `Stream.cancelRead()` settles the
  in-flight `read` with an empty chunk, which `readable()`/the async
  iterator present as clean EOS. The canceller is the same code observing
  the end, so no discriminated signal is warranted; pinned by test. (A
  *peer* fault is never presented this way — that is A7's rule.)
- **Direct-access byte edges** (amendment A21, 2026-08-22, polyengine#128 —
  wasmtime `DirectSource`/`DirectDestination`-shaped, `component::concurrent`
  47.0.3). For `stream<u8>` only, both host ends gain a form whose last hop
  *is* the single canonical-ABI copy, so external buffer movers (websocket
  frames, SAB-ring segments, transferred `ArrayBuffer`s) never pay a second
  copy inside the runtime:
  - `StreamWriter.writeDirect(produce)` and `Stream.readDirect(consume)`
    (with the same methods on the low-level `HostWritableEnd`/
    `HostReadableEnd` seam). Each parks a **direct session**: at every
    rendezvous with a peer operation of nonzero capacity, the callback runs
    **exactly once, synchronously, inside the rendezvous** — the guest's
    copy trampoline, or the host call that arrived second. `produce`
    receives a `DirectDestination` whose `remaining()` is the reader's
    unfilled landing zone; `consume` receives a `DirectSource` whose
    `remaining()` is the writer's unread bytes. When the peer is a guest,
    that view aliases **guest linear memory**: the embedder's own
    `set()`/`subarray` copy is the ABI copy. The callback's verdict is
    wasmtime's poll cadence spelled event-style: `"more"` keeps the session
    parked for the next rendezvous; `"done"` ends it, resolving the promise
    with the session's total byte count.
  - **Scope is the validity window.** The `DirectDestination`/`DirectSource`
    object dies when the callback returns; every later method call throws a
    `TypeError` naming the scoping rule. Views are re-derived per
    `remaining()` call (a `memory.grow` between rendezvous never yields a
    stale view), and retaining one past the callback is misuse. Inside the
    callback, calls that can run guest code or operate this stream are
    forbidden (reentrancy); the one-in-flight-per-end rule (A7) covers the
    stream's own operations, and `writeDirect`/`readDirect` participate in
    it exactly as `write`/`read` do.
  - **Marks acknowledge on clean return only.** `markWritten`/`markRead`
    accumulate within the invocation (over-marking throws). A callback that
    returns having marked ≥ 1 byte completes the peer's copy with that
    count. Returning `"done"` with **zero** marked is *retraction*: the
    session ends (promise resolves with its running total), the peer's
    operation stays parked, and no event is delivered — the speculative-park
    pattern (demand arrived while the producer's ring happened to be empty;
    re-arm when it fills). Zero marked with `"more"` is misuse: the session
    rejects with a `TypeError`. A callback that **throws** rejects the
    session with that error, and the invocation's marks are discarded —
    bytes physically written past the acknowledged progress are
    unobservable to the peer. In every outcome the peer's parked operation
    survives and the stream stays alive (the host still holds its end and
    may fall back to chunk forms); a runtime never emits a zero-progress
    COMPLETED copy, which is unreachable in definitions.py for a
    nonzero-capacity operation and which a guest may lawfully misread as
    end-of-stream.
  - **Zero-length-read readiness position** (Concurrency.md "Stream
    Readiness"): a parked direct session answers a zero-length probe with
    immediate COMPLETED — the armed session is the readiness claim — and
    the callback is **not** invoked. A producer that parks speculatively
    while knowingly empty is stretching that claim; the retraction path
    above is its correction.
  - **Host↔host at the same floor.** A direct session rendezvousing with a
    peer *chunk* end still costs one copy: `produce` against a host
    `read(max)` writes into a fresh scratch that becomes the delivered
    chunk (ownership passes with it); `consume` against a parked chunk
    `write` gets a scoped view of the offered chunk itself (the A5 borrow,
    scoped to the callback). Two direct sessions cannot rendezvous with
    each other — neither side owns memory — so the arriving side throws a
    `TypeError`: at least one side of a host↔host rendezvous uses chunk
    forms.
  - **Interplay with the existing rules, all inherited:** a peer trap
    rejects the session with `PeerTrappedError` carrying the delivered byte
    count, while a session the callback already completed keeps its result
    (A7 precision); reader/writer drop resolves the session with its total
    (the `write`/`writeAll` convention — a resolution the producer's own
    `"done"` did not cause is the reader-gone signal); `cancelWrite`/
    `cancelRead` retract a parked session (A8's indistinguishability
    caveats unchanged); the A15 transfer guard applies to `readDirect` as
    to `read`; a parked session is retention, so the deadlock-verdict arm
    stays live. `writeDirect` on an unbound `Stream.create()` writer parks
    until the lowering site binds the element type, then requires u8;
    `readDirect` on an unbound or non-u8 stream throws, as `read`'s
    refusals do.
  - **What is deliberately absent:** no ownership-transfer variant of the
    chunk forms — `write`/`writeAll`'s borrowed-until-settled contract (A5)
    already meets the one-copy floor, and `HostBuffer`'s `taken()` already
    passes a sole chunk through unsliced; no `list<u8>` intake/output form
    (same question, tracked separately); no conduit, credit, or realm
    machinery (the #128 scope ruling: deltic provides the byte edge, not
    the mover). SAB-backed `Uint8Array`s are legal on the embedder's side
    of every copy in both directions — the embedder performs the copy, so
    nothing here can reject them. The #97 `HostBuffer` length bound applies
    to the buffered path only: a direct session's capacity IS the peer's
    actual buffer size, already bounded by the guest's own `MAX_LENGTH`
    trap.

## Module wiring and instantiation

Canonical form — one nested record, keyed by verbatim interface id:

```ts
const instance = await instantiate(artifacts, {
  "wasi:clocks/monotonic-clock@0.3.0": { now, getResolution, waitFor, waitUntil },
  "polymorph:websocket/connections@0.1.0": { Websocket },   // resource class
  // world-level bare imports at the top level, camelCase
});
```

- Bindgen emits the world's `Imports` type (this record, fully typed), its
  `Exports` type, and a typed `instantiate` wrapper that **verifies the
  world digest** (`contracts/digest.md`) before instantiating anything
  (amendment A17, 2026-08-21). The obligation lives on the generated
  wrapper, not on the runtime's untyped `instantiate`: an untyped
  instantiation names no world, so there is no expected digest to check
  against. The wrapper resolves artifacts (translating first if given the
  A3 form — translation parses the component, it never runs guest code),
  compares the recomputed digest against the embedded `WORLD_DIGEST`, and
  throws a named, catchable mismatch error carrying the structural
  divergence; only then does it instantiate. So no guest code runs against
  bindings that do not match it. The generated `verify(plan)` helper and
  `WORLD_DIGEST` constant remain exported for embedders driving the
  untyped path, and `bind()` remains an explicitly UNCHECKED cast for
  callers that have already verified.
- **Untranslated artifacts** (A3): `instantiate` also accepts
  `{ componentBytes, translator }` where `translator` is the
  translator-shim wasm bytes or a shared `Translator` instance, and
  translates internally — bytes in, instance out. Prefer the shared
  instance across several instantiations (the wasm compile is the cost
  worth sharing; warm translation is sub-millisecond).
  `requiredImports` still takes a plan: translate explicitly to inspect
  the import surface before instantiating.
- **Build-time translation** (A4): the translation ENVELOPE (the
  single-file JSON from `Translator.translateRaw` / the `tools/translate`
  CLI, carrying plan + FACT adapters) is the blessed deploy artifact —
  production ships `component.wasm` + envelope + runtime, no translator.
  `artifactsFromEnvelope(envelopeJson, componentBytes)` reconstitutes
  `ComponentArtifacts`; the envelope's embedded component sha-256 is
  verified at instantiation, so a mismatched deploy pair fails loudly.
  Fetch-agnostic by design: the embedder acquires the two blobs.
- **Per-interface module authoring** (the consumers' file layout) is a
  helper over the same record: a module's named export, camelCase of the
  interface short-name, provides that interface
  (`export const connections = { Websocket }` in websocket.js survives
  as-is). The helper expands `"ns:pkg/*@0.2": mod` wildcards over
  interface *names only*, at a single version or track key; resolution
  across versions is solely the canonicalization rule above (never
  unversioned folding).
- `requiredImports(artifacts)` is a supported embedder API enumerating the
  component's linkable import leaves with kinds and types (C0 finding #8:
  `plan.imports` proved the right authority; blessing it removes every
  future embedder's hand-rolled equivalent).

## Module identity and @polyengine/protocol (amendment A9)

Consumer evidence (issue #83; wosh finding 26): in a source-distributed,
registry-less ecosystem nothing guarantees one copy of the runtime per
module graph — sibling package pins and separately-built bundles both
produced graphs with several coexisting copies, and every class-identity
check then fails *latently* (first error path, or a silently-pumped
stream), never at instantiation. A9 removes class identity from the
contract entirely.

**The protocol package.** `@polyengine/protocol` is a dependency-free
workspace package carrying the embedder contract's *vocabulary*: the
brand symbols, the canonical error classes (`ComponentException`, `Trap`,
`DroppedError`, `PeerTrappedError`, `InvalidHandleError`,
`StreamProducerError`), `suspending()`/`isSuspending`, the recognition
predicates, the copy registry, and `PROTOCOL_GENERATION`.
`@polyengine/runtime/embedder` re-exports all of it unchanged — existing
embedder code keeps working with no import changes. Host-module packages
SHOULD import `@polyengine/protocol` at most (never runtime values); with
hand-rolled brands (below) even that import is optional. Copies of the
protocol package are harmless by construction — identity never rests on
the package, only on the registry symbols.

**Brands.** Every brand is a `Symbol.for` registry symbol, so N copies of
the runtime (or of the protocol package) agree on every brand without
sharing modules. Keys are generation-suffixed; bumping a generation is a
breaking vocabulary change — an ecosystem migration event, the moral
equivalent of a semver major:

| brand key | carried by | marks |
|---|---|---|
| `polyengine.componentException/1` | `ComponentException.prototype` | err-result values |
| `polyengine.trap/1` | `Trap.prototype` | component-fatal errors |
| `polyengine.dropped/1` | `DroppedError.prototype` | dropped-future rejections |
| `polyengine.peerTrapped/1` | `PeerTrappedError.prototype` | peer-fault rejections (A7) |
| `polyengine.invalidHandle/1` | `InvalidHandleError.prototype` | resource-wrapper misuse |
| `polyengine.streamProducer/1` | `StreamProducerError.prototype` | producer-side failures |
| `polyengine.suspending/1` | the marked function / class prototype (A1/A2) | suspendable sync imports |
| `polyengine.stream/1` | `Stream.prototype` | embedder stream handles |
| `polyengine.future/1` | `Future.prototype` | embedder future handles |
| `polyengine.errorContext/1` | `ErrorContext.prototype` | error-contexts (message-valued at lowering since A20) |
| `polyengine.resourceState/1` | guest-resource wrappers (key for internal state; the state shape stays runtime-internal) | resource wrappers |
| `polyengine.pollable/1` | `Pollable.prototype` (the wasi package) | pollables |
| `polyengine.wasiExit/1` | `ExitError.prototype` (the wasi package) | wasi exit unwinds |
| `polyengine.runtimeCopies/1` | `globalThis` | the copy registry |

**The A18 key rename (2026-08-21).** These keys read `deltic.*/1` through
0.2.1, when the project was named deltic. A10 froze that spelling on the
argument that a brand key is an opaque constant whose text carries no
meaning, so renaming it would buy nothing and break pre-A10 copies and
hand-rolled brands. A18 renames them anyway, as part of moving the project
to `polymorph-components/polyengine` and the `@polyengine` scope: a
vocabulary whose every key names a project that no longer exists is a
standing tax on everyone who reads or hand-rolls one, and the consumer
family is small, known, and migrating in one step per repo.

The generation suffix **stays `1`**. It denotes the shape of the branded
vocabulary, which A18 does not touch — only the spelling of the keys
changed, and a spelling change already produces a completely disjoint
symbol set. Bumping to `/2` would carry no additional information: there is
no key under which an old copy and a new copy could meet and disagree.

The consequence is worth stating plainly, because it is quiet. A module
graph containing both a `@deltic/*@0.2.x` copy and a `@polyengine/*` copy
has two disjoint brand namespaces, so each copy's values are simply
unrecognized by the other: a cross-copy `ComponentException` is not
recognized as one, a `suspending()` mark does not read as suspending, and
the copy census (which is itself keyed by `…runtimeCopies/1`) sees only its
own namespace's copies and reports nothing unusual. There is no diagnostic
for this state and none is planned — the supported answer is that a graph
resolves exactly one engine, which is the same invariant A9 already asks
consumers to gate on (docs/consumers.md). Migrate an engine dependency in
one step; never partially.

**The A19 leaf rename (2026-08-22).** Through 0.3.x the err-result key
read `polyengine.witError/1`: A18 renamed every key's prefix but
deliberately kept the one leaf still spelling the pre-A10 class name,
citing the same opaque-constant argument A10 used to freeze it. That was
the wrong call — A18 was already a total break, so the leaf rename would
have been free — and keeping a key that names a class retired two
generations of naming ago is the same standing tax on readers and
hand-rollers that justified A18. A19 renames it to
`polyengine.componentException/1`, with A18's exact semantics: a hard
break with no compatibility spelling, no diagnostic (the two spellings
are disjoint symbols; a pre-A19 copy's exceptions are simply unrecognized,
exactly as described for A18 above), and the generation stays `1` for
A18's reason. The audit that produced A19 covered the whole table: every
other leaf matches its current class (minus the `Error` suffix,
camelCased) or its concept; `wasiExit` keeps its `wasi` prefix because a
bare `exit` is too generic for the flat key namespace (`pollable` needs
no prefix — the word is already WASI vocabulary); and the world-digest
`cewd` constant stays frozen, because it is hashed wire content that no
consumer reads or hand-writes — the opaque-constant argument A19 retires
for brand keys still holds where there is no reader.

**Brands are contract markers, not a security boundary.** A hand-rolled
object carrying the right brand is a legal value: an Error with
`[Symbol.for("polyengine.componentException/1")]: true` and a `payload` property IS a
ComponentException to every copy; a function with
`[Symbol.for("polyengine.suspending/1")]: true` IS suspending-marked. This is
what makes zero-import host modules possible. The canonical classes are
conveniences, not gatekeepers.

**Stateless vs stateful.** For the error classes and the suspending mark,
brand agreement is the whole story — a copy-B `ComponentException`
crossing a copy-A boundary is fully honored. Stateful values (stream/future handles,
resource wrappers) are different: their machinery lives
in the copy that minted them, so cross-copy use is impossible in
principle. For those, the brand converts "misclassified" into
"recognized-but-foreign": a named error listing both copies' URLs (see
§"Streams and futures" and the cross-store assert family, which now
distinguishes cross-copy from cross-store). Error-contexts sit between
the two since amendment A20: message-valued — any branded carrier of a
string `message` is honored at lowering by minting a fresh local context
(§"Realm boundaries and structured-clone-safe forms").

**The copy registry.** Each embedder module instance appends
`{ url, runtimeVersion, protocolGeneration }` (its `import.meta.url`) to
the array at `globalThis[Symbol.for("polyengine.runtimeCopies/1")]` when it
is evaluated. Multiple copies are **diagnosed, never refused** — two
isolated bundles on one page that exchange no values are legal. The
registry feeds the diagnostics: cross-copy errors name both URLs, and the
unbranded-throw trap (§"Error model") appends a copy census when more
than one copy is registered — a throw carrying *no* brand from a graph
with several copies is the #83 signature (typically a pre-A9 copy), and
the trap message says so instead of leaving a latent puzzle.

**Resolution discipline stays necessary** for efficiency (N copies still
cost N compiles and N bundle payloads) and for graphs containing pre-A9
copies: import maps are an application concern; host-module packages must
not carry `@polyengine/*` mappings in any config consumers resolve through
(docs/consumers.md records the convention).

**Identity is realm-local (issue #129).** Everything in this section is
per-realm by construction: a JS realm has its own module graph, so "copies
of the runtime" means copies *within one realm* — two realms (a window and
its worker, two workers, two Deno workers) are two runtimes, always, and
that is placement, not a defect the copy census diagnoses. No polyengine
value carries identity across a realm boundary. Workers are separate JS
agents, so even the `Symbol.for` registry — which spans same-agent realms —
does not span them; and structured clone strips prototypes and refuses
functions and symbol-keyed properties, so a handle, resource wrapper,
branded error, or suspending-marked function that crosses `postMessage`
arrives as an inert plain object, recognized by nothing (not even as
"recognized-but-foreign" — the cross-copy story above is same-realm only).
Structured-clone-safe *representations* for crossing realms are a separate
surface, defined by amendment A20 (§"Realm boundaries and
structured-clone-safe forms" below); recipes for worker-hosted topologies
live outside the runtime (#128). The complementary guarantee — that the
runtime, translator, and embedder paths themselves carry no Window or
main-thread-only dependencies, so a runtime placed IN a worker behaves
identically — is tested, not assumed: the conformance realm rows (Deno
worker slice, browser dedicated/shared-worker rows, OPFS worker smokes)
gate it in CI, and where a platform API differs by realm the runtime
depends on the intersection rather than detecting and branching.

## Realm boundaries and structured-clone-safe forms (amendment A20)

Consumer evidence (issue #131; polyvisor G5's SharedWorker device host):
recipe-layer proxies carry embedder-typed values across realm boundaries
over `postMessage`, and structured clone strips prototypes and
symbol-keyed properties — a branded error arrives as an unbranded husk
(`payload` gone), a `Stream` as an empty object. Two realms are two
runtimes by construction (issue #129), so no import-map discipline can
help; without a defined form every proxy author invents an ad-hoc
serialization, each subtly wrong. A20 defines the sanctioned crossing and
makes the unsanctioned one fail loudly at the sender.

**The API.** `@polyengine/protocol` exports:

```ts
function toCloneable(v: unknown, opts?: {
  /** Called for realm-local leaves instead of throwing; the substitute is
   *  walked in turn. Returning `undefined` (or the leaf itself) falls back
   *  to the refusal. */
  replace?: (leaf: object, path: string) => unknown;
}): unknown;
function fromCloneable(data: unknown): unknown;
```

`toCloneable` returns plain data safe for `structuredClone`/`postMessage`
— no transfer list required, so the shape also passes `BroadcastChannel`,
IndexedDB structured storage, etc. (a property of plain data, **not** a
compatibility promise; see the version rule below). `fromCloneable` walks
clone output and rehydrates every envelope into a value **branded by the
local copy** — a new local value with correct identity semantics, never
"the same" value. No RPC protocol, no automatic proxying, no cross-realm
identity.

**The round-trip law** (tested per taxonomy member):
`fromCloneable(structuredClone(toCloneable(v)))` is behaviorally
indistinguishable from `v` for every matcher this contract offers — the
recognition predicates, `payload`/`kind`/`value` access, `message`,
`cause` chains, `progress`, error-context `message`. Cause chains are
walked to their full depth through branded and unbranded links alike —
the canonical case is `PeerTrappedError.cause`, an unbranded recorded
poisoning failure whose own `cause` is the underlying `Trap`
(task/streams.ts): the trap at the bottom must still satisfy `isTrap`
after the crossing, or a proxy cannot distinguish a peer fault from a
clean drop's cousin. `stack` is carried
verbatim when present (the sender's stack is the diagnostically useful
one; the rehydration site's is noise).

**The envelope.** A plain object whose tag property
`"polyengine.cloneable/1"` holds the encoded value's brand key string. No
WIT-mapped value can collide with the tag — WIT identifiers cannot
contain `.` or `/`, and `map<K, V>` despecializes to a list of tuples,
never an object keyed by data — and `toCloneable` refuses an input plain
object that already carries the tag key, so the encoding needs no
escaping scheme. Detection is by brand, never `instanceof`, so
hand-rolled branded values (§"Module identity") encode identically to
canonical class instances. Coverage:

| tag value | encodes | fields besides the tag |
|---|---|---|
| `polyengine.componentException/1` | `ComponentException` | `message`, `stack?`, `cause?` (walked), `payload` (walked) |
| `polyengine.trap/1` | `Trap` | `message`, `stack?`, `cause?` (walked) |
| `polyengine.dropped/1` | `DroppedError` | `message`, `stack?`, `cause?` (walked) |
| `polyengine.invalidHandle/1` | `InvalidHandleError` | `message`, `stack?`, `cause?` (walked) |
| `polyengine.peerTrapped/1` | `PeerTrappedError` | `message`, `stack?`, `progress?`, `cause` (walked) |
| `polyengine.streamProducer/1` | `StreamProducerError` | `message`, `stack?`, `cause` (walked) |
| `polyengine.errorContext/1` | error-context (its message; see below) | `message` |
| `polyengine.wasiExit/1` | the wasi package's `ExitError` | `message`, `stack?`, `ok`, `code?` |
| `error` | an **unbranded** `Error` (cause chains) | `name`, `message`, `stack?`, `cause?` (walked) |

`fromCloneable` rehydrates the six error tags as canonical protocol class
instances; `error` as a plain `Error` with `name` restored;
`polyengine.wasiExit/1` as a hand-rolled branded `Error` carrying
`ok`/`code` (the protocol package does not import the wasi package — the
brand *is* the contract); `polyengine.errorContext/1` as a branded plain
object `{ message }`, which the runtime accepts at lowering (below). An
**unknown tag throws** `TypeError`: the envelope is version-internal, so
a tag this copy does not know means mixed engine versions — outside the
supported matrix, and failing loud beats a half-rehydrated tree.

**Walk semantics** (`toCloneable`; `fromCloneable` mirrors it):

- Pass through: `string`, `number`, `boolean`, `bigint`, `undefined`,
  `null`; `ArrayBuffer`, typed arrays, `DataView` (by reference — the
  serializer copies them).
- Walk into fresh containers: arrays; plain objects (prototype
  `Object.prototype` or `null`), own enumerable string-keyed properties.
- Encode: branded values per the table; unbranded `Error` instances as
  `error`. Envelope-encodable brands take precedence over the realm-local
  pill (an `ErrorContext` instance carries both; it encodes).
- Refuse with `InvalidHandleError` (whose documented meaning A20 widens
  from "resource-wrapper misuse" to handle misuse generally): realm-local
  leaves — anything `isRealmLocal`, anything carrying the `STREAM`,
  `FUTURE`, or `POLLABLE` brand, and resource wrappers (a defined
  `RESOURCE_STATE` property) — unless `replace` substitutes. Resources
  are realm-local by principle (their machinery lives in the minting
  copy's tables; issue #129's identity rule): **proxy the interface, not
  the handle.**
- Refuse with `TypeError`: functions, symbols, cyclic values, objects
  with any other prototype. `Map`/`Set`/`Date`/`RegExp` and other
  platform clonables cannot occur in WIT-mapped data and are passed
  through **unwalked** — a branded value hidden inside one is not
  converted (unsupported), and a realm-local handle hidden inside one
  still trips its pill at clone time.
- Every refusal message MUST name the path to the offending leaf (e.g.
  `payload.attempts[2].handle`) — that is the proxy author's debugging
  surface.

Aliasing within the input is not preserved (WIT values have no aliasing
semantics); a genuinely cyclic value is refused rather than looped over.

**Version-internal, not a wire format.** The supported matrix is the same
engine version in both realms — the family already pins one engine
version per tree (docs/consumers.md). The envelope shape may change in
any release with no compatibility spelling; never build persistence on
it.

**The realm-local pill.** Every instance of the realm-local classes —
`Stream`, `StreamWriter`, `Future`, `ErrorContext`, guest-resource
wrappers, the wasi package's `Pollable` — carries an **own, enumerable,
string-keyed** data property `"polyengine.realmLocal/1"` whose value is a
named function (`polyengineRealmLocalValue`), installed at construction.
Structured serialization visits own enumerable string-keyed properties
and refuses function values by construction, so a raw
`postMessage`/`structuredClone` of such a value — including one buried
inside a record the embedder posted raw — throws `DataCloneError` in the
**sender** realm instead of delivering a husk. The property must be a
string key (the serializer skips symbol keys) and own (it never visits
prototypes), which is why it cannot ride the A9 brand mechanism.
Collateral is deliberate: `JSON.stringify` omits function values and
spread copies an inert reference, so only clone paths trip. The
deterministic, explanatory error is `toCloneable`'s job; the pill is the
engine-enforced backstop for everyone who skips it. Vocabulary:
`REALM_LOCAL` (the key string), `defineRealmLocal(target)`,
`isRealmLocal(v)`, exported by `@polyengine/protocol`.

**Errors cannot be pilled.** The serializer takes the `[[ErrorData]]`
branch for `Error` instances: `name`/`message`(/`stack`) survive, custom
own properties and getters are never consulted. A raw-cloned branded
error therefore husks **silently** — brand and `payload` gone — and no
userland property can change that. That is precisely the gap
`toCloneable` exists to fill; the pill covers only the stateful handles,
and the two mechanisms partition the vocabulary exactly.

**Error-context is message-valued** (A20 semantic change, superseding
"lowering accepts only lifted instances", §"Streams and futures"). An
error-context's state is exactly its debug message (definitions.py), so
lowering accepts, besides this copy's lifted instances, **any** branded
carrier of a string `message` — a fresh local context is minted, a new
local value, never "the same" one. `fromCloneable`'s error-context output
is such a carrier, and so is a hand-rolled
`{ [Symbol.for("polyengine.errorContext/1")]: true, message }`. A branded
error-context **without** a string `message` keeps the loud A9 cross-copy
refusal — that shape is a genuinely foreign stateful handle, not a
message carrier.

A20 ships in `@polyengine/protocol` 0.2.0 — the same pending release as
A19's key rename (new exports; the runtime re-exports them unchanged, per
A9).

## Bindgen obligations (summary of what the above requires)

Per world: `Imports`/`Exports` types; resource classes (both directions);
`ComponentException` payload types per fallible function; value types per the
mapping table; the mangled-name assembly (`[method]r.f` ↔ `class` methods)
in both directions; stream/future adapters incl. pumping; the digest
handshake. The generated layer is an adapter over the runtime's raw
(definitions.py-shaped) boundary — see below.

## Implementation strategy (C2)

The ergonomic layer is generated code **on top of** the raw boundary; the
interpreter's internal shapes (single-key variants, `{some}/{none}`,
tuple-as-record) do not change in C2. Rationale: the raw shapes are pinned
by the reference-test ports and the conformance harness's value mapping —
converging the interpreter itself is a perf-track concern (P1's
descriptor-driven codegen can emit convention shapes directly, skipping
the adapter). Consequence: `instance.exports` stays internal-shaped and
documented as such; embedders use the bindgen layer (or accept the
internal surface with no stability promise).

## WASI examination (paper signatures)

Per the operator ruling (docs/architecture.md §2 / docs/consumers.md): implementations stay out of core,
but the conventions must make WASI interfaces natural. Idiomatic
signatures for the representative slice:

**wasi:clocks/monotonic-clock@0.3.0** (p3; C0-proven shape):

```ts
{ now(): bigint; getResolution(): bigint;
  waitUntil(when: bigint): Promise<void>;   // async func → async method
  waitFor(howLong: bigint): Promise<void> } // 4 lines over setTimeout; zero JSPI
```

**wasi:io@0.2.x pollable + streams** (p2): `pollable.block()`, `poll()`
and `blocking-read`/`blocking-write-and-flush` are **sync** WIT functions
that must park — the one p2 idiom that fights a JS host. The shim package
ships the PARKING KERNEL, always on (amendment A6, 2026-08-11;
supersedes the original three-tier ruling and its "never (c) in this
package" mission line — the polymorph-iroh upstream-iroh consumer class
genuinely parks, which the always-ready stubs turned into a livelock):
`block`/`poll` are `suspending()`-marked (A1/A2) with sync fast paths, so
a ready pollable costs one engine hop and only a genuine wait parks the
frame. Timer pollables are real (monotonic-clock subscribe-*). On engines
without JSPI, `chooseMode` degrades to plain and a genuine park raises a
clean `NeedsJspi` at the park site instead of livelocking; `jspi: false`
is the per-instantiation opt-out. Stream `read`/`check-write` stay plain
(sync, never park); the `blocking-*` stream declarations are marked
park-capable since amendment A14 — the buffer-backed defaults always
take the sync fast path, and the host-stdio cli impl is the first
genuinely-parking stream provider (a real stdin behind p2's sync
`blocking-read`).
`Pollable` is publicly constructible — `new Pollable(ready, wait)` — as
the interop seam for external providers (e.g. consumer-side sockets glue)
whose pollables the kernel `poll()`s uniformly; `wait()` follows the
promise-swap producer shape (settle + re-arm per event; spurious wakes
fine). Consequence for the M2 zero-cost pin: a component importing marked
providers auto-detects into jspi mode on JSPI engines even if it never
parks — "zero-cost plain path" now reads "sync-only plan AND no marked
imports" (see contracts/intrinsics.md). A pollable is a
thin class over host-supplied readiness:

```ts
class Pollable { ready(): boolean; block(): void /* tier (c) only */ }
// wasi:io/poll@0.2.x  poll: (in: Pollable[]) => Uint32Array indices — Promise.race under the hood
class InputStream {
  read(len: bigint): Uint8Array;             // throws ComponentException<StreamError>
  blockingRead(len: bigint): Uint8Array;     // tier (b)/(c)
  subscribe(): Pollable;
  [Symbol.dispose](): void;
}
```

**wasi:sockets@0.3.0 TCP** (p3, from the C0 leg-4 shopping list — 5
leaves): resources with async methods and stream-shaped I/O map directly:

```ts
class TcpSocket {
  static create(af: "ipv4" | "ipv6"): TcpSocket;       // result → throw ComponentException<ErrorCode>
  bind(addr: IpSocketAddress): void;
  connect(addr: IpSocketAddress): Promise<void>;        // async func
  send(data: Stream<number>): Promise<void>;            // called once; stream drives the connection
  receive(): Stream<number>;                             // Uint8Array chunks
}
```

**wasi:http@0.3 handler sketch** (p3 draft): the shape lands fetch-like
with no impedance:

```ts
// export handle: async func(request: request) -> result<response, error-code>
exports["wasi:http/handler@0.3.0"].handle(req: Request): Promise<Response>
// Request/Response are resource classes; .body(): Stream<u8> (Uint8Array
// chunks); trailers as Future<Fields>; err → ComponentException<ErrorCode>.
```

**polymorph:webrtc-datachannels `data-channel`** (the consumer reference):

```ts
class DataChannel {
  send(msg: Message): Promise<void>;                    // throws ComponentException<WebrtcError>
  receive(): Promise<Message>;
  receiveViaStream(): Stream<StreamMessage>;            // record { kind, length, data: Stream<u8> }
  [Symbol.dispose](): void;
}
// Message = { kind: "binary", value: Uint8Array } | { kind: "string", value: string }
// (StreamMessage's own record field named `kind` is untouched by the A10
// discriminant naming — record fields are plain properties, and a variant
// never merges its payload's fields into the discriminant object.)
```

Verdict of the examination: nothing in p2/p3 requires a convention not
already in this document; the only genuine friction is p2's sync-blocking
idiom, addressed by the three-tier strategy and made visible in types.

## Migration notes for the polymorph modules (jco → this API)

Small by design: camelCase, enum strings, flags objects, and
resource-classes-per-interface all carry over unchanged. The
real deltas: (1) err results are `throw new ComponentException(payload)`
instead of throwing the bare payload — and the defensive
`platformCall`-style wrappers can be deleted rather than ported; (2) jco
`Stream` objects (`read({count})`) become `Stream<T>`/`ReadableStream`;
(3) variant-family discriminants are `{ kind, value }`, not jco's
`{ tag, val }` (A10; mechanical rename), and nested results read
`{ kind: "ok" | "err", value }`; (4) transpile-time flags
(`--async-exports`/`--async-imports`, `check-flags.mjs`) have no
equivalent — asyncness comes from the binary; (5) `--map` wildcards
become the module-mapping helper, with version handling per "Version
canonicalization" (semver-track resolution, matching wasmtime's linker
— strictly more capable than jco's exact `--map` keys).

## C2 implementation requirements (normative checklist)

1. Version resolution per "Version canonicalization": exact-first, then
   track-alternate with max-wins; prerelease and `0.0.z` exact-only;
   track-key registration supported; same-track mixed registration
   refused; **unversioned folding banned** (C0 D-1). The shim ships one
   provider per track (`@0.2`, `@0.3`), union-shaped where consumer
   drafts diverge within a track.
2. `requiredImports()` public API over `plan.imports`.
3. Host-resource identity mapping (instance ↔ rep) in the runtime;
   `[Symbol.dispose]` dtor dispatch; ownership per the 2×4 table.
4. Stream/future conventions layer: producer adaptation, automatic
   pumping with auto-close on end/DROPPED, `cancelRead`/`cancelWrite`,
   `DroppedError`, double-wrap and cross-store asserts (R-fix review
   notes 1–4).
5. `ComponentException`/`Trap` branding at every host-import boundary;
   unbranded throw → trap naming the import.
6. Bindgen: `Imports`/`Exports` world types, resource classes both
   directions, mangled-key assembly, value types per the table.
7. WASI shim package (separate deliverable) implementing the p2 baseline
   (tier (a)/(b)) + p3 clocks against these conventions — the executable
   check that the conventions serve WASI (docs/consumers.md).
