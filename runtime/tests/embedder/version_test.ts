// Version-canonical import resolution (contracts/embedder-api.md
// §"Version canonicalization").
//
// Authorities under test: the spec's `canonversion` track split and
// wasmtime's `alternate_lookup_key` + max-wins linker claim.

import { assertEq } from "../support/asserts.ts";
import {
  asTrackKeySpelling,
  ImportRegistrationError,
  ImportResolutionError,
  ImportResolver,
  trackKey,
} from "../../src/embedder/version.ts";
import { camelCase, parseLeafName, pascalCase } from "../../src/embedder/casing.ts";
import { NameCollisionError } from "../../src/embedder/errors.ts";
import { checkNoCollisions } from "../../src/embedder/values.ts";

const P = "wasi:clocks/monotonic-clock";

Deno.test("track key: major > 0 tracks the major", () => {
  assertEq(trackKey(`${P}@1.2.3`), `${P}@1`);
  assertEq(trackKey(`${P}@1.0.0`), `${P}@1`);
  assertEq(trackKey(`${P}@2.1.2+abc`), `${P}@2`, "build metadata is ignored");
});

Deno.test("track key: major 0 tracks the minor", () => {
  assertEq(trackKey(`${P}@0.2.6`), `${P}@0.2`);
  assertEq(trackKey(`${P}@0.2.12`), `${P}@0.2`);
  assertEq(trackKey(`${P}@0.3.0`), `${P}@0.3`);
});

Deno.test("track key: 0.0.z and prereleases belong to no track", () => {
  assertEq(trackKey(`${P}@0.0.1`), null, "patch-only: compatible with nothing");
  assertEq(trackKey(`${P}@0.2.0-rc-2023-10-18`), null, "prerelease is exact-only");
  assertEq(trackKey(P), null, "unversioned ids have no track");
});

Deno.test("a track key spelling is not a semver version", () => {
  // `semver::Version::parse("0.2")` fails, which is exactly why track keys and
  // full versions can never be confused for one another.
  assertEq(asTrackKeySpelling(`${P}@0.2`), `${P}@0.2`);
  assertEq(asTrackKeySpelling(`${P}@1`), `${P}@1`);
  assertEq(asTrackKeySpelling(`${P}@0.2.6`), null);
  assertEq(asTrackKeySpelling(P), null);
});

Deno.test("D-2: one @0.2 track provider serves 0.2.6 / 0.2.9 / 0.2.12", () => {
  // The p2 corpus names the same interface at three patch
  // versions. Under wasmtime's linker one provider serves all three; the
  // v0.1 draft's "version-exact keys" rule would have forced triplication.
  const clocks = { now: () => 0n };
  const r = new ImportResolver({ [`${P}@0.2`]: clocks });
  for (const v of ["0.2.6", "0.2.9", "0.2.12"]) {
    const hit = r.resolve(`${P}@${v}`);
    assertEq(hit?.value === clocks, true, `@${v} -> track provider`);
    assertEq(hit?.key, `${P}@0.2`);
  }
  assertEq(r.resolve(`${P}@0.3.0`), undefined, "a different track is unserved");
});

Deno.test("exact registration wins over the track alternate", () => {
  const exact = { tag: "exact" };
  const track = { tag: "track" };
  const r = new ImportResolver({ [`${P}@0.2.9`]: exact, [`${P}@0.3`]: track });
  assertEq(r.resolve(`${P}@0.2.9`)?.value === exact, true);
  assertEq(r.resolve(`${P}@0.3.7`)?.value === track, true);
});

Deno.test("max-wins: the highest full version claims the track", () => {
  const lo = { v: "0.2.6" }, mid = { v: "0.2.9" }, hi = { v: "0.2.12" };
  const r = new ImportResolver({
    [`${P}@0.2.6`]: lo,
    [`${P}@0.2.12`]: hi,
    [`${P}@0.2.9`]: mid,
  });
  // Registration order must not matter: 0.2.12 > 0.2.9 > 0.2.6 numerically,
  // not lexically (a string compare would pick "0.2.9").
  assertEq(r.resolve(`${P}@0.2.4`)?.value === hi, true);
  assertEq(r.resolve(`${P}@0.2.6`)?.value === lo, true, "exact beats the track");
  void mid;
});

Deno.test("prereleases are exact-only, in both directions", () => {
  const rc = { tag: "rc" }, rel = { tag: "release" };
  const r = new ImportResolver({
    [`${P}@0.2.0-rc-2023-10-18`]: rc,
    [`${P}@0.2.3`]: rel,
  });
  assertEq(r.resolve(`${P}@0.2.0-rc-2023-10-18`)?.value === rc, true);
  void rel;
  // A prerelease import has no track, so the 0.2 release provider is NOT
  // reachable from it — the historic WASI rc snapshots named different
  // function sets at the same nominal track.
  assertEq(r.resolve(`${P}@0.2.0-rc-2023-10-19`), undefined);
  // And the prerelease registration claims no track of its own.
  const only = new ImportResolver({ [`${P}@0.2.0-rc-1`]: rc });
  assertEq(only.resolve(`${P}@0.2.5`), undefined);
});

