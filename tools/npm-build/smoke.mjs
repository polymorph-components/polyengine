// The npm distribution's gate: pack the built packages, install them the way a
// consumer would, and prove the result actually runs.
//
//   <pinned node> tools/npm-build/smoke.mjs
//
// Run through `just test-npm`, which builds first and supplies the pinned Node
// (tools/shell/pins.json) rather than whatever is on PATH.
//
// Why pack-and-install rather than importing `npm/<pkg>/esm/mod.js` directly:
// only a real install exercises the things that actually break a publish — the
// `exports` map (a missing subpath is invisible until someone imports it), the
// dependency edges, and the file list (an asset left out of the tarball).
//
// What it proves, in order of what would hurt most if it broke:
//
//   1. ONE copy of each package in the installed graph. Cross-package imports
//      must be npm dependencies, not inlined source — see
//      contracts/embedder-api.md §"Module identity and @polyengine/protocol"
//      and the header of build.ts.
//   2. Versions and dependency edges match the module-identity /
//      version-canonicalization policy: protocol rides
//      its own manifest version (on both registries); the lockstep four
//      share one emission version; dep edges are exact-lockstep-sibling vs.
//      caret-protocol.
//   3. Brands cross package boundaries: a value branded by the runtime is
//      recognized by the protocol package's predicate, on the registry symbols.
//   4. The pipeline runs: load the packaged translator, translate a real guest
//      component, instantiate it, call an export, check the answer.
//   5. The SHIPPED .d.ts type-check from outside, against the installed
//      packages (dnt's own type check is deliberately off — see build.ts).

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PACKAGES = ["protocol", "runtime", "translator", "wasi", "ct-runner"];
const LOCKSTEP = ["runtime", "translator", "wasi", "ct-runner"];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Versions and dependency edges (contracts/embedder-api.md §"Module identity
 * and @polyengine/protocol", §"Version canonicalization"): protocol
 * rides its own manifest version on both registries; the lockstep four share
 * runtime's manifest version; a lockstep sibling dep pins exact, a protocol
 * dep pins caret-of-protocol's-manifest-version. Checked against the ALREADY
 * BUILT `npm/` tree (built by the `npm-build` recipe this task depends on),
 * mirroring release.yml's "compute tag and version" guard on the JSR side.
 */
function checkVersionsAndEdges() {
  const manifest = {};
  const built = {};
  for (const pkg of PACKAGES) {
    manifest[pkg] = readJson(join(REPO, pkg, "deno.json"));
    built[pkg] = readJson(join(REPO, "npm", pkg, "package.json"));
  }

  if (built.protocol.version !== manifest.protocol.version) {
    throw new Error(
      `protocol built at ${built.protocol.version}, manifest says ` +
        `${manifest.protocol.version}`,
    );
  }

  const runtimeManifestVersion = manifest.runtime.version;
  for (const pkg of LOCKSTEP) {
    if (built[pkg].version !== runtimeManifestVersion) {
      throw new Error(
        `${pkg} built at ${built[pkg].version}, expected lockstep version ` +
          `${runtimeManifestVersion} (runtime's manifest version)`,
      );
    }
  }

  const expectedCaret = `^${manifest.protocol.version}`;
  let sawProtocolDepOnRuntime = false;
  let sawRuntimeDepOnCtRunner = false;
  for (const pkg of PACKAGES) {
    const deps = built[pkg].dependencies ?? {};
    for (const [depName, depVersion] of Object.entries(deps)) {
      if (!depName.startsWith("@polyengine/")) continue;
      const depPkg = depName.slice("@polyengine/".length);
      if (depPkg === "protocol") {
        if (depVersion !== expectedCaret) {
          throw new Error(
            `${pkg}'s dependency on protocol is "${depVersion}", expected ` +
              `"${expectedCaret}" (caret of protocol's manifest version)`,
          );
        }
        if (pkg === "runtime") sawProtocolDepOnRuntime = true;
      } else if (LOCKSTEP.includes(depPkg)) {
        if (depVersion !== runtimeManifestVersion) {
          throw new Error(
            `${pkg}'s dependency on ${depPkg} is "${depVersion}", expected ` +
              `exact "${runtimeManifestVersion}" (lockstep emission version)`,
          );
        }
        if (pkg === "ct-runner" && depPkg === "runtime") {
          sawRuntimeDepOnCtRunner = true;
        }
      } else {
        throw new Error(`${pkg}: unexpected dependency "${depName}"`);
      }
    }
  }

  // Edge presence: without these the assertions above would pass vacuously
  // if the mappings were silently dropped.
  if (!sawProtocolDepOnRuntime) {
    throw new Error("expected runtime's package.json to depend on protocol");
  }
  if (!sawRuntimeDepOnCtRunner) {
    throw new Error("expected ct-runner's package.json to depend on runtime");
  }

  console.log(
    `    protocol@${built.protocol.version} (manifest-pinned)`,
  );
  console.log(`    lockstep@${runtimeManifestVersion}: ${LOCKSTEP.join(", ")}`);
  console.log(`    runtime -> protocol: "${expectedCaret}"`);
  console.log(`    ct-runner -> runtime: "${runtimeManifestVersion}"`);
}

const npmCli = join(
  REPO,
  ".shell-cache/node-pinned/lib/node_modules/npm/bin/npm-cli.js",
);

function npm(args, cwd) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, npm_config_update_notifier: "false" },
  });
}

function step(name) {
  console.log(`\n--- ${name}`);
}

const work = mkdtempSync(join(tmpdir(), "polyengine-npm-smoke-"));
let failed = false;
try {
  step("versions and dependency edges");
  checkVersionsAndEdges();

  step("pack the built packages");
  const tarballs = [];
  for (const pkg of PACKAGES) {
    const dir = join(REPO, "npm", pkg);
    const out = npm(["pack", "--pack-destination", work, "--json"], dir);
    const [{ filename, size }] = JSON.parse(out);
    tarballs.push(join(work, filename));
    console.log(`    ${filename}  ${(size / 1024).toFixed(0)} KiB`);
  }

  step("install them into a throwaway project");
  const project = join(work, "consumer");
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      { name: "polyengine-npm-smoke", private: true, type: "module" },
      null,
      2,
    ),
  );
  // The tarballs resolve each other locally; nothing @polyengine is fetched.
  npm(["install", "--no-audit", "--no-fund", ...tarballs], project);
  npm(
    ["install", "--no-audit", "--no-fund", "--save-dev", "typescript@5"],
    project,
  );

  step("stage the guest fixture");
  const fixture = join(REPO, "examples/guests/build/hello.component.wasm");
  cpSync(fixture, join(project, "hello.component.wasm"));

  step("run the consumer checks");
  cpSync(join(HERE, "consumer"), project, { recursive: true });
  execFileSync(process.execPath, [join(project, "check.mjs")], {
    cwd: project,
    stdio: "inherit",
  });

  step("type-check the shipped .d.ts from a consumer's position");
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2023",
          lib: ["esnext", "dom"],
          strict: true,
          noEmit: true,
          types: [],
        },
        files: ["types.ts"],
      },
      null,
      2,
    ),
  );
  execFileSync(
    process.execPath,
    [join(project, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", "."],
    { cwd: project, stdio: "inherit" },
  );
  console.log("    type surface OK");

  console.log("\nnpm smoke: OK");
} catch (e) {
  failed = true;
  console.error(`\nnpm smoke: FAILED — ${e.message}`);
  if (e.stdout) console.error(String(e.stdout));
  if (e.stderr) console.error(String(e.stderr));
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
