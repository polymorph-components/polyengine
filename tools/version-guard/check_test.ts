// Unit tests for the release version guard. No network, no `gh`, no
// repository state: every check runs against a fake Effects, so the tests
// exercise the real decision logic (the fixtures below are shaped from real
// jsr.io and GitHub API responses).

// Assertions are local, matching the rest of tools/ (bundle_test.ts): no
// test-only dependency enters the workspace lockfile for a guard whose
// whole point is that it cannot be knocked over by a registry.
import type { Effects, HttpResponse } from "./effects.ts";
import { sha256Hex } from "./effects.ts";
import {
  compareSemver,
  cutChecks,
  cutGuards,
  isMinorBumped,
  main,
  parseSemver,
  prChecks,
  protocolPrChecks,
  publishChecks,
  renderNotes,
} from "./check.ts";

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}

function assertEquals<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ?? "mismatch"}: got ${g}, want ${w}`);
}

function assertStringIncludes(got: string, needle: string): void {
  if (!got.includes(needle)) {
    throw new Error(`expected to contain ${JSON.stringify(needle)}, got ${JSON.stringify(got)}`);
  }
}

// ----- fake effects -----------------------------------------------------------

type FakeSpec = {
  http?: Record<string, HttpResponse>;
  gh?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
  git?: Record<string, { code?: number; stdout?: string; stderr?: string }>;
  files?: Record<string, string>;
  env?: Record<string, string>;
};

type Fake = Effects & { logs: string[]; written: Record<string, string> };

function fake(spec: FakeSpec): Fake {
  const logs: string[] = [];
  const written: Record<string, string> = {};
  const files = spec.files ?? {};
  const enc = new TextEncoder();
  return {
    logs,
    written,
    fetchText(url) {
      const res = spec.http?.[url];
      return Promise.resolve(res ?? { status: 404, body: "not found" });
    },
    run(cmd, args) {
      const key = args.join(" ");
      const table = cmd === "gh" ? spec.gh : spec.git;
      const hit = table?.[key];
      if (!hit) {
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: `unstubbed: ${cmd} ${key}`,
        });
      }
      return Promise.resolve({
        code: hit.code ?? 0,
        stdout: hit.stdout ?? "",
        stderr: hit.stderr ?? "",
      });
    },
    readFile(path) {
      const body = files[path];
      return Promise.resolve(body === undefined ? null : enc.encode(body));
    },
    listFiles(dir) {
      const prefix = `${dir}/`;
      return Promise.resolve(
        Object.keys(files)
          .filter((f) => f.startsWith(prefix))
          .map((f) => f.slice(prefix.length))
          .sort(),
      );
    },
    writeFile(path, text) {
      written[path] = text;
      return Promise.resolve();
    },
    env: (name) => spec.env?.[name],
    log: (m) => void logs.push(m),
  };
}

const manifest = (pkg: string, version: string) =>
  JSON.stringify({ name: `@polyengine/${pkg}`, version });

const lockstepFiles = (v: string) =>
  Object.fromEntries(
    ["runtime", "translator", "wasi", "ct-runner"].map((
      p,
    ) => [`${p}/deno.json`, manifest(p, v)]),
  );

const ghJson = (value: unknown) => ({ stdout: JSON.stringify(value) });
const gh404 = { code: 1, stderr: "gh: Not Found (HTTP 404)" };

const failed = (checks: { ok: boolean; name: string }[]) =>
  checks.filter((c) => !c.ok).map((c) => c.name);
const detail = (checks: { name: string; detail: string }[], name: string) =>
  checks.find((c) => c.name === name)!.detail;

// ----- semver -----------------------------------------------------------------

Deno.test("semver: parse rejects non-versions", () => {
  for (const bad of ["", "1.2", "v1.2.3", "1.2.3.4", "1.2.x", "1.2.3-"]) {
    let threw = false;
    try {
      parseSemver(bad);
    } catch {
      threw = true;
    }
    assert(threw, `expected ${JSON.stringify(bad)} to be rejected`);
  }
  assertEquals(parseSemver("0.4.0"), {
    major: 0,
    minor: 4,
    patch: 0,
    pre: [],
  });
  assertEquals(parseSemver("0.4.0-pre.g1a2b3c4+meta").pre, ["pre", "g1a2b3c4"]);
});

Deno.test("semver: compare covers the ordering edges", () => {
  const lt = (a: string, b: string) => {
    assertEquals(compareSemver(a, b), -1, `${a} < ${b}`);
    assertEquals(compareSemver(b, a), 1, `${b} > ${a}`);
  };
  lt("0.3.9", "0.4.0");
  lt("0.4.0", "0.4.1");
  lt("0.9.0", "1.0.0");
  // A prerelease sorts BEFORE its release — the property the whole
  // `<next>-pre.g<hash>` scheme rests on.
  lt("0.4.0-pre.g1a2b3c4", "0.4.0");
  // Numeric identifiers compare numerically, not as strings.
  lt("0.4.0-pre.2", "0.4.0-pre.10");
  // Numeric sorts before alphanumeric; more identifiers win ties.
  lt("0.4.0-pre.2", "0.4.0-pre.g2");
  lt("0.4.0-pre", "0.4.0-pre.1");
  assertEquals(compareSemver("0.4.0", "0.4.0+build"), 0);
});

Deno.test("semver: isMinorBumped is a minor-LINE question", () => {
  assert(isMinorBumped("0.5.0", "0.4.3"));
  assert(!isMinorBumped("0.4.3", "0.4.0"));
  assert(!isMinorBumped("0.4.0", "0.4.0"));
  assert(isMinorBumped("1.0.0", "0.9.9"));
  assert(!isMinorBumped("0.9.9", "1.0.0"));
});

// ----- pr mode ----------------------------------------------------------------

const JSR_META = "https://jsr.io/@polyengine/protocol/meta.json";

// Shaped from the real https://jsr.io/@polyengine/protocol/meta.json.
const jsrMeta = (latest: string): HttpResponse => ({
  status: 200,
  body: JSON.stringify({
    scope: "polyengine",
    name: "protocol",
    latest,
    versions: { "0.1.0": {}, "0.2.0": {}, [latest]: {} },
  }),
});

function prFake(over: {
  lockstep?: string;
  perPackage?: Record<string, string>;
  protocol?: string;
  labels?: string[];
  latestTag?: string | null;
  baseRuntime?: string | null;
  changed?: string[];
  published?: string;
}) {
  const lockstep = over.lockstep ?? "0.4.0";
  const files: Record<string, string> = {
    ...lockstepFiles(lockstep),
    "protocol/deno.json": manifest("protocol", over.protocol ?? "0.2.1"),
  };
  for (const [p, v] of Object.entries(over.perPackage ?? {})) {
    files[`${p}/deno.json`] = manifest(p, v);
  }
  const latestTag = over.latestTag === undefined ? "v0.3.1" : over.latestTag;
  return fake({
    files,
    env: {
      PR_NUMBER: "223",
      PR_BASE_SHA: "base0000",
      GITHUB_REPOSITORY: "polymorph-components/polyengine",
    },
    http: { [JSR_META]: jsrMeta(over.published ?? "0.2.1") },
    gh: {
      "api repos/polymorph-components/polyengine/releases/latest":
        latestTag === null ? gh404 : ghJson({ tag_name: latestTag }),
      "api repos/polymorph-components/polyengine/issues/223/labels": ghJson(
        (over.labels ?? []).map((name) => ({ name })),
      ),
    },
    git: {
      "fetch origin base0000 --depth=1": {},
      "diff --name-only base0000...HEAD": {
        stdout: (over.changed ?? ["runtime/src/x.ts"]).join("\n"),
      },
      "show base0000:runtime/deno.json": over.baseRuntime === null
        ? { code: 1, stderr: "fatal: path does not exist" }
        : { stdout: manifest("runtime", over.baseRuntime ?? "0.4.0") },
    },
  });
}

const PR_ENV = {
  prNumber: "223",
  baseSha: "base0000",
  repo: "polymorph-components/polyengine",
};

Deno.test("pr: a clean PR passes every check", async () => {
  const checks = await prChecks(prFake({}), PR_ENV);
  assertEquals(failed(checks), []);
});

Deno.test("pr: a half-bumped workspace fails lockstep", async () => {
  const checks = await prChecks(
    prFake({ perPackage: { wasi: "0.3.1" } }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["lockstep"]);
  assertStringIncludes(detail(checks, "lockstep"), "wasi=0.3.1");
});

Deno.test("pr: manifests not ahead of the last cut fail monotonicity", async () => {
  const checks = await prChecks(
    prFake({ lockstep: "0.3.1", baseRuntime: "0.3.1" }),
    PR_ENV,
  );
  assert(failed(checks).includes("monotonic"));
  assertStringIncludes(detail(checks, "monotonic"), "NEXT release");
});

Deno.test("pr: before the first cut, ONLY monotonicity and the label bump are skipped", async () => {
  const checks = await prChecks(prFake({ latestTag: null }), PR_ENV);
  assertEquals(failed(checks), []);
  assertStringIncludes(detail(checks, "last-cut"), "no cut release yet");
  // 3 and 4 have no referent without a cut...
  assertEquals(checks.find((c) => c.name === "monotonic"), undefined);
  assertEquals(checks.find((c) => c.name === "breaking-label-bumped"), undefined);
  // ...but 5-7 do not depend on one and must still be alive.
  assert(checks.some((c) => c.name === "minor-bump-labelled"));
  assert(checks.some((c) => c.name === "protocol-tear"));
});

Deno.test("pr: the tear warning is NOT dead before the first cut", async () => {
  // The regression this pins: 5-7 were once nested inside the "a cut
  // exists" branch, so a repo that had never cut a release skipped the one
  // check that must never be silent.
  const checks = await prChecks(
    prFake({
      latestTag: null,
      protocol: "0.2.0",
      published: "0.2.0",
      changed: ["protocol/src/cloneable.ts"],
    }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["protocol-tear"]);
});

Deno.test("pr: an unlabelled minor bump fails before the first cut too", async () => {
  const checks = await prChecks(
    prFake({ latestTag: null, lockstep: "0.5.0", baseRuntime: "0.4.1" }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["minor-bump-labelled"]);
});

Deno.test("pr: a breaking label without a minor bump fails", async () => {
  const checks = await prChecks(
    // last cut v0.4.0, manifests 0.4.1 — a patch line, not a new minor.
    prFake({
      lockstep: "0.4.1",
      baseRuntime: "0.4.1",
      latestTag: "v0.4.0",
      labels: ["breaking/runtime"],
    }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["breaking-label-bumped"]);
  assertStringIncludes(detail(checks, "breaking-label-bumped"), "breaking/runtime");
});

Deno.test("pr: a breaking label with the minor bumped passes", async () => {
  const checks = await prChecks(
    prFake({
      lockstep: "0.5.0",
      baseRuntime: "0.4.1",
      latestTag: "v0.4.0",
      labels: ["breaking/wasi", "breaking/ct-runner"],
    }),
    PR_ENV,
  );
  assertEquals(failed(checks), []);
});

Deno.test("pr: an unlabelled minor bump fails the converse check", async () => {
  const checks = await prChecks(
    prFake({ lockstep: "0.5.0", baseRuntime: "0.4.1", latestTag: "v0.4.0" }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["minor-bump-labelled"]);
  assertStringIncludes(detail(checks, "minor-bump-labelled"), "0.4.1 -> 0.5.0");
});

Deno.test("pr: the post-cut patch bump needs no label", async () => {
  const checks = await prChecks(
    prFake({ lockstep: "0.4.1", baseRuntime: "0.4.0", latestTag: "v0.4.0" }),
    PR_ENV,
  );
  assertEquals(failed(checks), []);
});

Deno.test("pr: an unfetchable base is a failure, not a silent skip", async () => {
  const checks = await prChecks(prFake({ baseRuntime: null }), PR_ENV);
  assertEquals(failed(checks), ["minor-bump-labelled"]);
  assertStringIncludes(detail(checks, "minor-bump-labelled"), "did not fetch");
});

Deno.test("pr: breaking/protocol needs protocol's minor bumped", async () => {
  const bad = protocolPrChecks({
    protocolVersion: "0.2.2",
    publishedProtocol: "0.2.1",
    protocolBreaking: true,
    changed: ["protocol/src/mod.ts", "protocol/deno.json"],
  });
  assertEquals(failed(bad), ["protocol-breaking-label"]);
  const good = protocolPrChecks({
    protocolVersion: "0.3.0",
    publishedProtocol: "0.2.1",
    protocolBreaking: true,
    changed: ["protocol/src/mod.ts", "protocol/deno.json"],
  });
  assertEquals(failed(good), []);
});

Deno.test("pr: the tear, caught early — protocol/src moves, manifest does not", async () => {
  // Exactly the #219 shape: protocol source changed, protocol/deno.json
  // left at a version JSR has already published.
  const checks = await prChecks(
    prFake({
      protocol: "0.2.0",
      published: "0.2.0",
      changed: ["protocol/src/cloneable.ts", "runtime/src/x.ts"],
    }),
    PR_ENV,
  );
  assertEquals(failed(checks), ["protocol-tear"]);
  const d = detail(checks, "protocol-tear");
  assertStringIncludes(d, "protocol/src/cloneable.ts");
  assertStringIncludes(d, "Bump protocol/deno.json or revert");
});

Deno.test("pr: a protocol change WITH a bump passes the tear check", async () => {
  const checks = await prChecks(
    prFake({
      protocol: "0.2.2",
      published: "0.2.1",
      changed: ["protocol/src/cloneable.ts"],
    }),
    PR_ENV,
  );
  assertEquals(failed(checks), []);
});

Deno.test("pr: no PR_NUMBER is a skip, not a failure (push runs, local `just ci`)", async () => {
  const fx = fake({ env: {} });
  assertEquals(await main(fx, ["pr"]), 0);
  assertStringIncludes(fx.logs.join("\n"), "SKIP");
});

// ----- publish mode -----------------------------------------------------------

const PROTOCOL_SRC = {
  "protocol/src/mod.ts": "export * from './cloneable.ts';\n",
  "protocol/src/cloneable.ts": "export const cloneable = 1;\n",
  "protocol/deno.json": manifest("protocol", "0.2.1"),
};

/** A published-version manifest matching the given in-tree files, in the
 * real `<version>_meta.json` shape. */
async function metaFor(
  files: Record<string, string>,
  omit: string[] = [],
): Promise<HttpResponse> {
  const enc = new TextEncoder();
  const m: Record<string, { size: number; checksum: string }> = {};
  for (const [path, body] of Object.entries(files)) {
    if (omit.includes(path)) continue;
    const bytes = enc.encode(body);
    m[path.replace(/^protocol/, "")] = {
      size: bytes.length,
      checksum: `sha256-${await sha256Hex(bytes)}`,
    };
  }
  return {
    status: 200,
    body: JSON.stringify({ manifest: m, moduleGraph2: {} }),
  };
}

const META_URL = (v: string) => `https://jsr.io/@polyengine/protocol/${v}_meta.json`;