Deno.test("0.0.z is exact-only", () => {
  const a = { z: 1 };
  const r = new ImportResolver({ [`${P}@0.0.1`]: a });
  assertEq(r.resolve(`${P}@0.0.1`)?.value === a, true);
  assertEq(r.resolve(`${P}@0.0.2`), undefined);
});

Deno.test("mixed same-track registration is refused loudly at registration", () => {
  let err: unknown;
  try {
    new ImportResolver({ [`${P}@0.2`]: {}, [`${P}@0.2.9`]: {} });
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof ImportRegistrationError, true, `got ${err}`);
  assertEq(String(err).includes("ambiguous"), true, `${err}`);
  assertEq(String(err).includes(`${P}@0.2`), true, `${err}`);
  // …and in the other registration order.
  let err2: unknown;
  try {
    new ImportResolver({ [`${P}@0.2.9`]: {}, [`${P}@0.2`]: {} });
  } catch (e) {
    err2 = e;
  }
  assertEq(err2 instanceof ImportRegistrationError, true, `got ${err2}`);
});

Deno.test("two track keys on one track are refused", () => {
  let err: unknown;
  try {
    // Same track spelled twice is only reachable via distinct strings, e.g.
    // a duplicate object key is impossible, so build the record dynamically.
    const rec: Record<string, unknown> = {};
    rec[`${P}@1`] = {};
    rec[`${P}@1.0.0`] = {};
    new ImportResolver(rec);
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof ImportRegistrationError, true, `got ${err}`);
});

Deno.test("unversioned folding is refused, both directions", () => {
  // The banned defect: version-agnostic keys merging distinct
  // semver tracks. An unversioned key is a legal EXACT match (unversioned WIT
  // interfaces exist) but may never serve a versioned import.
  const r = new ImportResolver({ [P]: {} });
  assertEq(r.resolve(P)?.key, P, "exact unversioned match still works");
  let err: unknown;
  try {
    r.resolve(`${P}@0.2.6`);
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof ImportResolutionError, true, `got ${err}`);
  assertEq(String(err).includes("folding"), true, `${err}`);

  const r2 = new ImportResolver({ [`${P}@0.2.6`]: {} });
  let err2: unknown;
  try {
    r2.resolve(P);
  } catch (e) {
    err2 = e;
  }
  assertEq(err2 instanceof ImportResolutionError, true, `got ${err2}`);
});

// ---------------------------------------------------------------------------
// Casing and mangled-name decoding
// ---------------------------------------------------------------------------

Deno.test("casing: later fragments capitalize, remainders are preserved", () => {
  assertEq(camelCase("get-resolution"), "getResolution");
  assertEq(camelCase("now"), "now");
  // Acronym fragments stay caps — a `toLowerCase()` of the tail would not.
  assertEq(camelCase("outgoing-HTTP-request"), "outgoingHTTPRequest");
  assertEq(pascalCase("tcp-socket"), "TcpSocket");
  assertEq(pascalCase("counter"), "Counter");
  assertEq(pascalCase("R"), "R");
});

Deno.test("mangled leaf names decode to resource membership", () => {
  assertEq(parseLeafName("make-counter"), { form: "plain", name: "make-counter" });
  assertEq(parseLeafName("[constructor]counter"), {
    form: "constructor",
    resource: "counter",
  });
  assertEq(parseLeafName("[method]counter.increment"), {
    form: "method",
    resource: "counter",
    member: "increment",
  });
  assertEq(parseLeafName("[static]counter.merge"), {
    form: "static",
    resource: "counter",
    member: "merge",
  });
});

Deno.test("'@0' is not a compatibility track and is refused", () => {
  // Major 0 tracks the MINOR (`@0.2`), so no version canonicalizes to `@0`:
  // registering it could only ever be a dead entry.
  assertEq(asTrackKeySpelling(`${P}@0`), null);
  let err: unknown;
  try {
    new ImportResolver({ [`${P}@0`]: {} });
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof ImportRegistrationError, true, `got ${err}`);
  assertEq(String(err).includes("not a compatibility track"), true, `${err}`);
});

Deno.test("camelCase collisions in one label set are refused", () => {
  // `read-only` and `readOnly` are distinct WIT labels but ONE JS property, so
  // one would silently shadow the other at the boundary. Contract principle 2.
  const rec = { kind: "record" as const, fields: [] };
  let err: unknown;
  try {
    checkNoCollisions(rec, ["read-only", "readOnly"], "synthetic: record");
  } catch (e) {
    err = e;
  }
  assertEq(err instanceof NameCollisionError, true, `got ${err}`);
  assertEq(String(err).includes("'readOnly'"), true, `${err}`);
  assertEq(String(err).includes("synthetic: record"), true, `${err}`);

  // Distinct labels that camel apart are fine, and the check is memoized per
  // type object (a second call on a validated set is a no-op).
  const ok = { kind: "flags" as const, labels: [] };
  checkNoCollisions(ok, ["read", "write", "read-write"], "synthetic: flags");
  checkNoCollisions(ok, ["read", "write", "read-write"], "synthetic: flags");
});
