# Contract: Canonical World Digest (`cewd:1`)

Bindings embed a digest of their expected WIT world. Their typed `instantiate`
wrapper recomputes it from the plan and rejects mismatches before running guest
code. Untyped runtime instantiation does not check an expected world. A digest
match must imply ABI-shape compatibility for positional calling. It does not
authenticate a component or prove its behavior.

Normalization version: **`cewd:1`**. The version tag is folded into the hashed
document, so any future incompatible renormalization cannot collide.

## Reference implementations (normative, kept in lockstep)

- Rust, from `wit_parser::Resolve` + world: `crates/bindgen/src/digest.rs`
- TypeScript, from a loaded plan's types/imports/exports:
  `runtime/src/digest/digest.ts`

Cross-language equality is pinned by fixture tests
(`runtime/tests/digest_test.ts`): for each fixture world,
`digest(WIT) == digest(plan-from-component)`. Any rule change lands in both
implementations plus fixtures in the same commit.

## Normalization rules (summary)

- **Order-independent**: import/export lists and nested interface-instance item
  lists are sorted by name — the only order normalized away.
- **Order-preserved (ABI-relevant)**: record fields, tuple elements,
  variant/enum case order (discriminants), flags label order (bit positions),
  function parameter order, fixed-list lengths.
- **Resource identity** by qualified name, not table index.
- **Excluded**: function parameter _labels_ (calling is positional; renames are
  not ABI changes — two worlds differing only in param names digest equal, by
  design), docs/stability gates/spans, plan `features`, `importedResources`,
  table ordering, `producer` metadata.
- **Included**: package `@version` in qualified interface names.
- Only functions and resources contribute as export/import _items_; named
  non-resource types are structural and appear where referenced.
- Hash: sha256 over a canonical JSON document prefixed `{"cewd":1,…}`; name
  sorting is byte-wise/UTF-16-code-unit (equivalent for ASCII WIT identifiers —
  comment pinned on both sides).

## Guards (fail loudly, never guess)

The current plan-side implementation throws `DigestError` for imported
resources, unresolved own/borrow references, and ambiguous multi-resource table
attribution. It maps all table references to the sole name in a single-resource
world. Multi-resource worlds use direct table-to-name matches and reject
unresolved aliases. These are limits of the digest implementation, not of
resource execution; the executor separately resolves concrete resource-table
aliases.

## Known divergence (loud, not silent)

Interface imports are nested on the Rust side and flattened on the TS side. Such
worlds can fail the digest handshake despite being executable by the untyped
runtime. Correcting this requires coordinated Rust/TS normalization and
cross-language fixtures, not bypassing the mismatch check.