Deno.test("publish: an unpublished version passes — this run publishes it", async () => {
  const fx = fake({ files: PROTOCOL_SRC, http: {} });
  const checks = await publishChecks(fx, "0.2.1");
  assertEquals(failed(checks), []);
  assertStringIncludes(detail(checks, "protocol-identity"), "not published");
});

Deno.test("publish: byte-identical in-tree protocol passes", async () => {
  const fx = fake({
    files: PROTOCOL_SRC,
    http: { [META_URL("0.2.1")]: await metaFor(PROTOCOL_SRC) },
  });
  assertEquals(failed(await publishChecks(fx, "0.2.1")), []);
});

Deno.test("publish: THE TEAR — a published version missing an in-tree file fails", async () => {
  // The #219 state exactly: protocol/src gained cloneable.ts after 0.2.0
  // was already on JSR, so a publish would skip protocol and ship its
  // dependents against a copy without those exports.
  const fx = fake({
    files: PROTOCOL_SRC,
    http: {
      [META_URL("0.2.0")]: await metaFor(PROTOCOL_SRC, [
        "protocol/src/cloneable.ts",
      ]),
    },
  });
  const checks = await publishChecks(fx, "0.2.0");
  assertEquals(failed(checks), ["protocol-identity"]);
  const d = detail(checks, "protocol-identity");
  assertStringIncludes(d, "not in the published version: protocol/src/cloneable.ts");
  assertStringIncludes(d, "bump protocol/deno.json");
});

