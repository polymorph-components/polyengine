// End-to-end pin for the build-time translation path (contracts/embedder-api.md
// §"Module wiring and instantiation"):
// the CLI translates a fixture component to an envelope file, and a "deploy
// host" that never sees the translator reconstitutes artifacts from the
// envelope and runs the component. Also pins the loud-failure pairing check
// (envelope of component A + bytes of component B must refuse).

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import {
  artifactsFromEnvelope,
  instantiate,
} from "../../runtime/src/embedder/mod.ts";

const here = new URL(".", import.meta.url);
const repo = new URL("../../", import.meta.url);

async function exists(url: URL): Promise<boolean> {
  try {
    await Deno.stat(url);
    return true;
  } catch {
    return false;
  }
}

const shim = new URL(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  repo,
);
const imports = new URL("crates/translator-shim/testdata/imports.wasm", repo);
const hello = new URL(
  "crates/translator-shim/testdata/trivial.wasm",
  repo,
);
const ready = (await exists(shim)) && (await exists(imports));

async function runCli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write=/tmp",
      new URL("main.ts", here).pathname,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const dec = new TextDecoder();
  return {
    code: out.code,
    stdout: dec.decode(out.stdout),
    stderr: dec.decode(out.stderr),
  };
}

Deno.test({
  name: "translate CLI: envelope out, deploy host instantiates without a translator",
  ignore: !ready,
  fn: async () => {
    const out = `/tmp/polyengine-translate-test-${crypto.randomUUID()}.plan.json`;
    try {
      const res = await runCli([imports.pathname, "-o", out]);
      assertEq(res.code, 0, `cli failed: ${res.stderr}`);

      // The deploy host: envelope + component bytes only.
      const envelope = await Deno.readTextFile(out);
      const componentBytes = await Deno.readFile(imports);
      const logged: number[] = [];
      const c = await instantiate(
        artifactsFromEnvelope(envelope, componentBytes),
        {
          log: (x: number) => void logged.push(x),
          "host:api/math": {
            add: (a: number, b: number) => a + b,
            greet: (who: string) => `hello ${who}`,
          },
        },
      );
      assertEq(await c.exports.run(2, 40), 42);
      assertEq(logged, [42]);
    } finally {
      await Deno.remove(out).catch(() => {});
    }
  },
});

Deno.test({
  name: "translate CLI: a mismatched envelope/component pair refuses at instantiation",
  ignore: !ready || !(await exists(hello)),
  fn: async () => {
    const out = `/tmp/polyengine-translate-test-${crypto.randomUUID()}.plan.json`;
    try {
      const res = await runCli([imports.pathname, "-o", out]);
      assertEq(res.code, 0, `cli failed: ${res.stderr}`);
      const envelope = await Deno.readTextFile(out);
      // Wrong component bytes for this envelope: the embedded sha-256 (and
      // length) must refuse the pair loudly.
      const wrong = await Deno.readFile(hello);
      let raised: unknown;
      try {
        await instantiate(artifactsFromEnvelope(envelope, wrong), {});
      } catch (e) {
        raised = e;
      }
      assertEq(raised !== undefined, true, "expected a pairing failure");
    } finally {
      await Deno.remove(out).catch(() => {});
    }
  },
});
