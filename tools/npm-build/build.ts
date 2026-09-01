// The npm distribution of the five workspace packages.
//
//   deno run -A tools/npm-build/build.ts [--version X.Y.Z] [--out DIR]
//
// JSR is the primary registry (README §Consuming); this emits the same five
// packages for npm consumers, from the same sources, at the same version AS
// THEIR JSR COUNTERPART. The build is a pure function of the workspace:
// `name`, `version` and `exports` come from each package's deno.json, so a
// version bump or a new entry point needs no edit here.
//
// Versioning mirrors release.yml's "compute tag and version" step exactly:
// runtime, translator, wasi and ct-runner are a LOCKSTEP set (one emission
// version between them — either the caller's `--version` stamp, or their
// agreeing manifest version when no stamp is given). @polyengine/protocol is
// policy-exempt from the lockstep (contracts/embedder-api.md §"Version
// canonicalization"): it ALWAYS
// emits at its own manifest version, on both registries, regardless of
// `--version`. Dependency edges follow the same asymmetry: a lockstep
// package depending on a lockstep sibling pins the exact emission version
// (they publish atomically); a dependency on protocol is a caret of
// protocol's manifest version (`^0.1.0`), matching what `deno publish`
// itself does when it rewrites workspace cross-deps for the JSR emission —
// letting a protocol bump dedup across lockstep versions built before and
// after it, per contracts/embedder-api.md §"Module identity and
// @polyengine/protocol"'s preference for one copy in a consumer's graph.
//
// Tool: dnt (jsr:@deno/dnt), which transpiles the TS sources, rewrites `.ts`
// specifiers to `.js`, and emits `.d.ts`. Output is ESM ONLY and that is not a
// style choice: several modules use top-level await (wasi/src/io.ts,
// wasi/src/clocks.ts, ct-runner/src/run-suite.ts, ...) and copy identity is
// `import.meta.url` (runtime/src/embedder/copy.ts), neither of which survives a
// CommonJS emit.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT: cross-package imports become real
// npm `dependencies`, never inlined source. Duplicate copies of the runtime or
// the protocol package in one module graph are the latent-failure mode that
// contracts/embedder-api.md §"Module identity and @polyengine/protocol" is
// a response to; registry symbols
// make a duplicate survivable, not correct. `mappings` below forces every
// `@polyengine/*` specifier — including subpath forms like
// `@polyengine/runtime/shim` — onto the npm package at the exact same version.
// tools/npm-build/smoke.mjs asserts the property mechanically after packing.
//
// Build order is dependency order, and each package is built with its
// already-built dependencies linked into a local `node_modules` so tsc can
// resolve their types. dnt's own `npm install` is skipped: the dependencies do
// not exist on the registry at the version being built (they are being built
// right now), so a real install would fail on every first publish of a version.

import { build, emptyDir } from "jsr:@deno/dnt@0.43.2";
import { dirname, fromFileUrl, join, resolve } from "jsr:@std/path@1";

const REPO = resolve(dirname(fromFileUrl(import.meta.url)), "..", "..");

/** Dependency order: a package is built after everything it imports. */
const PACKAGES = [
  "protocol",
  "runtime",
  "translator",
  "wasi",
  "ct-runner",
] as const;

/**
 * The lockstep set (mirrors release.yml's "compute tag and version" guard):
 * these four share one emission version. @polyengine/protocol is deliberately
 * excluded — contracts/embedder-api.md §"Version canonicalization" — and
 * always emits at its own
 * manifest version.
 */
const LOCKSTEP = ["runtime", "translator", "wasi", "ct-runner"] as const;

const DESCRIPTIONS: Record<string, string> = {
  protocol:
    "The dependency-free brand vocabulary shared by polyengine copies: registry symbols, canonical error classes, and the copy registry.",
  runtime:
    "A WebAssembly Component Model host for JavaScript engines: plan executor, canonical ABI, 0.3 task scheduler, JSPI bridge, and embedder API.",
  translator:
    "The packaged polyengine translator (wasmtime's translation frontend compiled to wasm) plus its per-platform loader.",
  wasi:
    "WASI providers for polyengine hosts: the p2 baseline and p3 clocks, one module per semver track.",
  "ct-runner":
    "The polyengine execution runner for component-test-results (L1) conformance suites.",
};

interface DenoManifest {
  name: string;
  version: string;
  exports: string | Record<string, string>;
}

function readManifest(pkg: string): DenoManifest {
  const path = join(REPO, pkg, "deno.json");
  const raw = JSON.parse(Deno.readTextFileSync(path)) as DenoManifest;
  if (!raw.name || !raw.version || !raw.exports) {
    throw new Error(`${path}: expected name, version and exports`);
  }
  return raw;
}