Deno.test("publish: edited content under an already-published version fails", async () => {
  const published = await metaFor({
    ...PROTOCOL_SRC,
    "protocol/src/mod.ts": "export const old = 1;\n",
  });
  const fx = fake({ files: PROTOCOL_SRC, http: { [META_URL("0.2.1")]: published } });
  const checks = await publishChecks(fx, "0.2.1");
  assertEquals(failed(checks), ["protocol-identity"]);
  assertStringIncludes(detail(checks, "protocol-identity"), "content differs: protocol/src/mod.ts");
});

Deno.test("publish: a file published but deleted in tree fails", async () => {
  const fx = fake({
    files: {
      "protocol/src/mod.ts": PROTOCOL_SRC["protocol/src/mod.ts"],
      "protocol/deno.json": PROTOCOL_SRC["protocol/deno.json"],
    },
    http: { [META_URL("0.2.1")]: await metaFor(PROTOCOL_SRC) },
  });
  const checks = await publishChecks(fx, "0.2.1");
  assertEquals(failed(checks), ["protocol-identity"]);
  assertStringIncludes(detail(checks, "protocol-identity"), "missing in tree: protocol/src/cloneable.ts");
});

// ----- cut mode ---------------------------------------------------------------

const win = (
  prs: { number: number; title: string; labels?: string[] }[],
  direct: { sha: string; subject: string }[] = [],
) => ({
  prs: prs.map((p) => ({ ...p, labels: p.labels ?? [] })),
  direct,
});

