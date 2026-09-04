# Embedder API conventions (host-facing)

The normative contract for host-facing value shapes and behavior. The
runtime's *raw* boundary (`instance.exports`, `HostImports`) keeps the
`definitions.py` interpreter shapes as an **internal** surface; the
conventions below are implemented by the bindgen-generated ergonomic layer
(see "Implementation strategy").

## Principles

1. **Fresh design; jco compatibility is a non-goal** (docs/architecture.md
   §2). Where jco's choice is also the right choice (camelCase, enum
   strings), we converge by merit. Where the emerging standard direction
   points elsewhere, we align upstream instead (`{kind, value}` variants
   per the WebAssembly/component-model PR #686 draft, a deliberate
   divergence from jco's `{tag, val}`).
2. **Footguns are design defects.** Every convention here is judged against
   the defensive code real host modules had to write under jco
   (bare-payload error throws, convention-only stream contracts,
   hand-transcribed mangled keys).
3. **One way to do each thing.** No dual error channels, no alternative
   value spellings. Liberal *acceptance* is allowed only where the TS type
   still names a single canonical form.
4. **TS-first.** Every shape must be expressible as a precise TypeScript
   type that bindgen can emit; discriminated unions over clever encodings.
5. **WASI interfaces must come out natural.** The conventions are validated
   against wasi p2/p3 idioms — the ecosystem's most important interfaces,
   and what every adopter's shims are written against. The `wasi/` package
   is the executable check.
6. **Async is the point.** Exports are uniformly Promise-shaped; async host
   imports are plain async functions.

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
canonicalization" below. *Unversioned* folding (version-agnostic keys
merging distinct semver tracks) is banned. Helpers may expand a wildcard
over interface *names* within one track, never across tracks.

## Version canonicalization

Authorities: Explainer.md §"canonical interface names" (`canonversion`,
🔗-gated) and wasmtime's
`wasmtime-environ::component::names::{NameMap, alternate_lookup_key}`
(used by both `component::Linker` and `Component::get_export`).