/** deno.json `exports` normalized to subpath -> repo-relative file. */
function exportMap(pkg: string, m: DenoManifest): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = typeof m.exports === "string"
    ? { ".": m.exports }
    : m.exports;
  for (const [subpath, file] of Object.entries(entries)) {
    out[subpath] = join(REPO, pkg, file);
  }
  return out;
}

function parseArgs(argv: string[]): { version?: string; out: string } {
  let version: string | undefined;
  let out = join(REPO, "npm");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") version = argv[++i];
    else if (argv[i] === "--out") out = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return { version, out };
}

async function main() {
  const { version: override, out: outRoot } = parseArgs(Deno.args);

  const manifests = new Map<string, DenoManifest>();
  const exports = new Map<string, Record<string, string>>();
  for (const pkg of PACKAGES) {
    const m = readManifest(pkg);
    manifests.set(pkg, m);
    exports.set(pkg, exportMap(pkg, m));
  }

  // One version for the lockstep four: either the manifests' (which the
  // release workflow's lockstep guard already pins to agree) or the caller's
  // stamp for a prerelease. A torn set would produce packages depending on
  // sibling versions that were never published. protocol is NOT part of
  // this — it rides its own manifest version always (see header).
  for (const p of LOCKSTEP) {
    const v = manifests.get(p)!.version;
    const ref = manifests.get("runtime")!.version;
    if (v !== ref) {
      throw new Error(
        `lockstep violation: runtime=${ref} ${p}=${v} — the four lockstep ` +
          `manifests (runtime, translator, wasi, ct-runner) must agree ` +
          `(--version stamps the emission but never excuses a torn workspace)`,
      );
    }
  }
  const lockstepVersion = override ?? manifests.get("runtime")!.version;
  const protocolVersion = manifests.get("protocol")!.version;
  const emissionVersion = (pkg: string) =>
    pkg === "protocol" ? protocolVersion : lockstepVersion;

  // Every `@polyengine/*` entry-point source file -> the npm package that owns
  // it, keyed by the bare specifier a source file would write. dnt REJECTS a
  // mapping it does not encounter, so each build passes only the subset that
  // package actually imports (see `specifiersUsedBy`).
  const bySpecifier = new Map<
    string,
    { file: string; name: string; version: string; subPath?: string }
  >();
  for (const pkg of PACKAGES) {
    const name = manifests.get(pkg)!.name;
    // Dependency edges: a lockstep sibling is pinned EXACT (they publish
    // atomically, and a prerelease stamp must pin exactly what it built
    // alongside); protocol is pinned by CARET of its own manifest version —
    // JSR parity, since `deno publish` rewrites workspace cross-deps to
    // caret, and it lets a protocol bump dedup across mixed lockstep
    // versions in one consumer's graph.
    const depVersion = pkg === "protocol"
      ? `^${protocolVersion}`
      : emissionVersion(pkg);
    for (const [subpath, file] of Object.entries(exports.get(pkg)!)) {
      const specifier = subpath === "." ? name : `${name}${subpath.slice(1)}`;
      // dnt drops the subpath unless it is given explicitly, which would
      // rewrite `@polyengine/runtime/shim` to a bare `@polyengine/runtime`
      // — a specifier the package deliberately does not export.
      bySpecifier.set(specifier, {
        file,
        name,
        version: depVersion,
        subPath: subpath === "." ? undefined : subpath.slice(2),
      });
    }
  }

  const shimAsset = join(REPO, "translator", "translator_shim.wasm");
  if (!(await exists(shimAsset))) {
    throw new Error(
      `missing ${shimAsset} — the packaged translator asset is gitignored; ` +
        `run \`just shim\` first (the \`npm-build\` recipe depends on it)`,
    );
  }

  const license = await Deno.readTextFile(join(REPO, "LICENSE"));

  for (const pkg of PACKAGES) {
    const m = manifests.get(pkg)!;
    const pkgVersion = emissionVersion(pkg);
    const outDir = join(outRoot, pkg);
    console.log(`\n=== ${m.name}@${pkgVersion} -> ${outDir} ===`);
    await emptyDir(outDir);

    // Link the already-built dependencies so type-check and .d.ts emit can
    // resolve them without a registry round trip.
    await linkBuiltDeps(outRoot, outDir, pkg, manifests);

    const entryPoints = Object.entries(exports.get(pkg)!).map((
      [name, path],
    ) => ({ name, path }));

    // `translator/shim_asset_deno.ts` statically imports the wasm as an ES
    // module — a Deno feature that keeps the asset in the analyzable module
    // graph (hence permission-free), and one dnt cannot transpile. Build the
    // npm emission from a staged copy where that module is a stub: mod.ts
    // reaches it only under Deno and now falls through when it fails, so the
    // npm consumer lands on the node:fs / fetch arms. The JSR package keeps
    // the real module untouched.
    const staged = pkg === "translator"
      ? await stageTranslator(entryPoints)
      : null;

    // A package never maps its OWN sources onto itself, and dnt errors on a
    // mapping it never encounters — so pass exactly the sibling entry points
    // this package's sources import.
    const pkgMappings: Record<
      string,
      { name: string; version: string; subPath?: string }
    > = {};
    for (const specifier of await specifiersUsedBy(join(REPO, pkg))) {
      const target = bySpecifier.get(specifier);
      if (target === undefined) {
        throw new Error(
          `${pkg}: imports "${specifier}", which is not an exported entry ` +
            `point of any workspace package — add it to that package's ` +
            `deno.json exports, or fix the import`,
        );
      }
      if (target.name === m.name) continue; // self-reference
      pkgMappings[target.file] = {
        name: target.name,
        version: target.version,
        ...(target.subPath === undefined ? {} : { subPath: target.subPath }),
      };
    }

    await build({
      entryPoints,
      outDir,
      shims: {},
      scriptModule: false, // ESM only — see the header
      test: false,
      // The sources are already type-checked against Deno's lib by each
      // package's `deno task check` (`just build`). Re-checking them here
      // against a Node lib only reports the guarded `Deno.env.get` reads
      // (every one sits in a try/catch that falls back — see
      // runtime/src/task/scheduler.ts readSeed), which are correct at runtime
      // and unfixable at the type level without shipping a Deno shim into a
      // wasm host package. What actually matters for npm consumers — that the
      // EMITTED .d.ts type-check from outside — is gated by
      // tools/npm-build/smoke.mjs against the packed tarballs.
      typeCheck: false,
      declaration: "separate",
      skipNpmInstall: true,
      mappings: pkgMappings,
      compilerOptions: { target: "ES2023", lib: ["ESNext", "DOM"] },
      // No polyfills. The emission is ESM-only for Node >= 22.14, where
      // `import.meta` and `Error.cause` are native; dnt's `importMeta`
      // ponyfill would otherwise inject `node:module` / `node:url` imports
      // into the shipped .d.ts, forcing every consumer — including browser
      // ones, who have no business seeing node builtins — to install
      // @types/node just to type-check this package.
      polyfills: false,
      package: {
        name: m.name,
        version: pkgVersion,
        description: DESCRIPTIONS[pkg],
        license: "Apache-2.0",
        type: "module",
        engines: { node: ">=22.14.0" },
        repository: {
          type: "git",
          url: "git+https://github.com/polymorph-components/polyengine.git",
        },
        homepage: "https://github.com/polymorph-components/polyengine#readme",
        bugs: {
          url: "https://github.com/polymorph-components/polyengine/issues",
        },
        // Scoped packages default to restricted; without this the publish is
        // refused rather than made public.
        publishConfig: { access: "public" },
      },
      async postBuild() {
        await Deno.writeTextFile(join(outDir, "LICENSE"), license);
        await Deno.writeTextFile(
          join(outDir, "README.md"),
          readme(m.name, DESCRIPTIONS[pkg], exports.get(pkg)!),
        );
        // Not decoration: with an `exports` map present, anything not listed
        // is unreachable, and tooling (bundlers, resolvers, the smoke's own
        // copy probe) routinely reads a dependency's package.json.
        const pkgJsonPath = join(outDir, "package.json");
        const pkgJson = JSON.parse(await Deno.readTextFile(pkgJsonPath));
        pkgJson.exports["./package.json"] = "./package.json";
        await Deno.writeTextFile(
          pkgJsonPath,
          JSON.stringify(pkgJson, null, 2) + "\n",
        );
        if (pkg === "translator") {
          // `new URL("./translator_shim.wasm", import.meta.url)` resolves
          // beside the emitted module, not beside the package root.
          await Deno.copyFile(
            shimAsset,
            join(outDir, "esm", "translator_shim.wasm"),
          );
        }
      },
    });

    // dnt leaves the transpiler's TS input tree behind; it is not part of the
    // distribution, and node_modules is a build artifact of this script.
    await Deno.remove(join(outDir, "src"), { recursive: true }).catch(() => {});
    await pruneNodeModules(outDir);
    if (staged !== null) {
      await Deno.remove(staged, { recursive: true }).catch(() => {});
    }
  }

  console.log(
    `\nbuilt ${PACKAGES.length} packages:\n` +
      PACKAGES.map((p) => `  ${manifests.get(p)!.name}@${emissionVersion(p)}`)
        .join("\n"),
  );
}

