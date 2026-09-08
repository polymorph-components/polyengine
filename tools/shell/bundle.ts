// Builds the shell-lane bundle into tools/shell/dist/ (gitignored).
//
// Usage: deno run -A tools/shell/bundle.ts

import { dirname, fromFileUrl, join, normalize } from "jsr:@std/path@1";

const repoRoot = normalize(
  join(dirname(fromFileUrl(import.meta.url)), "..", ".."),
);

export async function bundle(): Promise<void> {
  const out = join(repoRoot, "tools", "shell", "dist", "entry.js");
  await Deno.mkdir(dirname(out), { recursive: true });
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--format",
      "esm",
      "--sourcemap=linked",
      "-o",
      out,
      join(repoRoot, "tools", "shell", "entry.ts"),
    ],
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await cmd.output();
  if (code !== 0) throw new Error(`deno bundle failed with code ${code}`);
  // .mjs makes ESM explicit for Node/Bun without package.json or syntax detection.
  // The shells load the byte-identical entry.js.
  await Deno.copyFile(out, join(dirname(out), "entry.mjs"));
  return;
}

if (import.meta.main) await bundle();