Every version belongs to a **compatibility track**, per the spec's
canonicalization split (identical to wasmtime's `alternate_lookup_key`):

| version | track key | notes |
|---|---|---|
| `1.2.3`, `1.0.0`, `2.1.2+abc` | `@1`, `@1`, `@2` | major > 0 → major is the track |
| `0.2.6`, `0.2.12` | `@0.2` | major 0 → minor is the track |
| `0.0.1` | none | patch-only versions are compatible with nothing |
| any prerelease (`0.2.0-rc-…`) | none (resolution) | prereleases are exact-only, as in wasmtime |

**Resolution rule (normative for `instantiate` and the wasi package):** an
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
**Unversioned interface ids** are legal exact-match keys — unversioned WIT
interfaces exist — but an unversioned key never serves a versioned import
nor vice versa; only *folding* (treating an unversioned key as a
cross-track wildcard) is banned.

Divergent drafts sharing a track (e.g. two `@0.3.0` snapshots naming
different function sets) are served by a **union** provider, with per-leaf
structural resolution selecting what each component actually imports; no
version machinery can or should distinguish them.

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
| `record` | plain object, camelCase fields | fields of option type are optional properties: lift emits **absent** (not `undefined`-valued) for none; lower accepts either spelling |
| `enum` | string literal union of kebab-case case names | `"offer" \| "answer" \| …` |
| `variant` | `{ kind: "case" }` \| `{ kind: "case", value: T }` | `value` **absent** (not `undefined`) for payloadless cases |
| `option<T>` | `T \| undefined`; **nested** options box | see rule below |
| `result<T, E>` **as a value** (nested in other types, or in parameter position) | `{ kind: "ok", value: T } \| { kind: "err", value: E }` | `value` absent for empty sides — same family as `variant` |
| `result<T, E>` **as a function result** (return position only) | return `T` / throw `ComponentException<E>` | empty sides: resolves `undefined` / `ComponentException.payload === undefined`; see "Error model" |
| `map<K, V>` | its despecialization `list<tuple<K, V>>` → `[K, V][]` | |
| `flags` | object of camelCase booleans | lift: every flag present; lower: absent = `false` |
| `own<R>` / `borrow<R>` | the resource class instance | see "Resources" |
| `stream<T>` / `future<T>` / `error-context` | `Stream<T>` / `Future<T>` / `ErrorContext` | see "Streams and futures" |

**Terminology note.** The spec calls variant alternatives **cases**
(Explainer, definitions.py `case_label`); prose here follows that. The
discriminant *property* is named `kind` with payload `value`, matching the
canonical variant dictionary in the draft JS-API
(WebAssembly/component-model PR #686, which also boxes
`option<option<T>>` into the variant family exactly as the option rule
below does) — if that shape holds, native support and this API agree for
free. `case` itself stays out: it is a JS reserved word — legal as a
property, but `v.case` reads like syntax. The value of `kind` is always
the case name, kebab-case verbatim.

**Why a discriminant property rather than `{ [case]: value }`** (the
single-key form the internal boundary used until issue #261):
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

Reason (3) turned out to be measurable rather than merely tidy, and the
internal boundary has since adopted the same `kind` discriminant for it
(issue #261, `contracts/descriptor-ir.md` §"Host value shapes"). It keeps
`value: null` for payloadless cases where this layer omits the property —
one shape per producer site measured faster than exact convergence.

**Option rule.** The *outermost* option in a chain maps to
`T | undefined`; every option nested **directly inside another option**
uses the variant family: `{ kind: "some", value: … } | { kind: "none" }`.
Only option maps to `undefined`, so this is the only ambiguity and the
boxing is exactly as deep as needed. Example (`option<option<u32>>`):

```ts
undefined                            // none
{ kind: "none" }                     // some(none)
{ kind: "some", value: 7 }           // some(some(7))
```

**Worked example** —
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
class Trap extends Error { … }  // component-fatal, never a value
class PeerTrappedError extends Error {  // a stream/future op whose peer instance trapped
  readonly cause: unknown;      // chains to the Trap
  readonly progress?: number;   // write ops: elements delivered before the fault
}
```

- **Guest export with `result<T, E>`**: the call resolves to `T` on ok and
  rejects (throws, for sync paths) with `ComponentException<E>` on err.
  `Trap` rejections are always distinguishable by class.
- **Host import with `result<T, E>`**: the host function returns `T` for
  ok and `throw`s `new ComponentException(payload)` for err — the ergonomic
  throw-for-error pattern, **branded**. (The draft JS-API converged on this
  shape — extends `Error`, structured `payload` — but names the class
  `WebAssembly.ComponentError`; renaming ours to follow is a breaking
  runtime+protocol event deliberately deferred until the draft stabilizes,
  tracked in issue #115. The draft also converts *any* thrown JS value to
  `E` at the import boundary — the branded-only rule below is a
  deliberate divergence.)
- **An unbranded throw from a host import is a host bug and becomes a
  trap** (with a message naming the import), never a guest-visible err —
  the inversion of jco's convention, where any stray `TypeError` was fed
  to the lift and host modules had to wrap every platform call
  defensively. Here the defensive wrapper is unnecessary by construction:
  only `ComponentException` crosses as an err value.
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
- **Recognition is by brand, not class**: every class above carries a
  process-global brand symbol, and the runtime's checks read the brand.
  Same-copy `instanceof` still works and stays the documented spelling in
  single-copy graphs; `@polyengine/protocol` exports predicates
  (`isComponentException`, `isTrap`, `isPeerTrappedError`, …) as the
  multi-copy-robust form. See §"Module identity and @polyengine/protocol".

## Functions and async

- **Exports are uniformly Promise-shaped**: bindgen types every export as
  returning `Promise<T>`, sync-typed or not (a sync completion resolves
  immediately). One calling convention; async-first per
  docs/architecture.md §1. Exactly two exceptions: resource constructors
  (synchronous — see Resources) and `future<T>`-typed results (eager
  handles — see Streams and futures). The default surface is
  Promise-shaped; a synchronous *view* of it exists as an explicit per-use
  adapter — `sync()`, below — and WIT getters/setters are pre-ruled to
  ride it as accessors once they become implementable (see §"Resources" →
  "Getters and setters").
- **Imports match their WIT type**: an `async func` import may be a plain
  `async` JS function (or return a value synchronously); a sync `func`
  import is typed to return `T` synchronously. Returning a Promise from a
  sync-typed import parks the calling **wasm frame** and is a *declared*,
  per-function capability: wrap the function in `suspending()` (defined in
  and imported from `@polyengine/protocol`). The marker
  - is per-declaration — only marked imports are handed to wasm as
    `WebAssembly.Suspending`, so unmarked imports keep the plain calling
    convention and sync-only components keep their zero-cost pin;
  - is auto-detection evidence — a marked import selects jspi mode without
    an explicit `jspi: true` (an explicit `jspi: false` still forces plain,
    where a returned Promise is refused);
  - carries real costs, deliberately visible: every call through a marked
    import pays the engine's continuation hop even when it returns
    synchronously (`contracts/intrinsics.md` pin (j)), and a marked import
    reached from a `start` function traps (pin (c): a start function may
    not block — the trap fires even for synchronous returns);
  - rides the engine floor: on a non-JSPI engine a marked import that
    returns a Promise is refused at the call site (`NeedsJspi`), never
    silently degraded.
  Scope: plain function imports (bare and interface members),
  host-resource **methods and statics** — mark instance methods on the
  class (the CLASS PROTOTYPE is the per-declaration brand authority, read
  at wrap time; instance-level overrides change the dispatched body, never
  suspendability), statics on the function itself. Constructors are never
  markable (synchronous, see Resources). Two spellings, one brand: the
  direct call (`f: suspending(fn)` — canonical, the only form available in
  record literals) and a stage-3 method decorator (`@suspending` on
  instance or static methods). The decorator refuses non-method positions
  and the legacy `experimentalDecorators` calling convention loudly, at
  class-definition time. Semantics of the park: the reference's
  `thread.wait_until(subtask.resolved)` (definitions.py canon_lower) — a
  plain non-cancellable wait; the instance-entry gate stays held; result
  lowering runs at resume time under the suspension point's attribution
  claim.
- **Interface members are invoked with their containing object as
  receiver**: a class instance is a fully supported spelling of an
  interface provider — methods reading instance state work, matching the
  resource static arm's behavior. World-level bare imports have no
  containing object and are called unbound.
- Params are positional; param names appear only in types/docs (they are
  excluded from the world digest — `contracts/digest.md`).
- **Between-calls liveness**: guest progress does not require an in-flight
  export call. A host import that settles while no call is being driven is
  serviced then — a background task parked on a waitable set whose pending
  host call resolves (a clock subscription, a fetch) resumes at settlement
  time, not at the embedder's next call. This is the JS-host analogue of
  dwelling in wasmtime's `run_concurrent`, and what makes
  guest-encapsulated keep-alive tickers (componentize-go's goroutine
  bridge over `wasi:clocks.wait-for`) self-driving under polyengine. Two
  bounds: an operation waiting on the *embedder's* half of a host
  stream/future still hangs until the embedder acts (never a trap — see
  Streams and futures), and a settlement-time failure surfaces on the next
  call into the instance.
- **Guest cancellation of an in-flight host import discards by default**
  (polyengine#241). A guest may cancel an in-flight async-typed import
  (`subtask.cancel`; wit-bindgen reaches it by dropping the import's
  future — its specified cancellation path). A JS host function offers no
  cancellation channel, so the runtime answers on its behalf, and the
  default answer is the reference's prompt-cancel host —
  `on_cancel = () => on_resolve(None)`, the shape `Store.invoke` expects a
  callee to hand back (definitions.py line 572): the subtask resolves
  `CANCELLED_BEFORE_RETURNED` immediately, both cancel forms return
  without blocking, and the host call's eventual settlement is
  **discarded** — the value is never lowered, a rejection is not reported
  anywhere (the guest renounced the call; there is no addressee), and the
  call stops counting as guest-wakeable for deadlock detection. The host
  operation itself is NOT interrupted: a Promise cannot be aborted from
  outside, so its side effects still run to completion. Discard is a
  statement about delivery, not about execution. (An embedder-supplied
  abort channel — notifying the host that its result was discarded — is
  deliberately out of scope here beyond `abortable()` below; see
  polyengine#241.)
- **`deferCancel()` opts an import out of discard**: a marked import
  must run to completion — a cancellation request is accepted and ignored,
  the async cancel form answers `BLOCKED`, the sync form parks under jspi
  (on a non-JSPI engine it is refused at the call site, `NeedsJspi`, per
  the engine floor), and the guest observes `RETURNED` with the real
  result when the promise settles. Mark imports with a commit point — a
  flush, a commit, anything where "cancelled" would let the guest believe
  nothing happened while the write lands. Two spellings, one brand
  (`polyengine.deferCancel/1`), exactly as `suspending()`: the direct call
  (`flush: deferCancel(fn)` — the only form available in record literals)
  and a stage-3 method decorator (`@deferCancel` on instance or static
  methods, with the same loud refusals of non-method positions and of the
  legacy `experimentalDecorators` convention; constructors are never
  markable). Defined in `@polyengine/protocol` and imported from there
  directly, like `suspending()` (the runtime's exported surface is
  application-only). The mark is tolerated and inert on sync-typed
  imports: their parks never mint a subtask handle, so they cannot be
  cancelled at all and the no-discard guarantee holds vacuously.
  Independent of `suspending()`; both brands may sit on one function.
- **`abortable()` hands an import a per-call `AbortSignal`, aborted on
  discard** (polyengine#241). Discard is a statement about delivery; the
  host operation itself keeps running — a discarded socket connect keeps
  connecting, a discarded timer keeps its callback armed. `abortable(fn)`
  opts an import into the platform's own cancellation vocabulary: every
  call receives a fresh `AbortSignal` appended after the WIT-declared
  parameters (`dial: abortable((addr, signal) => fetch(url, { signal }))`),
  and the runtime aborts that signal when — and only when — the call's
  subtask is discarded by a guest cancellation. The mark controls the
  SIGNATURE unconditionally (a marked function always receives a signal,
  so its arity is stable); the abort is discard-only. Ordering: the abort
  is scheduled on a microtask after the cancel built-in returns, never
  synchronously inside it — host listeners must not run inside a live
  guest activation — so the guest observes `CANCELLED_BEFORE_RETURNED`
  first and the host observes the abort a tick later. Any settlement the
  abort provokes (an `AbortError` rejection, a partial value) lands on
  the resolved-subtask guards and is discarded like any other late
  settlement. Two spellings, one brand (`polyengine.abortable/1`), exactly
  as the other marks; defined in `@polyengine/protocol` and imported from
  there directly. Inert wherever discard cannot happen — sync-typed
  imports (no subtask handle), `deferCancel` imports (cancellation never
  discards), calls that resolve eagerly — the signal simply never fires.
  The signal fires only for guest-initiated cancellation; instance
  teardown does not abort in-flight calls (future contract material).
- **`sync()` adapts a WIT-sync export to a synchronous call.** Some host
  contexts cannot usefully receive a Promise no matter how promptly it
  resolves: an event handler deciding whether to call `preventDefault()`
  before it returns, a sort comparator, a `Proxy` trap, a JS accessor.
  Even an already-resolved Promise defers observation by a microtask,
  which is too late for all of these. For a WIT-**sync** export whose
  guest completes synchronously — the overwhelmingly common case for
  sync-typed WIT — the runtime can deliver the result synchronously, and
  `sync()` is the explicit spelling for asking it to. The default surface
  stays Promise-shaped; `sync()` is an adapter the embedder applies per
  use, never a mode.

  **Placement and spelling.** `sync()` and its types (`Sync<F>`) are
  exported from `@polyengine/runtime/embedder` — application machinery,
  like `createStream`: only an instantiating application holds export
  functions, so this is deliberately NOT host-module vocabulary and does
  not touch `@polyengine/protocol`. A host module MUST NOT import the
  runtime to get it (§"The host-ABI surface and its version"): a host
  module whose shape wants a synchronous guest callback is **handed one
  by the application** — `sync(exports.f)` produces a plain function —
  exactly as a host module wanting writer-driven push is handed a
  `StreamWriter`; placement stays with the deploying application.
  Recognition is by brand (`polyengine.syncCallable/1`, a registry
  symbol) so views work across mixed runtime copies. Dispatch by target
  shape:

  - `sync(fn)` where `fn` is a lifted export function (plain export,
    interface member, or resource static): returns the synchronous form
    `(...args) => T`.
  - `sync(instance)` where `instance` is a guest-resource wrapper:
    returns a view object whose members call the synchronous forms with
    `instance` as receiver. Calling `sync(method)` on a bare prototype
    method throws (`TypeError`) naming the `sync(instance)` spelling —
    a free function cannot supply the receiver.
  - `sync(cls)` where `cls` is a guest-resource class: returns a view
    object of synchronous statics (constructors are already synchronous;
    `new` the class itself).
  - `sync(record)` where `record` is an exports record or nested
    interface record: returns a view with every member mapped by these
    same rules, recursively; non-branded members pass through unchanged.
  - Views are stable: repeated `sync(x)` on the same target returns the
    same view object.
  - `sync()` on an **async-typed** export throws `TypeError` at adapter
    time, naming the export and its async type: async WIT functions have
    no synchronous form by definition. Anything unbranded also throws
    `TypeError`.

  **Call semantics.** Arguments lower synchronously; the call enters
  through a plain (non-`promising`) entry; the reference's synchronous
  driving loop (`canon_lift`, definitions.py line 2213) runs the task to
  resolution; results lift synchronously. A `result<T, E>` in
  function-result position throws `ComponentException<E>` synchronously
  and resolves `T` otherwise, exactly as the Promise surface rejects and
  resolves; handle-valued results (streams, futures, resources) return
  their handles synchronously by the usual value mapping. Call-scoped
  borrows are released on completion or unwind, as on the async surface.

  **Failure ladder** (ordered; the first three are non-poisoning and
  leave the instance enterable):

  1. *Entry refusals* shared with the Promise surface (reentrance
     forbidden, poisoned-instance refusal naming the original trap) are
     thrown synchronously, before entering.
  2. *Hop-window contention* (jspi mode only): a promising-wrapped entry
     settles through a microtask hop even when nothing suspended, and the
     hop-quiescence gate defers Promise-surface calls that would race a
     pending lift. A synchronous call cannot defer, so it **refuses**
     instead: `SyncEntryBusy` (`e.name === "SyncEntryBusy"`), a
     transient, non-poisoning refusal — retry after in-flight activity
     settles, or use the Promise surface. The constructor sync entry
     shares this refusal.
  3. *Blocking built-in* reached through the plain entry: `NeedsJspi`, a
     capability error — same as the constructor rule.
  4. *Genuine suspension*: a `Suspending`-wrapped host import reached
     from the unwrapped frame fails as a trap, and a trap escaping a
     lifted call poisons the entered instances (CM poisoning semantics).
     This is the documented cost, stated loudly: `sync()` is for calls
     the embedder knows complete synchronously. A component instantiated
     with zero `suspending()`-marked imports and no async built-ins can
     never hit this arm.

  **Mechanics and cost.** In plain mode the lifted function already
  completes synchronously inside the entered bracket; `sync()` merely
  skips the Promise wrapper — near-zero cost. In jspi mode every
  sync-typed export carries a second, plain-entered lifted entry
  (`SYNC_ENTRY`; the constructor entry is one instance of it); like the
  constructor entry it is deliberately not recorded against the bridge
  invariant (entries wrapped iff imports wrapped) — safe because a
  synchronously-completing activation never reaches the Suspending seam.
  Unused sync entries cost nothing per call.

## Resources

Two directions, one surface: **a resource is a class instance on both
sides of the boundary.** Identity mapping and name mangling are
bindgen/runtime obligations, never the embedder's — no bare-number reps,
no hand-rolled identity tables, no hand-transcribed `[method]…` keys.

**Guest-implemented resources** (host holds handles): bindgen emits a
class per resource — constructor calls the guest constructor; methods and
statics camelCase; `[Symbol.dispose]()` and `drop()` both drop the handle
(TS `using` works); a `FinalizationRegistry` backstop drops leaked handles
(docs/architecture.md §7). Passing an instance where `own<R>` is expected
**invalidates the wrapper** (further use throws); passing as `borrow<R>`
leaves it usable after the call returns.

**Host-implemented resources** (guest holds handles): the host provides a
plain class implementing the bindgen-emitted interface (camelCase methods;
statics as static members; the WIT constructor as the JS constructor). The
runtime owns the instance↔rep mapping. When the guest drops its last own
handle, the runtime calls `instance[Symbol.dispose]?.()` (dtor). Method
`self` is the instance — no reps, no side tables.

**Constructors are synchronous**: a JS class constructor cannot await, so
`new R(...)` is one of the two exceptions to Promise-shaped exports
(§"Functions and async"). A guest constructor that does not complete
synchronously raises a named error rather than half-constructing; if a
consumer ever needs a suspending constructor, the escape hatch is a
generated async static factory — deferred until demanded. The
constructor's plain entry is one instance of the general `SYNC_ENTRY`
mechanism and shares its failure ladder, including the `SyncEntryBusy`
hop-window refusal.

Ownership at the boundary, both directions:

| WIT position | guest-implemented R | host-implemented R |
|---|---|---|
| host receives `own<R>` | new class instance (host now owns; drop/`using` it) | the host's own instance back; the guest's handle is gone; no dispose call |
| host receives `borrow<R>` | instance valid **only during the call** (retention throws) | the host's own instance; borrow scoping is guest-side bookkeeping |
| host passes `own<R>` | wrapper invalidated (transferred) | instance registered; guest owns its handle |
| host passes `borrow<R>` | wrapper stays valid | guest must not retain past the call (runtime-enforced per CABI); a never-registered instance gets a rep allocated for the call's duration |

### Pattern (non-normative): binding platform classes directly

A host-implemented resource does not need a hand-written class: when a WIT
resource's shape matches a native platform class, pass the class itself —
the pattern the draft JS-API builds its import story on
(WebAssembly/component-model PR #686: the constructor satisfies the
resource type import, tagged `[method]`/`[static]` imports are read off it
and its `.prototype`; tracked in polyengine#115), available here today
because the pieces already line up: method dispatch is a per-call
`self[camelCase(member)]` lookup, WIT constructor args flow to
`new Class(...)`, and the value conventions are the natural JS shapes
(`Uint8Array` IS a `BufferSource`; a record is a plain camelCase object,
i.e. an options bag).

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
   only for guests that call the member. (Consequence: a suspending
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

### Getters and setters (pre-ruling — not yet implementable)

Upstream, WebAssembly/component-model#701 (approved, emoji-gated 📡) adds
property getters and setters to WIT and the name mangling: `[get]foo` /
`[set]foo` at interface level, `[method][get]r.foo` / `[method][set]r.foo`
on resource instances, `[static][get]r.foo` / `[static][set]r.foo` on
resource types. Validation upstream: getters take no parameters (beyond
`self`) and must return a value; setters take exactly one parameter
(beyond `self`) and return nothing or `result<_, error?>`; **`[get]`/
`[set]` functions must not be `async`**; every `[set]` requires its
`[get]`; getter/setter type agreement is deliberately not required
(WebIDL `PutForwards` precedent). Implementation here is blocked on the
toolchain (spec merge → wit-parser/wasm-tools → a wasmtime release
carrying the 📡 gate → bumping the pinned `wasmtime-environ`); the
dependency chain is tracked in polyengine#254. This section pre-rules the
JS shape so the eventual implementation is mechanical.

**Export side (guest-implemented): real JS accessors, sync-required both
directions.** Bindgen emits `get prop(): T` / `set prop(v)` as true
accessors — on resource classes for `[method]` forms, as static accessors
for `[static]` forms, and on the exports record for interface-level
forms. Accessors ride `sync()`'s calling convention: the underlying calls
enter through `SYNC_ENTRY` and share its failure ladder, so a guest
getter/setter that parks fails with the named errors rather than
half-working. Accessors thereby join constructors as sync-required
contexts (a JS getter *could* return a Promise, but a JS setter cannot
express async completion or rejection at all — the assignment expression
discards the setter's continuation; symmetric sync-required semantics
are ruled to match, and match WebIDL expectations). A fallible setter
(`result<_, error?>`) throws `ComponentException` synchronously.
Divergent getter/setter types map to TS 4.3+ asymmetric accessor types.
The WASI migration path (`get-prop`/`set-prop` *methods*) stays
Promise-shaped like any method; where the spec permits both spellings to
coexist and a bindings collision results, **the accessor wins** and the
shadowed method is dropped with a bindgen warning (the spec sanctions
generator choice here).

**Import side (host-implemented): property get and assignment on the
containing-object receiver.** `[get]foo` dispatches as a property read of
`self[camelCase(foo)]` (or of the containing interface object for
interface-level forms) and `[set]foo` as the corresponding assignment —
per call, receiver rules unchanged. This retires limit 1 of the
platform-class pattern above for WIT worlds that declare accessors:
`URLSearchParams.prototype.size` becomes bindable as `size: get() ->
u32`. Accessors are never `suspending()`-markable (consistent with the
upstream not-`async` rule, with the wrap-time probe's
data-properties-only constraint, and with `@suspending`'s existing loud
refusal of accessor positions); a host getter that returns a Promise is
refused exactly as any sync-typed import returning a Promise without the
mark.

**Until support lands**: the runtime refuses unknown bracket forms in
mangled names loudly at instantiation (rather than misbinding them as
plain names — a `[get]foo` treated as a function named `[get]foo` would
be wrong in both directions), and the translator keeps the upstream
feature gate off. Digest impact: none expected — mangled externnames
differ textually and function kind is not separately hashed.

## Streams and futures

Handles, not raw shared objects (`SharedStreamImpl` identity stays
internal):

```ts
interface Stream<T> {
  readable(): ReadableStream<Chunk<T>>;    // web-native; Chunk<u8> = Uint8Array, else T[]
  [Symbol.asyncIterator](): AsyncIterator<Chunk<T>>;
  read(max: number): Promise<Chunk<T>>;    // low-level; empty chunk = end
  readDirect(                              // stream<u8> only — see "Direct-access byte edges"
    consume: (src: DirectSource) => "more" | "done",
  ): Promise<number>;
  cancelRead(): void;
  drop(): void;                            // [Symbol.dispose] alias
}
interface Future<T> extends PromiseLike<T> {  // await it directly
  drop(): void; cancel(): void;
}
// Direct-access byte edges (stream<u8> only). The writer-side mirror lives
// on StreamWriter:
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
class ErrorContext { readonly message: string }  // lift-only constructor-wise; lowering also accepts any branded string-`message` carrier by minting a fresh local context
class DroppedError extends Error { … }    // awaiting a dropped future rejects with this
```

These interfaces (plus `StreamWriter<T>` and the aux types) are exported,
executable, from `@polyengine/protocol`, with brand predicates
`isStream`/`isStreamWriter`/`isFuture`/`isErrorContext`; the runtime's
concrete classes implement them and are not exported (§"The host-ABI
surface and its version").

- **Future results are eager handles**: an export whose WIT result is
  `future<T>` returns `Future<T>` **directly**, not `Promise<Future<T>>` —
  JS promise resolution unconditionally adopts thenables, so a Promise can
  never resolve *to* a PromiseLike handle; wrapping would make
  `drop`/`cancel` unreachable. `await exportFn()` still yields `T` (the
  handle is thenable); call without awaiting to hold the handle. Streams
  are unaffected (`Stream` is not thenable).
- **Lifted** `stream<T>`/`future<T>` values arrive as `Stream<T>`/
  `Future<T>`. Awaiting a future whose write end dropped without a value
  rejects with `DroppedError` (discriminated).
- **Handle disposal is total and silent** (polyengine#182). `drop()` and
  `cancel()` on a `Future<T>` are plain handle operations: they never
  throw, never return a promise, and never surface a failure of the call
  that produces the future's host end. A future obtained from an export
  call is DEFERRED — its host end materializes when that call completes —
  so a handle held without awaiting (the blessed spelling above) can
  outlive a failing producer; disposing such a handle discards the failure
  rather than raising it out of band. The failure is not lost: it still
  surfaces to anyone awaiting the future (or reading it), which is the
  only place the embedder asked for a value. Runtimes must therefore
  attach rejection handling at the handle itself, so that neither
  `cancel()`, `drop()`, nor a handle abandoned untouched can raise an
  unhandled rejection at the process level.
- **Lowering accepts the natural JS producers**: where the guest expects a
  `stream<T>`, the host may pass a `ReadableStream`, an `AsyncIterable`,
  an array (finite), or a `Stream<T>` handle; for `future<T>`, a
  `Promise<T>` or `Future<T>`. A `Future<T>` **handle** is lowerable once
  its host end has materialized (its producing call completed — the
  deferred window above); lowering a still-deferred handle is refused
  loudly, never queued (a thenable or `Promise` has no such window and is
  always accepted). Bindgen adapts and **owns the pumping**: the driving
  arms auto-close on end/`DROPPED` (eliminating the deadlock-masking
  activity-lifetime footgun), and cross-store reuse is a runtime-asserted
  error, not silent misbehavior.
- **An import whose WIT result type is `future<T>` returns the future
  source.** A thenable returned by the host method — a `Promise<T>` or a
  `Future<T>` handle — is lowered as the future itself: the import call
  completes immediately, and the future settles on the producer's
  schedule. It is **not** adopted as the call's async completion (under
  which a sync-typed import returning a Promise would be a JSPI park
  request — and a `Future` handle, being `PromiseLike`, would be silently
  awaited and re-lowered). The natural spelling of the `wasi:sockets@0.3`
  TCP `send` shape — `send: func(data: stream<u8>) -> future<result<_,
  error-code>>` as an `async` JS method whose promise resolves when
  transmission completes — depends on this: the future settles only after
  post-return guest action (the guest writes `data` after `send` returns),
  so adopting the thenable is a livelock, not a semantics choice. A
  **rejected** future-source promise stays a producer failure on the
  host-failure channel (site-named, surfacing on the consuming call — same
  as every producer), never a guest-visible err value: a fallible payload
  rides *inside* the future (`future<result<…>>`), resolved as a result
  value. Executable spec: `examples/guests/future-import` +
  `runtime/tests/embedder/future_result_test.ts`.
- **Streams of resources are first-class** (the `wasi:sockets@0.3` TCP
  `listen` shape, `func() -> result<stream<tcp-socket>, error-code>`). A
  host producer for `stream<own<R>>` yields resource-class instances; each
  element lowers through the normal `own` transfer (host-implemented R:
  the instance registers, the guest's drop runs `[Symbol.dispose]`;
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
    the peer-fault teardown walk) while the producer is PARKED — an
    accept-shaped source awaiting an external event, with no write in
    flight for the pump to observe — the pump cancels it: a
    `ReadableStream` source via `reader.cancel()`, an (async-)iterable
    source via its optional `cancel(): void` method (close your listener
    there; the pump then drains the pending pull, so a straggler element
    still reaches the un-taken release path). A source with no cancel
    hook stays parked until its next element — the documented
    embedder-negligence hang class.
  - **World-level host resources register under the resource's own
    (camelCase) name**, and their mangled member leaves
    (`[method]r.m`, `[static]r.m`, `[constructor]r`) dispatch on that
    class — the world-level analogue of "the resource CLASS sits at the
    resource's position" for interface imports.
  Executable spec: `examples/guests/resource-stream` +
  `runtime/tests/embedder/resource_stream_test.ts`.
- **Stream values survive round trips.** A `stream`/`future` is an
  identity: lifting one that the host already handled — a host-created
  stream a guest passed back (result or import position), or a
  guest-created stream on its second hop — is **idempotent**, yielding a
  handle over the same underlying end rather than a double-wrap error.
  Consequences, all normative:
  - host → guest → host pass-through works with the guest never reading;
    the payload then moves host↔host without touching guest memory;
  - a readable end may hop the boundary any number of times (each lower
    transfers it, exactly as between two guests);
  - host↔host rendezvous is legal for **every** element type — the
    same-instance restriction applies to component instances only;
  - a `createStream()` writer keeps feeding the same stream across hops
    (the writer half addresses the shared end, not a particular handle).
- **Deadlock-verdict suppression tracks host retention** (issue #162).
  While the host retains a way to act on a stream/future — a retained
  end, a parked host operation, or an unfinished producer pump — a
  stalled guest is reported as the documented embedder-may-act hang,
  never a deadlock trap. That claim **expires with retention**: lowering
  a lifted handle back into a guest (the
  `identity: async func(s: stream<u8>) -> stream<u8>` round trip) hands
  the host's only end back, so the store's deadlock verdicts are live
  again immediately; a later re-lift of the same shared object (the
  round-trip cache-hit wrapper) restores the suppression; and every drop
  path — either end, the peer-fault teardown walk, instance retirement —
  releases it. Companion refusal: `read` through a `Stream` handle — and
  awaiting a `Future` — that was already passed to a guest rejects with a
  `TypeError` naming the transfer; a post-transfer host read would
  operate a phantom duplicate of an end the guest now owns.
  `StreamWriter` operations are unaffected (the writer half addresses the
  host-retained writable end across hops). Retention-by-choice is
  unchanged: a host that returns a *different* stream while quietly
  keeping the original's end is genuine retention, and the
  embedder-negligence hang class remains.
- **u8 chunks are `Uint8Array` in both directions** (the write-side
  mirror of `Chunk<u8>`): `StreamWriter.write`/`writeAll` take
  `Chunk<T>`, and a `Uint8Array` chunk is treated as already-lowered bytes
  — passed by reference to the rendezvous (borrowed until the returned
  promise settles) and copied exactly once, at the rendezvous itself.
  Reads hand back that copy unchanged: one copy end-to-end for
  host↔host, one memory copy each way when a guest is the peer.
- **Foreign-copy handles are recognized and refused, loudly.** A
  `Stream`/`Future` (or a resource wrapper) minted by a *different
  runtime copy* is recognized by its brand at lowering and raises a named
  cross-copy error listing both copies' URLs — never a silent
  producer-adaptation fallback (which would pump a foreign `Stream` by
  its async iterator, quietly voiding the identity guarantees above).
  Remediation is by value, explicitly: pipe a foreign stream via
  `.readable()`, a foreign future via `Promise.resolve(f)`. Handles are
  stateful — their machinery lives in the copy that minted them — so
  brands make foreign handles *diagnosable*, never *usable*.
  (Error-contexts are exempt: they are message-valued, so a branded
  foreign one carrying a string `message` lowers by minting a fresh local
  context — see §"Realm boundaries and structured-clone-safe forms".)
- Writer-side host ends remain the low-level seam underneath; the
  conventions layer exposes them as the application-surface factory
  `createStream<T>(): { stream: Stream<T>, writer: StreamWriter<T> }`
  with `write`/`writeAll`/`writeDirect`/`cancelWrite`/`close`.
- **Component faults are loud on stream/future operations.** When the
  component instance holding the peer end traps, its live ends are
  retired: a parked host `read`/`write`/`writeAll`/future-await
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
  lowering a host end and never acting on it — still hangs.
- **One in-flight operation per host end, per direction**: a second
  `write` while one is parked (or a second `read`, or a second future
  operation) throws a `TypeError` synchronously — the host-side spelling
  of the `CopyEnd` busy trap. Reading while a write is parked on the same
  stream stays legal (they are different ends).
- **Dropping an unwritten future is abandonment, not DROPPED**
  (polyengine#90). The CABI forbids a writable future end from dropping
  before delivering its value (definitions.py:1183-1184) — a guest doing
  so traps. The host-side spelling: `Future.drop()`/`[Symbol.dispose]` on
  a **lowered**, never-written future never throws and is idempotent; the
  guest-held readable end observes a **trap at its rendezvous point**
  ("the host dropped the writable end without writing a value") — pending
  read, later read, or waitable-set delivery alike — never a DROPPED
  event (which the CABI says a future reader cannot see) and never a
  hang. An unlowered future (the guest never saw it) just releases state.
  Producer failures (`Promise` rejection under `lowerFutureSource`) keep
  the loud-fault reporting above: the in-flight call fails site-named via
  the host-failure channel.
- **`cancelRead` is indistinguishable from end-of-stream — by design**
  (polyengine#97). A host-side `Stream.cancelRead()` settles the
  in-flight `read` with an empty chunk, which `readable()`/the async
  iterator present as clean EOS. The canceller is the same code observing
  the end, so no discriminated signal is warranted; pinned by test. (A
  *peer* fault is never presented this way — see "Component faults".)
- **Direct-access byte edges** (polyengine#128 — wasmtime
  `DirectSource`/`DirectDestination`-shaped, `component::concurrent`
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
    forbidden (reentrancy); the one-in-flight-per-end rule covers the
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
    `write` gets a scoped view of the offered chunk itself (the borrow,
    scoped to the callback). Two direct sessions cannot rendezvous with
    each other — neither side owns memory — so the arriving side throws a
    `TypeError`: at least one side of a host↔host rendezvous uses chunk
    forms.
  - **Interplay with the existing rules, all inherited:** a peer trap
    rejects the session with `PeerTrappedError` carrying the delivered byte
    count, while a session the callback already completed keeps its result;
    reader/writer drop resolves the session with its total (the
    `write`/`writeAll` convention — a resolution the producer's own
    `"done"` did not cause is the reader-gone signal); `cancelWrite`/
    `cancelRead` retract a parked session (the EOS-indistinguishability
    caveat unchanged); the post-transfer read refusal applies to
    `readDirect` as to `read`; a parked session is retention, so the
    deadlock-verdict arm stays live. `writeDirect` on an unbound
    `createStream()` writer parks until the lowering site binds the element
    type, then requires u8; `readDirect` on an unbound or non-u8 stream
    throws, as `read`'s refusals do.
  - **What is deliberately absent:** no ownership-transfer variant of the
    chunk forms — `write`/`writeAll`'s borrowed-until-settled contract
    already meets the one-copy floor, and `HostBuffer`'s `taken()` already
    passes a sole chunk through unsliced; no `list<u8>` intake/output form
    (same question, tracked separately); no conduit, credit, or realm
    machinery (the #128 scope ruling: polyengine provides the byte edge,
    not the mover). SAB-backed `Uint8Array`s are legal on the embedder's
    side of every copy in both directions — the embedder performs the copy,
    so nothing here can reject them. The `HostBuffer` length bound
    (polyengine#97) applies to the buffered path only: a direct session's
    capacity IS the peer's actual buffer size, already bounded by the
    guest's own `MAX_LENGTH` trap.

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
  world digest** (`contracts/digest.md`) before instantiating anything.
  The obligation lives on the generated wrapper, not on the runtime's
  untyped `instantiate`: an untyped instantiation names no world, so there
  is no expected digest to check against. The wrapper resolves artifacts
  (translating first if given the untranslated form below — translation
  parses the component, it never runs guest code), compares the recomputed
  digest against the embedded `WORLD_DIGEST`, and throws a named,
  catchable mismatch error carrying the structural divergence; only then
  does it instantiate. So no guest code runs against bindings that do not
  match it. The generated `verify(plan)` helper and `WORLD_DIGEST`
  constant remain exported for embedders driving the untyped path, and
  `bind()` remains an explicitly UNCHECKED cast for callers that have
  already verified.
- **Untranslated artifacts**: `instantiate` also accepts
  `{ componentBytes, translator }` where `translator` is the
  translator-shim wasm bytes or a shared `Translator` instance, and
  translates internally — bytes in, instance out. Prefer the shared
  instance across several instantiations (the wasm compile is the cost
  worth sharing; warm translation is sub-millisecond).
  `requiredImports` still takes a plan: translate explicitly to inspect
  the import surface before instantiating.
- **Build-time translation**: the translation ENVELOPE (the single-file
  JSON from `Translator.translateRaw` / the `tools/translate` CLI,
  carrying plan + FACT adapters) is the blessed deploy artifact —
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
  component's linkable import leaves with kinds and types — the blessed
  replacement for every embedder's hand-rolled walk of `plan.imports`.

## Module identity and @polyengine/protocol

In a source-distributed, registry-less ecosystem nothing guarantees one
copy of the runtime per module graph — sibling package pins and
separately-built bundles both produce graphs with several coexisting
copies, and every class-identity check then fails *latently* (first error
path, or a silently-pumped stream), never at instantiation. Class
identity is therefore not part of this contract at all.

**The protocol package.** `@polyengine/protocol` is a dependency-free
workspace package carrying the embedder contract's *vocabulary*: the
brand symbols, the canonical error classes (`ComponentException`, `Trap`,
`DroppedError`, `PeerTrappedError`, `InvalidHandleError`,
`StreamProducerError`), the import marks
(`suspending`/`deferCancel`/`abortable` and their predicates), the
recognition predicates, the handle interfaces (§"The host-ABI surface and
its version"), realm crossing (§"Realm boundaries"), the copy registry,
and `PROTOCOL_GENERATION`. Host-module packages import
`@polyengine/protocol` at most (never the runtime — see §"The host-ABI
surface"); with hand-rolled brands (below) even that import is optional.
Copies of the protocol package are harmless by construction — identity
never rests on the package, only on the registry symbols.

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
| `polyengine.peerTrapped/1` | `PeerTrappedError.prototype` | peer-fault rejections |
| `polyengine.invalidHandle/1` | `InvalidHandleError.prototype` | handle misuse |
| `polyengine.streamProducer/1` | `StreamProducerError.prototype` | producer-side failures |
| `polyengine.suspending/1` | the marked function / class prototype | suspendable sync imports |
| `polyengine.deferCancel/1` | the marked function | imports exempt from cancel-discard |
| `polyengine.abortable/1` | the marked function | imports receiving a per-call AbortSignal |
| `polyengine.syncCallable/1` | lifted export functions and guest-resource members (defined in the runtime — application-tier, not host-module vocabulary) | sync-callable exports and their synchronous forms |
| `polyengine.stream/1` | `Stream.prototype` | embedder stream handles |
| `polyengine.streamWriter/1` | `StreamWriter.prototype` | embedder stream writer handles |
| `polyengine.future/1` | `Future.prototype` | embedder future handles |
| `polyengine.errorContext/1` | `ErrorContext.prototype` | error-contexts (message-valued at lowering) |
| `polyengine.resourceState/1` | guest-resource wrappers (key for internal state; the state shape stays runtime-internal) | resource wrappers |
| `polyengine.pollable/1` | `Pollable.prototype` (the wasi package) | pollables |
| `polyengine.wasiExit/1` | `ExitError.prototype` (the wasi package) | wasi exit unwinds |
| `polyengine.runtimeCopies/1` | `globalThis` | the copy registry |

(Leaf naming: each key matches its current class — minus the `Error`
suffix, camelCased — or its concept. `wasiExit` keeps its `wasi` prefix
because a bare `exit` is too generic for the flat key namespace;
`pollable` needs no prefix — the word is already WASI vocabulary. The
world-digest `cewd` constant is hashed wire content that no consumer
reads or hand-writes, so it is frozen independently of key-naming
conventions.)

**Brands are contract markers, not a security boundary.** A hand-rolled
object carrying the right brand is a legal value: an Error with
`[Symbol.for("polyengine.componentException/1")]: true` and a `payload`
property IS a ComponentException to every copy; a function with
`[Symbol.for("polyengine.suspending/1")]: true` IS suspending-marked. This
is what makes zero-import host modules possible. The canonical classes are
conveniences, not gatekeepers.

**Stateless vs stateful.** For the error classes and the import marks,
brand agreement is the whole story — a copy-B `ComponentException`
crossing a copy-A boundary is fully honored. Stateful values
(stream/future handles, resource wrappers) are different: their machinery
lives in the copy that minted them, so cross-copy use is impossible in
principle. For those, the brand converts "misclassified" into
"recognized-but-foreign": a named error listing both copies' URLs (see
§"Streams and futures" and the cross-store assert family, which
distinguishes cross-copy from cross-store). Error-contexts sit between
the two: message-valued — any branded carrier of a string `message` is
honored at lowering by minting a fresh local context (§"Realm boundaries
and structured-clone-safe forms").

**The copy registry.** Each embedder module instance appends
`{ url, runtimeVersion, protocolGeneration }` (its `import.meta.url`) to
the array at `globalThis[Symbol.for("polyengine.runtimeCopies/1")]` when it
is evaluated. Multiple copies are **diagnosed, never refused** — two
isolated bundles on one page that exchange no values are legal. The
registry feeds the diagnostics: cross-copy errors name both URLs, and the
unbranded-throw trap (§"Error model") appends a copy census when more
than one copy is registered — a throw carrying *no* brand from a graph
with several copies is the multi-copy signature, and the trap message
says so instead of leaving a latent puzzle.

**Resolution discipline stays necessary** for efficiency (N copies still
cost N compiles and N bundle payloads): import maps are an application
concern; host-module packages must not carry `@polyengine/*` mappings in
any config consumers resolve through (docs/consumers.md records the
convention).

**Identity is realm-local** (issue #129). Everything in this section is
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
Structured-clone-safe *representations* for crossing realms are the next
section's surface; recipes for worker-hosted topologies live outside the
runtime. The complementary guarantee — that the runtime, translator, and
embedder paths themselves carry no Window or main-thread-only
dependencies, so a runtime placed IN a worker behaves identically — is
tested, not assumed: the conformance realm rows (Deno worker slice,
browser dedicated/shared-worker rows, OPFS worker smokes) gate it in CI,
and where a platform API differs by realm the runtime depends on the
intersection rather than detecting and branching.

## Realm boundaries and structured-clone-safe forms

Recipe-layer proxies carry embedder-typed values across realm boundaries
over `postMessage`, and structured clone strips prototypes and
symbol-keyed properties — a branded error arrives as an unbranded husk
(`payload` gone), a `Stream` as an empty object. Two realms are two
runtimes by construction (issue #129), so no import-map discipline can
help; without a defined form every proxy author invents an ad-hoc
serialization, each subtly wrong. This section defines the sanctioned
crossing and makes the unsanctioned one fail loudly at the sender.

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
clean drop's cousin. `stack` is carried verbatim when present (the
sender's stack is the diagnostically useful one; the rehydration site's
is noise).

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
- Refuse with `InvalidHandleError` (whose documented meaning is handle
  misuse generally): realm-local leaves — anything `isRealmLocal`,
  anything carrying the `STREAM`, `FUTURE`, or `POLLABLE` brand, and
  resource wrappers (a defined `RESOURCE_STATE` property) — unless
  `replace` substitutes. Resources are realm-local by principle (their
  machinery lives in the minting copy's tables; issue #129's identity
  rule): **proxy the interface, not the handle.**
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
prototypes), which is why it cannot ride the brand mechanism. Collateral
is deliberate: `JSON.stringify` omits function values and spread copies
an inert reference, so only clone paths trip. The deterministic,
explanatory error is `toCloneable`'s job; the pill is the engine-enforced
backstop for everyone who skips it. Vocabulary: `REALM_LOCAL` (the key
string), `defineRealmLocal(target)`, `isRealmLocal(v)`, exported by
`@polyengine/protocol`.

**Errors cannot be pilled.** The serializer takes the `[[ErrorData]]`
branch for `Error` instances: `name`/`message`(/`stack`) survive, custom
own properties and getters are never consulted. A raw-cloned branded
error therefore husks **silently** — brand and `payload` gone — and no
userland property can change that. That is precisely the gap
`toCloneable` exists to fill; the pill covers only the stateful handles,
and the two mechanisms partition the vocabulary exactly.

**Error-context is message-valued.** An error-context's state is exactly
its debug message (definitions.py), so lowering accepts, besides this
copy's lifted instances, **any** branded carrier of a string `message` —
a fresh local context is minted, a new local value, never "the same" one.
`fromCloneable`'s error-context output is such a carrier, and so is a
hand-rolled `{ [Symbol.for("polyengine.errorContext/1")]: true, message }`.
A branded error-context **without** a string `message` keeps the loud
cross-copy refusal — that shape is a genuinely foreign stateful handle,
not a message carrier.

## The host-ABI surface and its version

A published host module consumes protocol vocabulary only — error
classes, import marks, handle types. If its import map named
`jsr:@polyengine/runtime`, every lockstep engine release (plan-format
bumps, translator breaks: nothing a host module can observe) would
invalidate its range and force a republish. The contract therefore splits
the surfaces:

**Protocol carries the whole host-boundary vocabulary.** In addition to
the brands, classes, marks, and predicates above, `@polyengine/protocol`
exports, as executable TypeScript:

- the handle interfaces of §"Streams and futures" — `Stream<T>`,
  `StreamWriter<T>`, `Future<T>`, `ErrorContext` — as **structural
  interfaces** (`Chunk<T>`, `DirectSource`, `DirectDestination`, and the
  lowering-source unions `StreamSource<T>`/`FutureSource<T>` ride along);
- brand predicates for the stateful values: `isStream`, `isStreamWriter`,
  `isFuture`, `isErrorContext`. Handle recognition is by brand, as
  everywhere — `instanceof` against a concrete class is not contract
  behavior in any package.

The runtime's concrete classes declare `implements` against the protocol
interfaces: conformance is a compile-time assertion pinned by
`just test-runtime`, plus the conventions suite below.

**The runtime's exported surface is application-only.**
`@polyengine/runtime/embedder` exports machinery only an instantiating
application uses: `instantiate`/`instantiateEmbedder`, artifact
resolution, `requiredImports`, the import resolver and version
canonicalization, `NameCollisionError` (raised while building a facade,
before any value exists), the value-bridge/casing utilities, `sync()`,
and the stream-pair factory
`createStream<T>(): { stream, writer }`. It does not export the error
classes, predicates, brands, marks, realm crossing, the copy registry, or
the concrete handle classes — applications import the boundary vocabulary
from `@polyengine/protocol`, like everyone else. Minting is
application-tier by design: host modules produce streams and futures as
natural JS producers (§"Streams and futures") and never need a writer; a
host module that genuinely wants writer-driven push (`writeDirect`) is
handed one by the application, which keeps placement — like runtime
selection itself — with the deploying application.

**Host modules MUST NOT import `@polyengine/runtime`** (for published
host-module packages): `@polyengine/protocol` at most; zero-import
hand-rolled brands stay legal. The rule is nearly self-enforcing — the
runtime exports nothing a host module needs — and a consumer can gate it
mechanically with a one-line no-`@polyengine/runtime`-specifier check on
the package. The wasi package is protocol-only (`isStream` instead of
`instanceof Stream`), which also keeps module-identity constraints out of
consumer configs. The same rule covers callbacks: a host module whose
shape wants a synchronous guest callback is handed `sync(exports.f)` by
the application, never the runtime import.

**The conventions suite is the executable definition of the host ABI.**
`runtime/tests/conventions/` exercises this contract's lift/lower
conventions against a probe host module written the way consumers write
theirs (protocol imports only) and records what the engine does —
imports-record shape, lowering-source adaptation, lifted-handle behavior,
resource conventions, the error model, suspending, error-contexts — as
normalized transcripts committed under
`runtime/tests/conventions/golden/`. The gate rule:

- **Modifying or deleting a committed golden asserts a host-ABI behavior
  change** and requires `breaking/protocol` (with the protocol minor bump
  the label already implies) in the same PR. The reviewed escape for a
  behavior-neutral correction — the suite itself was wrong — is the
  `conventions-fix` label, same trust model as the breaking labels.
- **Adding goldens is free**: new coverage of existing behavior is not a
  version event.
- version-guard enforces both at PR time (labels, advisory) and
  authoritatively at cut time: any M/D under
  `runtime/tests/conventions/golden/` in the release window
  (`git diff --name-status v<lastCut>..HEAD -- <goldens>`) requires the
  protocol version to have moved past the last cut.

**Consequence: protocol's version is the host-ABI version.** A host
module pins `jsr:@polyengine/protocol@^0.x` and is untouched by lockstep
engine releases; an engine change that leaves the goldens byte-identical
is host-ABI-neutral *by definition*, and one that doesn't cannot ship
without announcing itself on protocol's line.

## Bindgen obligations (summary of what the above requires)

Per world: `Imports`/`Exports` types; resource classes (both directions);
`ComponentException` payload types per fallible function; value types per
the mapping table; the mangled-name assembly (`[method]r.f` ↔ `class`
methods) in both directions; stream/future adapters incl. pumping; the
digest handshake. The generated layer is an adapter over the runtime's
raw (definitions.py-shaped) boundary — see below.

## Implementation strategy

The ergonomic layer is generated code **on top of** the raw boundary; the
interpreter's internal shapes are pinned by the reference-test ports and
the conformance harness's value mapping. Issue #261 converged one of them
for measured reasons: the interpreter's variant family now carries its
case in a `kind` property with a `value` alongside, the same property
names this layer uses.

**The convergence is partial, and the residue is a trap.** An internal
value and a host value can now be structurally identical and still mean
different things, so four differences that a mismatched shape used to make
obvious are no longer visible at a glance, and every site handling them
must translate deliberately:

- **`result`** — internal despecialization names the error case `"error"`
  (definitions.py); this layer's kind is `"err"`.
- **`enum`** — internal is a variant value; here an enum is a bare string,
  kebab-case verbatim.
- **`option`** — internal is always `{kind: "none" | "some", value}`; here
  the outermost option in a chain is `T | undefined`, and only an option
  nested directly inside another option boxes.
- **payload-free cases** — internal keeps `value: null`; this layer omits
  the property.

Fully converging the interpreter remains a perf-track concern (the
descriptor-driven codegen executor can emit convention shapes directly,
skipping the adapter). Consequence: `instance.exports` stays
internal-shaped and documented as such; embedders use the bindgen layer
(or accept the internal surface with no stability promise).

## The WASI parking kernel

WASI implementations stay out of the runtime core (docs/architecture.md
§2), but the conventions must make WASI interfaces natural, and the
`wasi/` package is the executable check. Most of wasi maps directly
(p3 clocks is four lines over `setTimeout` with zero JSPI; p3 sockets and
http are resource classes with async methods and stream-shaped I/O). The
one idiom that fights a JS host is p2's sync-blocking surface —
`pollable.block()`, `poll()`, `blocking-read`/`blocking-write-and-flush`
are **sync** WIT functions that must park. The wasi package ships the
PARKING KERNEL, always on: `block`/`poll` are `suspending()`-marked with
sync fast paths, so a ready pollable costs one engine hop and only a
genuine wait parks the frame. Timer pollables are real (monotonic-clock
subscribe-*). On engines without JSPI, `chooseMode` degrades to plain and
a genuine park raises a clean `NeedsJspi` at the park site instead of
livelocking; `jspi: false` is the per-instantiation opt-out. Stream
`read`/`check-write` stay plain (sync, never park); the p2 `blocking-*`
stream declarations are marked park-capable — the buffer-backed default
streams always take the sync fast path (never park), while
genuinely-async stream impls (the host-stdio cli: a real stdin behind
p2's sync `blocking-read`) return Promises and park through the kernel.
The prototype-declares/instances-behave mark relay is what lets
duck-typed stream impls park through the registered resource types.

`Pollable` is publicly constructible — `new Pollable(ready, wait)` — as
the interop seam for external providers (e.g. consumer-side sockets glue)
whose pollables the kernel `poll()`s uniformly; `wait()` follows the
promise-swap producer shape (settle + re-arm per event; spurious wakes
fine).

Consequence for the zero-cost pin: a component importing marked providers
auto-detects into jspi mode on JSPI engines even if it never parks —
"zero-cost plain path" reads "sync-only plan AND no marked imports" (see
contracts/intrinsics.md).