/**
 * Copy the translator package's TS sources to a temp dir, replacing the
 * Deno-only wasm-asset module with a stub, and repoint `entryPoints` at the
 * copy. Returns the temp dir for cleanup.
 */
async function stageTranslator(
  entryPoints: { name: string; path: string }[],
): Promise<string> {
  // Staged INSIDE the package rather than in /tmp: bare `@polyengine/*`
  // specifiers resolve through the Deno workspace, which only applies to files
  // under the workspace root.
  const dir = join(REPO, "translator", ".npm-stage");
  await emptyDir(dir);
  for await (const entry of Deno.readDir(join(REPO, "translator"))) {
    if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
    await Deno.copyFile(
      join(REPO, "translator", entry.name),
      join(dir, entry.name),
    );
  }
  await Deno.writeTextFile(
    join(dir, "shim_asset_deno.ts"),
    `// Stub for the npm distribution. The real module (JSR / a repo checkout)
// statically imports \`translator_shim.wasm\` as an ES module, which only Deno
// can do; Node cannot parse it, so npm ships this instead. mod.ts reaches this
// module only when \`Deno\` is defined and falls through when it throws, so a
// Deno consumer of the npm package loads the asset through node:fs like any
// other Node-compatible host.
throw new Error(
  "@polyengine/translator: the Deno wasm-asset module is not part of the npm " +
    "distribution (use jsr:@polyengine/translator for the permission-free " +
    "Deno path)",
);
export const ns: WebAssembly.Exports = {};
`,
  );
  for (const ep of entryPoints) {
    ep.path = join(dir, ep.path.slice(join(REPO, "translator").length + 1));
  }
  return dir;
}

