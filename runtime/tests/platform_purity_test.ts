// Platform-purity guard (docs/architecture.md §4.3): the runtime core depends on the
// WebAssembly JS API, TextEncoder/TextDecoder, and Promises — nothing
// platform-specific. A `node:` (or `deno`-global) dependency creeping into
// runtime/src breaks every browser lane at once; the M3A-1 episode (the
// scheduler's ambient rode `node:async_hooks` AsyncLocalStorage, costing 80
// async/ commands in every browser until replaced by explicit ambient
// threading) is the incident this test pins. Source-scanning is crude but
// exactly the right strength: the browser bundler would accept a mapped
// alias, so a type-level check cannot catch it.

const RUNTIME_SRC = new URL("../src/", import.meta.url);

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const e of Deno.readDir(dir)) {
    const child = new URL(e.isDirectory ? `${e.name}/` : e.name, dir);
    if (e.isDirectory) yield* walk(child);
    else if (e.name.endsWith(".ts")) yield child;
  }
}

Deno.test("runtime/src imports no node: specifiers (platform purity)", async () => {
  const offenders: string[] = [];
  for await (const file of walk(RUNTIME_SRC)) {
    const text = await Deno.readTextFile(file);
    // Import/export specifiers only — comments mentioning node: APIs are
    // fine (several document the M3A-1 history deliberately).
    for (
      const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](node:[^"']+)["']/g)
    ) {
      offenders.push(`${file.pathname}: ${m[1]}`);
    }
  }
  if (offenders.length > 0) {
    throw new Error(`platform purity violated:\n  ${offenders.join("\n  ")}`);
  }
});
