// The release-asset gate for the embedder bundle: build it exactly as the
// release workflow does, then prove the artifact stands alone — imports as
// one self-contained ES module, carries no platform residues (the runtime
// is platform-neutral by contract, docs/architecture.md §4.3), and drives a
// real suite end to end INCLUDING the tag-gating path (nothing was
// tree-shaken away). Runs in the core CI matrix, which builds the
// translator wasm and the example guests earlier in the job.

import { buildBundle } from "./build.ts";

const root = new URL("../../", import.meta.url);
const TRANSLATOR = new URL(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  root,
);
const SUITE = new URL(
  "examples/guests/build/test-suite.component.wasm",
  root,
);

async function present(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url);
    return true;
  } catch {
    return false;
  }
}
const ready = (await present(TRANSLATOR)) && (await present(SUITE));

function assertEq<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ?? "mismatch"}: got ${g}, want ${w}`);
}

/** Append a `component-test:tags@0.1` custom section (same encoding as
 * ct-runner/tests/tags_test.ts — id 0, LEB name + data, legal anywhere). */
function withTags(bytes: Uint8Array, records: string): Uint8Array {
  const enc = new TextEncoder();
  const leb = (n: number): number[] => {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n !== 0) b |= 0x80;
      out.push(b);
    } while (n !== 0);
    return out;
  };
  const name = enc.encode("component-test:tags@0.1");
  const data = enc.encode(records);
  const payload = [...leb(name.length), ...name, ...data];
  const section = new Uint8Array([0x00, ...leb(payload.length), ...payload]);
  const out = new Uint8Array(bytes.length + section.length);
  out.set(bytes, 0);
  out.set(section, bytes.length);
  return out;
}

Deno.test({
  name: "release bundle: self-contained, platform-neutral, runs a suite (tags included)",
  ignore: !ready,
  fn: async () => {
    const out = await buildBundle();

    // Platform purity of the ARTIFACT (the lanes pin the sources;
    // this pins the emission): no node:/npm: residues, ESM shape.
    const text = await Deno.readTextFile(out);
    assertEq(/from\s*["']node:/.test(text), false, "node: import residue");
    assertEq(/require\(["']node:/.test(text), false, "node: require residue");
    assertEq(/from\s*["']npm:/.test(text), false, "npm: specifier residue");

    const mod = await import(new URL(`file://${out}`).href);

    // The full consumer path through the bundle alone: translate,
    // instantiate, enumerate, execute, tag-gate.
    const translator = await mod.Translator.create(
      await Deno.readFile(TRANSLATOR),
    );
    const componentBytes = withTags(
      await Deno.readFile(SUITE),
      "suite/basic/pass\nsuite/basic/fail\nsuite/basic/skip\n" +
        "suite/diag/chatty\nsuite/diag/slow hw\nsuite/nested/deep/leaf\n",
    );
    const { plan, adapters } = translator.translate(componentBytes);

    const lines: string[] = [];
    const counts = await mod.runSuite({ plan, componentBytes, adapters }, {
      target: "polyengine/bundle",
      suiteName: "test-suite",
      missing: ["hw"],
      emit: (l: string) => lines.push(l),
    });
    assertEq(counts, {
      passed: 3,
      failed: 1,
      skipped: 1,
      na: 1,
      deselected: 0,
      selected: 6,
      total: 6,
    });
    assertEq(JSON.parse(lines[0]).run.scheduling, "tags");

    // The wasi surface came along too (polymorph consumers wire it).
    assertEq(typeof mod.wasi, "function");
    const shims = mod.wasi();
    assertEq(typeof shims["wasi:cli/environment@0.2"], "object");
  },
});