Deno.test("cut: a breaking label in the window forces a minor bump", async () => {
  const window = win([
    { number: 219, title: "cloneable forms", labels: ["breaking/runtime"] },
    { number: 220, title: "realloc window" },
  ]);
  const bad = cutGuards({
    version: "0.4.1",
    lastCutVersion: "0.4.0",
    protocolVersion: "0.2.1",
    protocolAtLastCut: "0.2.1",
    window,
  });
  assertEquals(failed(bad), ["cut-lockstep-labels"]);
  assertStringIncludes(detail(bad, "cut-lockstep-labels"), "#219");

  const good = cutGuards({
    version: "0.5.0",
    lastCutVersion: "0.4.0",
    protocolVersion: "0.2.1",
    protocolAtLastCut: "0.2.1",
    window,
  });
  assertEquals(failed(good), []);
});

Deno.test("cut: breaking/protocol is judged against protocol at the last cut", async () => {
  const window = win([{ number: 219, title: "A20", labels: ["breaking/protocol"] }]);
  const bad = cutGuards({
    version: "0.5.0",
    lastCutVersion: "0.4.0",
    protocolVersion: "0.2.1",
    protocolAtLastCut: "0.2.0",
    window,
  });
  assertEquals(failed(bad), ["cut-protocol-labels"]);
  const good = cutGuards({
    version: "0.5.0",
    lastCutVersion: "0.4.0",
    protocolVersion: "0.3.0",
    protocolAtLastCut: "0.2.0",
    window,
  });
  assertEquals(failed(good), []);
});

