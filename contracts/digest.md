# Contract: Canonical World Digest (`cewd:1`)

The digest is the skew-protection handshake of docs/architecture.md §9: bindings generated
from WIT embed an expected digest; the generated typed `instantiate` recomputes
it from the loaded plan and fails fast with a structural diff on mismatch,
before any guest code runs (contracts/embedder-api.md §"Module wiring and
instantiation" — the runtime's untyped `instantiate` names no world, so it
does not verify). A digest match must imply ABI-shape compatibility for
positional calling.

Normalization version: **`cewd:1`**. The version tag is folded into the
hashed document, so any future incompatible renormalization cannot collide.

## Reference implementations (normative, kept in lockstep)

- Rust, from `wit_parser::Resolve` + world: `crates/bindgen/src/digest.rs`
  (module docs carry the full rule-by-rule spec)
- TypeScript, from a loaded plan's types/imports/exports:
  `runtime/src/digest/digest.ts`

Cross-language equality is pinned by fixture tests
(`runtime/tests/digest_test.ts`): for each fixture world,
`digest(WIT) == digest(plan-from-component)`. Any rule change lands in both
implementations plus fixtures in the same commit.

## Normalization rules (summary)

- **Order-independent**: import/export lists and nested interface-instance
  item lists are sorted by name — the only order normalized away.
- **Order-preserved (ABI-relevant)**: record fields, tuple elements,
  variant/enum case order (discriminants), flags label order (bit
  positions), function parameter order, fixed-list lengths.
- **Resource identity** by qualified name, not table index.
- **Excluded**: function parameter *labels* (calling is positional; renames
  are not ABI changes — two worlds differing only in param names digest
  equal, by design), docs/stability gates/spans, plan `features`,
  `importedResources`, table ordering, `producer` metadata.
- **Included**: package `@version` in qualified interface names.
- Only functions and resources contribute as export/import *items*; named
  non-resource types are structural and appear where referenced.
- Hash: sha256 over a canonical JSON document prefixed `{"cewd":1,…}`;
  name sorting is byte-wise/UTF-16-code-unit (equivalent for ASCII WIT
  identifiers — comment pinned on both sides).

## Guards (fail loudly, never guess)

`DigestError` is thrown — rather than risking a wrong-but-matching digest —
when the plan carries **imported resources**, or **≥2 named resources**
whose own/borrow table indices cannot be soundly attributed, or own/borrow
references with **zero** named resources. All three paths are test-pinned.
Lifting these requires a plan-format extension carrying an explicit
resource-alias map (open item, tracked in plan-format.md).

## Known divergence (loud, not silent)

Interface *imports* are digested nested on the Rust side and flattened on
the TS side — guaranteed handshake mismatch (safe failure direction) for
worlds with interface imports; no current fixture has any. Resolve both
sides together when the imports corpus lands.
