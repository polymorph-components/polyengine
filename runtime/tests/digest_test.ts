// Cross-language digest equality — the design validation for the canonical
// world digest (the legacy shim `worldDigest`, contracts/plan-format.md
// schema; the normative digest is contracts/digest.md; full spec in
// crates/bindgen/src/digest.rs's module doc comment, mirrored in
// runtime/src/digest/digest.ts's).
//
// Fixtures: runtime/tests/bindgen/fixtures/*.envelope.json are the shim's
// C-ABI JSON envelope (`{plan, adapters}` — runtime/src/shim/mod.ts /
// crates/translator-shim's README) for each of the three sync guest
// fixtures, checked in as static data. Regenerated (2026-08-08, REVISION
// ROUND) against a current, building `crates/translator-shim` (Track A's
// `importedResources` field (contracts/plan-format.md schema) — is now
// present in every envelope, as an empty array for all
// three fixtures; verified digest-neutral: `computeWorldDigest` on the
// regenerated envelopes matches the same `EXPECTED` values below, byte-for-
// byte identical canonical JSON, since none of these fixtures have
// component-level imports). Regenerate from a clean `crates/translator-shim`
// checkout:
//
//   cargo build -p translator-shim --example dump-plan
//   for w in hello values resources; do
//     cargo run -q -p translator-shim --example dump-plan -- \
//       examples/guests/build/$w.component.wasm --full \
//       > runtime/tests/bindgen/fixtures/$w.envelope.json
//   done
//
// (requires examples/guests/build/*.wasm — ./examples/build.sh)
//
// Expected digests below are cross-checked against `crates/bindgen`'s WIT
// side:
//   cargo run -p bindgen -- digest examples/guests/<w>/wit --world <w>

import { assertEq } from "./support/asserts.ts";
import { loadEnvelope } from "../src/plan/mod.ts";
import { computeWorldDigest, DigestError } from "../src/digest/digest.ts";
import type { WireExport, WirePlan } from "../src/plan/format.ts";

/**
 * Minimal synthetic `WirePlan` builder for exercising `DigestError` guard
 * paths without needing a real translated component. Only the fields
 * `computeWorldDigest` actually reads are populated meaningfully; the rest
 * are empty/zeroed placeholders satisfying `WirePlan`'s shape.
 */
function syntheticPlan(overrides: Partial<WirePlan>): WirePlan {
  return {
    formatVersion: 3,
    producer: { shimVersion: "test", wasmtimeEnviron: "test", features: [] },
    component: { sha256: "0".repeat(64), len: 0 },
    modules: [],
    initializers: [],
    trampolines: [],
    canonicalOptions: [],
    types: [],
    resourceTables: [],
    streamTables: [],
    futureTables: [],
    errorContextTables: [],
    imports: [],
    exports: [],
    worldDigest: "",
    ...overrides,
  };
}

async function expectDigestError(
  plan: WirePlan,
  messageIncludes: string,
): Promise<void> {
  try {
    await computeWorldDigest(plan);
    throw new Error("expected computeWorldDigest to throw a DigestError");
  } catch (e) {
    if (!(e instanceof DigestError)) {
      throw new Error(`expected a DigestError, got: ${e}`);
    }
    if (!e.message.includes(messageIncludes)) {
      throw new Error(
        `expected DigestError message to include ${JSON.stringify(messageIncludes)}, got: ${e.message}`,
      );
    }
  }
}

const root = new URL("../../", import.meta.url);

async function readEnvelope(name: string) {
  const text = await Deno.readTextFile(
    new URL(`runtime/tests/bindgen/fixtures/${name}.envelope.json`, root),
  );
  return loadEnvelope(text);
}

// Computed independently by `cargo run -p bindgen -- digest <wit> --world <w>`
// (crates/bindgen/tests/digest_fixtures.rs asserts these same values on the
// Rust side — the two implementations were developed against the same
// fixture corpus and must never be "fixed" independently of one another).
const EXPECTED = {
  hello: "sha256:04ae5eb2633ff22f5af8c5e9234c18d089e80a99e04b0946929f0a2e3f5ad7c9",
  values: "sha256:e0791536cb4b9731057b82831150611eed64f22d665130a02f247d3227e2e4a7",
  resources: "sha256:d72d1754bca4332fb3a5e21526872d28c0914f54253979e3bc8ab8e1e083b4d4",
};

for (const world of ["hello", "values", "resources"] as const) {
  Deno.test(`digest: ${world} plan digest matches WIT-computed digest (cross-language equality)`, async () => {
    const { wire } = await readEnvelope(world);
    const { digest } = await computeWorldDigest(wire);
    assertEq(digest, EXPECTED[world]);
  });
}

Deno.test("digest: recomputing from the same plan is deterministic", async () => {
  const { wire } = await readEnvelope("values");
  const a = await computeWorldDigest(wire);
  const b = await computeWorldDigest(wire);
  assertEq(a.digest, b.digest);
  assertEq(a.canonicalJson, b.canonicalJson);
});

