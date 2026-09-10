// CLI-level e2e: main.ts as a consumer runs it — a subprocess, with the
// translator named EXPLICITLY (`--translator` / POLYENGINE_TRANSLATOR) rather
// than found in the checkout. This is the remote-consumption contract
// (docs/consumers.md; polymorph-test's `deltic` lane — still spelled with
// this project's former name, since the consumers migrate on their own
// schedule — pins a release tag and passes the release's translator asset),
// so the repo-relative fallback must never be the only path that works.

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import { haveFixture, TEST_SUITE_WASM } from "./support.ts";

const root = new URL("../../", import.meta.url);
const MAIN = new URL("../src/main.ts", import.meta.url).pathname;
const TRANSLATOR = new URL(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
  root,
).pathname;
const SUITE = new URL(TEST_SUITE_WASM, root).pathname;

const ready = await haveFixture(TEST_SUITE_WASM);

interface CliRun {
  code: number;
  stderr: string;
  lines: string[] | null;
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<CliRun> {
  const out = await Deno.makeTempFile({ suffix: ".jsonl" });
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", MAIN, SUITE, "--out", out, ...args],
      env,
      stdout: "inherit",
      stderr: "piped",
    });
    const res = await cmd.output();
    let lines: string[] | null = null;
    try {
      const text = await Deno.readTextFile(out);
      // makeTempFile pre-creates the (empty) file; an early CLI exit leaves
      // it empty, which callers treat the same as absent.
      lines = text === "" ? null : text.trimEnd().split("\n");
    } catch {
      // CLI exited before writing — callers assert on code/stderr.
    }
    return {
      code: res.code,
      stderr: new TextDecoder().decode(res.stderr),
      lines,
    };
  } finally {
    await Deno.remove(out).catch(() => {});
  }
}

Deno.test({
  name: "cli: --translator <path> runs the suite (no checkout fallback used)",
  ignore: !ready,
  fn: async () => {
    const { code, lines } = await runCli(["--translator", TRANSLATOR]);
    // The fixture suite contains a deliberately failing case, so the CLI's
    // contract is exit 1 (same discipline as polymorph-test's verify legs).
    assertEq(code, 1);
    assertEq(lines !== null, true);
    assertEq(lines!.length, 1 + 6 + 1); // envelope + 6 cases + terminator
    const envelope = JSON.parse(lines![0]);
    assertEq(envelope.target, "polyengine/host");
  },
});

Deno.test({
  name: "cli: POLYENGINE_TRANSLATOR env is honored",
  ignore: !ready,
  fn: async () => {
    const { code, lines } = await runCli([], {
      POLYENGINE_TRANSLATOR: TRANSLATOR,
    });
    assertEq(code, 1);
    assertEq(lines!.length, 1 + 6 + 1);
  },
});

Deno.test({
  name: "cli: unreadable --translator fails loud, names the flag",
  ignore: !ready,
  fn: async () => {
    const { code, stderr, lines } = await runCli([
      "--translator",
      "/nonexistent/translator_shim.wasm",
    ]);
    assertEq(code, 1);
    assertEq(lines, null);
    assertEq(stderr.includes("--translator"), true);
    assertEq(stderr.includes("/nonexistent/translator_shim.wasm"), true);
  },
});
