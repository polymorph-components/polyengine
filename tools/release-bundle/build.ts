// Builds the consumer-facing embedder bundle (see ./entry.ts) — the
// `polyengine-embedder.mjs` release asset. Same emission mechanism as the
// browser lanes (tools/browser/bundle.ts): `deno bundle --platform browser`,
// which resolves the workspace's `@polyengine/*` bare specifiers natively and
// fails on `node:` residues (the runtime is platform-neutral by contract,
// docs/architecture.md §4.3).
//
// Usage: deno run -A tools/release-bundle/build.ts [--out <path>]
//        (default: tools/release-bundle/dist/polyengine-embedder.mjs, gitignored)

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

export async function buildBundle(out?: string, entry?: string): Promise<string> {
  const outPath = out ??
    join(repoRoot, "tools", "release-bundle", "dist", "polyengine-embedder.mjs");
  await Deno.mkdir(dirname(outPath), { recursive: true });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--format",
      "esm",
      "-o",
      outPath,
      entry ?? join(repoRoot, "tools", "release-bundle", "entry.ts"),
    ],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);
  return outPath;
}

if (import.meta.main) {
  const outIdx = Deno.args.indexOf("--out");
  const out = outIdx >= 0 ? Deno.args[outIdx + 1] : undefined;
  console.log(await buildBundle(out));
}