Deno.test("digest: verifyWorldDigest returns null on an exact match", async () => {
  const { wire } = await readEnvelope("hello");
  const { verifyWorldDigest } = await import("../src/digest/verify.ts");
  const result = await verifyWorldDigest(wire, EXPECTED.hello);
  assertEq(result, null);
});

Deno.test("digest: verifyWorldDigest flags a mismatch (wrong expected digest)", async () => {
  const { wire } = await readEnvelope("hello");
  const { verifyWorldDigest } = await import("../src/digest/verify.ts");
  const result = await verifyWorldDigest(wire, EXPECTED.values);
  if (result === null) throw new Error("expected a mismatch");
  assertEq(result.expected, EXPECTED.values);
  assertEq(result.actual, EXPECTED.hello);
});

// ---------------------------------------------------------------------------
// DigestError guard paths (REVISION ROUND: review found these unexercised).
// ---------------------------------------------------------------------------

Deno.test("digest: imported-resources guard fires (own/borrow cannot be safely aliased)", async () => {
  // CONTRACT: format.ts:23-33's `importedResources` (v0.2 proposal). No
  // alias map exists from an imported resource's `ResourceIndex` to a
  // qualified name yet, so any plan declaring imported resources must be
  // refused outright rather than risk silently aliasing an own/borrow site
  // to the wrong (exported) resource — see digest.ts's buildResourceNameMap.
  const plan = syntheticPlan({
    importedResources: [{ import: 0 }],
    imports: [{ name: "res", path: [], kind: "resource" }],
  });
  await expectDigestError(plan, "imported resource");
});

Deno.test("digest: multi-named-resource aliasing guard fires (2+ named resources, unresolved table indices)", async () => {
  // Two distinct named (exported) resources but MORE resourceTables entries
  // than named resources: table-index aliasing across instance boundaries
  // (module docs' "Known limitation") cannot be resolved for the extra
  // index, and with 2+ named resources the single-resource shortcut does
  // not apply either. Must throw rather than guess which name it means.
  const exports: WireExport[] = [
    { kind: "type", name: "res-a", type: { kind: "resource", resource: 0 } },
    { kind: "type", name: "res-b", type: { kind: "resource", resource: 1 } },
  ];
  const plan = syntheticPlan({
    resourceTables: [
      { kind: "concrete", resource: 0, instance: 0 },
      { kind: "concrete", resource: 0, instance: 1 },
      { kind: "concrete", resource: 0, instance: 2 }, // unresolved 3rd index
    ],
    exports,
  });
  await expectDigestError(plan, "resourceTables alias resolution");
});

Deno.test("digest: own/borrow guard fires with zero named resources", async () => {
  // No type export names ANY resource, yet a function signature references
  // resourceTables[0] via `own<T>` — there is nothing to alias it to
  // (the <=1-named-resource shortcut maps nothing when named.size === 0),
  // so resolving the own/borrow site must fail loudly instead of silently
  // treating it as some default name.
  const plan = syntheticPlan({
    resourceTables: [{ kind: "concrete", resource: 0, instance: 0 }],
    types: [
      {
        kind: "func",
        params: [],
        results: [{ kind: "own", resource: 0 }],
        async: false,
      },
    ],
    exports: [
      {
        kind: "lifted-func",
        name: "make",
        coreDef: { kind: "trampoline", index: 0 },
        options: 0,
        type: 0,
      },
    ],
  });
  await expectDigestError(plan, "no resolvable qualified name");
});

Deno.test("digest: CEWD_VERSION bump changes the digest", async () => {
  // A future incompatible renormalization bumps `CEWD_VERSION`
  // (digest.ts:47); confirm that alone is sufficient to change the digest,
  // so an old bindgen-embedded digest never spuriously "matches" a plan
  // computed under a new normalization.
  const { wire } = await readEnvelope("hello");
  const { computeWorldDigest: recompute, CEWD_VERSION } = await import(
    "../src/digest/digest.ts"
  );
  const a = await recompute(wire);
  const parsed = JSON.parse(a.canonicalJson);
  assertEq(parsed.cewd, CEWD_VERSION);
  const bumped = { ...parsed, cewd: CEWD_VERSION + 1 };
  const { canonicalStringify } = await import("../src/digest/digest.ts");
  const bumpedJson = canonicalStringify(bumped);
  if (bumpedJson === a.canonicalJson) {
    throw new Error("expected canonical JSON to differ after a cewd bump");
  }
  const bumpedDigestBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(bumpedJson),
  );
  const bumpedDigest = "sha256:" +
    Array.from(new Uint8Array(bumpedDigestBytes)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
  if (bumpedDigest === a.digest) {
    throw new Error("expected sha256 to differ after a cewd bump");
  }
});