Deno.test("cut: notes render breaking, changes, and direct commits", () => {
  const notes = renderNotes(win(
    [
      {
        number: 219,
        title: "cloneable forms",
        labels: ["breaking/runtime", "breaking/protocol", "area/cabi"],
      },
      { number: 220, title: "realloc may leave the window" },
    ],
    [{ sha: "f9052bbdeadbeef", subject: "Merge origin/main: renumber to A20" }],
  ));
  assertEquals(notes.split("\n"), [
    "## Breaking",
    "",
    "- cloneable forms (#219) — breaks: runtime, protocol",
    "",
    "## Changes",
    "",
    "- realloc may leave the window (#220)",
    "- Merge origin/main: renumber to A20 (f9052bb)",
    "",
  ]);
});

Deno.test("cut: empty sections are omitted", () => {
  assertEquals(
    renderNotes(win([{ number: 1, title: "only a change" }])),
    "## Changes\n\n- only a change (#1)\n",
  );
  assertEquals(
    renderNotes(win([{ number: 1, title: "only breakage", labels: ["breaking/wasi"] }])),
    "## Breaking\n\n- only breakage (#1) — breaks: wasi\n",
  );
  assertEquals(renderNotes(win([])), "");
});

Deno.test("cut: end to end — window scan, guards, and the notes fragment", async () => {
  const R = "polymorph-components/polyengine";
  const fx = fake({
    files: { "protocol/deno.json": manifest("protocol", "0.2.1") },
    env: {
      GITHUB_REPOSITORY: R,
      GITHUB_SHA: "cut12345",
      VERSION: "0.5.0",
    },
    gh: {
      [`api repos/${R}/releases/latest`]: ghJson({ tag_name: "v0.4.0" }),
      [`api repos/${R}/compare/v0.4.0...cut12345`]: ghJson({
        total_commits: 3,
        commits: [
          { sha: "aaa1111", commit: { message: "Merge PR #219\n\nbody" } },
          { sha: "bbb2222", commit: { message: "Merge PR #219 again\n" } },
          { sha: "ccc3333", commit: { message: "direct push: fix typo\nbody" } },
        ],
      }),
      [`api repos/${R}/commits/aaa1111/pulls`]: ghJson([
        { number: 219, title: "cloneable forms", labels: [{ name: "breaking/runtime" }] },
      ]),
      // Same PR on a second commit: deduped, not double-counted.
      [`api repos/${R}/commits/bbb2222/pulls`]: ghJson([
        { number: 219, title: "cloneable forms", labels: [{ name: "breaking/runtime" }] },
      ]),
      [`api repos/${R}/commits/ccc3333/pulls`]: ghJson([]),
      [`api repos/${R}/contents/protocol/deno.json?ref=v0.4.0`]: ghJson({
        content: btoa(manifest("protocol", "0.2.1")),
      }),
    },
  });
  assertEquals(await main(fx, ["cut", "--out", "changes.md"]), 0);
  assertEquals(fx.written["changes.md"].split("\n"), [
    "## Breaking",
    "",
    "- cloneable forms (#219) — breaks: runtime",
    "",
    "## Changes",
    "",
    "- direct push: fix typo (ccc3333)",
    "",
  ]);
});

