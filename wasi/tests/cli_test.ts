// wasi:cli@0.2 — stdout/stderr capture, exit recording (contracts/
// embedder-api.md §"WASI examination": "stdout capture, exit
// recording").

import { assertEq, assertThrows, assertTrue } from "./asserts.ts";
import { ComponentException } from "@polyengine/protocol";
import { cli, ExitError } from "../src/cli.ts";
import type { StreamErrorValue } from "../src/io.ts";

Deno.test("cli: stdout capture accumulates writes and decodes as text", () => {
  const { imports, captured } = cli();
  const stdoutIface = imports["wasi:cli/stdout@0.2"] as {
    getStdout(): { write(c: Uint8Array): void };
  };
  const stdout = stdoutIface.getStdout();
  stdout.write(new TextEncoder().encode("hello "));
  stdout.write(new TextEncoder().encode("world"));
  assertEq(captured.stdoutText(), "hello world");
  assertEq(captured.stderrText(), "");
});

Deno.test("cli: stderr capture is independent of stdout", () => {
  const { imports, captured } = cli();
  const stderrIface = imports["wasi:cli/stderr@0.2"] as {
    getStderr(): { write(c: Uint8Array): void };
  };
  stderrIface.getStderr().write(new TextEncoder().encode("oops"));
  assertEq(captured.stderrText(), "oops");
  assertEq(captured.stdoutText(), "");
});

Deno.test("cli: exit() records status without throwing by default", () => {
  const { imports, captured } = cli();
  const exitIface = imports["wasi:cli/exit@0.2"] as {
    exit(status: { kind: "ok" | "err" }): void;
  };
  assertEq(captured.exited(), false);
  exitIface.exit({ kind: "ok" });
  assertEq(captured.exited(), true);
  assertEq(captured.exitOk(), true);
});

Deno.test("cli: exit() with throwOnExit throws a named ExitError", () => {
  const { imports } = cli({ throwOnExit: true });
  const exitIface = imports["wasi:cli/exit@0.2"] as {
    exit(status: { kind: "ok" | "err" }): void;
  };
  const e = assertThrows(() => exitIface.exit({ kind: "err" }));
  assertTrue(e instanceof ExitError, "throw is an ExitError");
  assertEq((e as ExitError).ok, false);
});

Deno.test("cli: get-environment / get-arguments / initial-cwd from options", () => {
  const { imports } = cli({
    env: { FOO: "bar" },
    args: ["a", "b"],
    cwd: "/work",
  });
  const env = imports["wasi:cli/environment@0.2"] as {
    getEnvironment(): [string, string][];
    getArguments(): string[];
    initialCwd(): string | undefined;
  };
  assertEq(JSON.stringify(env.getEnvironment()), JSON.stringify([["FOO", "bar"]]));
  assertEq(JSON.stringify(env.getArguments()), JSON.stringify(["a", "b"]));
  assertEq(env.initialCwd(), "/work");
});

Deno.test("cli: get-environment / get-arguments default to empty", () => {
  const { imports } = cli();
  const env = imports["wasi:cli/environment@0.2"] as {
    getEnvironment(): [string, string][];
    getArguments(): string[];
    initialCwd(): string | undefined;
  };
  assertEq(env.getEnvironment().length, 0);
  assertEq(env.getArguments().length, 0);
  assertEq(env.initialCwd(), undefined);
});

// Issue #178: the default empty-buffer stdin must report `closed` on the
// first nonzero-len read, not an empty list forever — otherwise a p2
// guest's read-until-closed loop livelocks.
Deno.test("cli: stdin is closed at EOF by default (issue #178 livelock)", () => {
  const { imports } = cli();
  const stdin = imports["wasi:cli/stdin@0.2"] as {
    getStdin(): { read(len: bigint): Uint8Array };
  };
  const s = stdin.getStdin();
  const e = assertThrows(() => s.read(10n));
  assertTrue(e instanceof ComponentException);
  assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
});

Deno.test("cli: no terminal is ever attached (option collapses to undefined)", () => {
  const { imports } = cli();
  const stdinTerm = imports["wasi:cli/terminal-stdin@0.2"] as {
    getTerminalStdin(): unknown;
  };
  assertEq(stdinTerm.getTerminalStdin(), undefined);
});

// --- the @0.3 track (capture impl) ---------------------------------------------

Deno.test("cli@0.3: write-via-stream captures; read-via-stream serves the buffer", async () => {
  const { imports, captured } = cli({ stdinBuffer: new TextEncoder().encode("in") });
  const stdout = imports["wasi:cli/stdout@0.3"] as {
    writeViaStream(data: AsyncIterable<Uint8Array>): Promise<{ kind: string }>;
  };
  const wrote = await stdout.writeViaStream((async function* () {
    yield new TextEncoder().encode("captured ");
    yield new TextEncoder().encode("output");
  })());
  assertEq(wrote.kind, "ok");
  assertEq(captured.stdoutText(), "captured output");

  const stdin = imports["wasi:cli/stdin@0.3"] as {
    readViaStream(): [Iterable<Uint8Array>, Promise<{ kind: string }>];
  };
  const [rx, done] = stdin.readViaStream();
  const got: number[] = [];
  for (const chunk of rx) got.push(...chunk);
  assertEq(new TextDecoder().decode(Uint8Array.from(got)), "in");
  assertEq((await done).kind, "ok");
});

Deno.test("cli@0.3: exit-with-code records; get-initial-cwd is the renamed leaf", () => {
  const { imports, captured } = cli({ cwd: "/w" });
  const exit = imports["wasi:cli/exit@0.3"] as { exitWithCode(code: number): void };
  exit.exitWithCode(7);
  assertEq(captured.exited(), true);
  assertEq(captured.exitOk(), false);
  assertEq(captured.exitCode(), 7);
  const env = imports["wasi:cli/environment@0.3"] as { getInitialCwd(): string | undefined };
  assertEq(env.getInitialCwd(), "/w");
});
