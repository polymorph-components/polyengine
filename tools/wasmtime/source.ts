import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const REPO_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");

/** Resolve the exact Wasmtime checkout selected by Cargo.lock. */
export interface WasmtimeSource {
  path: string;
  rev: string;
}

interface MetadataPackage {
  name: string;
  source: string | null;
  manifest_path: string;
}

export async function resolveWasmtimeSource(): Promise<WasmtimeSource> {
  const command = new Deno.Command("cargo", {
    cwd: REPO_ROOT,
    args: ["metadata", "--locked", "--format-version", "1"],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    throw new Error(
      `cargo metadata --locked failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  const metadata = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    packages: MetadataPackage[];
  };
  const pkg = metadata.packages.find((p) => p.name === "wasmtime-environ");
  if (pkg === undefined || pkg.source === null) {
    throw new Error(
      "locked wasmtime-environ package is absent from cargo metadata",
    );
  }
  const precise = new URLSearchParams(
    pkg.source.split("?")[1]?.split("#")[0] ?? "",
  ).get("rev");
  const locked = pkg.source.split("#")[1];
  const rev = locked ?? precise;
  if (rev === null || !/^[0-9a-f]{40}$/.test(rev)) {
    throw new Error(
      `wasmtime-environ source has no precise revision: ${pkg.source}`,
    );
  }
  // wasmtime-environ lives at <checkout>/crates/environ/Cargo.toml.
  const path = dirname(dirname(dirname(pkg.manifest_path)));
  return { path, rev };
}

if (import.meta.main) {
  console.log(JSON.stringify(await resolveWasmtimeSource()));
}