Deno.test("cut: a truncated compare window is refused, not silently scanned", async () => {
  const R = "polymorph-components/polyengine";
  const fx = fake({
    files: { "protocol/deno.json": manifest("protocol", "0.2.1") },
    gh: {
      [`api repos/${R}/releases/latest`]: ghJson({ tag_name: "v0.4.0" }),
      [`api repos/${R}/compare/v0.4.0...cut12345`]: ghJson({
        total_commits: 300,
        commits: [{ sha: "aaa1111", commit: { message: "x" } }],
      }),
    },
  });
  let message = "";
  try {
    await cutChecks(fx, {
      repo: R,
      sha: "cut12345",
      version: "0.5.0",
      out: null,
    });
  } catch (e) {
    message = (e as Error).message;
  }
  assertStringIncludes(message, "250-commit cap");
});

Deno.test("cut: the first cut ever has no window", async () => {
  const R = "polymorph-components/polyengine";
  const fx = fake({
    files: { "protocol/deno.json": manifest("protocol", "0.1.0") },
    gh: { [`api repos/${R}/releases/latest`]: gh404 },
  });
  const checks = await cutChecks(fx, {
    repo: R,
    sha: "cut12345",
    version: "0.1.0",
    out: "changes.md",
  });
  assertEquals(failed(checks), []);
  assertEquals(fx.written["changes.md"], "");
});