/**
 * The distinct `@polyengine/*` bare specifiers imported anywhere under `dir`,
 * excluding the package's own test tree (tests are not published and may
 * import siblings the distribution does not depend on).
 */
async function specifiersUsedBy(dir: string): Promise<Set<string>> {
  const found = new Set<string>();
  const pattern = /["'](@polyengine\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)["']/g;
  for await (const entry of walkTs(dir)) {
    const text = await Deno.readTextFile(entry);
    for (const m of text.matchAll(pattern)) found.add(m[1]);
  }
  return found;
}

async function* walkTs(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      if (entry.name === "tests" || entry.name === "node_modules") continue;
      yield* walkTs(path);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

/**
 * Symlink previously-built sibling packages into `outDir/node_modules` so the
 * TypeScript program can resolve `@polyengine/*` types. These links are removed
 * again before the package is considered done.
 */
async function linkBuiltDeps(
  outRoot: string,
  outDir: string,
  pkg: string,
  manifests: Map<string, DenoManifest>,
) {
  const scope = join(outDir, "node_modules", "@polyengine");
  await Deno.mkdir(scope, { recursive: true });
  for (const dep of PACKAGES) {
    if (dep === pkg) continue;
    const built = join(outRoot, dep);
    if (!(await exists(join(built, "package.json")))) continue; // not yet built
    const short = manifests.get(dep)!.name.split("/")[1];
    await Deno.symlink(built, join(scope, short)).catch(() => {});
  }
}

async function pruneNodeModules(outDir: string) {
  await Deno.remove(join(outDir, "node_modules"), { recursive: true })
    .catch(() => {});
  await Deno.remove(join(outDir, "package-lock.json")).catch(() => {});
}

function readme(
  name: string,
  description: string,
  exports: Record<string, string>,
): string {
  const subpaths = Object.keys(exports).sort();
  const entry = subpaths.includes(".")
    ? name
    : `${name}${subpaths[0].slice(1)}`;
  return `# ${name}

${description}

Part of [polyengine](https://github.com/polymorph-components/polyengine), a
WebAssembly Component Model host for JavaScript engines. This is the npm
distribution; the same package is published to JSR as \`jsr:${name}\`, and the
two are built from the same sources at the same version.

\`\`\`sh
npm install ${name}
\`\`\`

\`\`\`js
import * as api from "${entry}";
\`\`\`

Entry points: ${subpaths.map((s) => `\`${s}\``).join(", ")}.

ESM only, Node >= 22.14. Documentation, examples and the embedder API contract
live in the [repository](https://github.com/polymorph-components/polyengine).

Apache-2.0.
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

if (import.meta.main) await main();
