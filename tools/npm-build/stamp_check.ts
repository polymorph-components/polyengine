// The stamp-path leg of `just test-npm`: proves the `--version` override
// works as release.yml's prerelease path relies on it — stamping the
// lockstep four while leaving @polyengine/protocol on its own manifest
// version (contracts/embedder-api.md §"Version canonicalization").
//
//   deno run -A tools/npm-build/stamp_check.ts <out-dir> <stamp>
//
// Invoked by the `test-npm` justfile recipe after build.ts has been run a
// second time with `--version <stamp> --out <out-dir>` (a throwaway
// directory, never the repo's gitignored `npm/`). Fast and side-effect-free:
// no packing, no install — just reads the emitted package.json files.

import { join } from "jsr:@std/path@1";

const REPO = new URL("../..", import.meta.url).pathname;
const LOCKSTEP = ["runtime", "translator", "wasi", "ct-runner"];
const PACKAGES = ["protocol", ...LOCKSTEP];

function fail(msg: string): never {
  console.error(`stamp check: FAILED — ${msg}`);
  Deno.exit(1);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function main() {
  const [outDir, stamp] = Deno.args;
  if (!outDir || !stamp) {
    fail("usage: stamp_check.ts <out-dir> <stamp>");
  }

  const protocolManifest = await readJson(
    join(REPO, "protocol", "deno.json"),
  );
  const protocolManifestVersion = protocolManifest.version as string;

  const built: Record<string, Record<string, unknown>> = {};
  for (const pkg of PACKAGES) {
    built[pkg] = await readJson(join(outDir, pkg, "package.json"));
  }

  if (built.protocol.version !== protocolManifestVersion) {
    fail(
      `protocol emitted at ${built.protocol.version} under --version ` +
        `${stamp}, expected it to stay at its manifest version ` +
        `${protocolManifestVersion} (--version must not affect it)`,
    );
  }

  for (const pkg of LOCKSTEP) {
    if (built[pkg].version !== stamp) {
      fail(`${pkg} emitted at ${built[pkg].version}, expected stamp ${stamp}`);
    }
  }

  const expectedCaret = `^${protocolManifestVersion}`;
  for (const pkg of PACKAGES) {
    const deps = (built[pkg].dependencies ?? {}) as Record<string, string>;
    for (const [name, version] of Object.entries(deps)) {
      if (!name.startsWith("@polyengine/")) continue;
      const depPkg = name.slice("@polyengine/".length);
      if (depPkg === "protocol") {
        if (version !== expectedCaret) {
          fail(
            `${pkg} -> protocol is "${version}", expected "${expectedCaret}"`,
          );
        }
      } else if (LOCKSTEP.includes(depPkg)) {
        if (version !== stamp) {
          fail(
            `${pkg} -> ${depPkg} is "${version}", expected exact "${stamp}"`,
          );
        }
      }
    }
  }

  console.log(
    `stamp check: OK (protocol@${protocolManifestVersion}, lockstep@${stamp})`,
  );
}

await main();
