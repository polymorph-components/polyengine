import { fromFileUrl, join } from "jsr:@std/path@1";
import { parseProtocol, protocolCompletionError } from "./run-lane.ts";

const sentinel = "@polyengine:";
const expectedFiles = ["one.json", "two.json"];

function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected output to include ${JSON.stringify(expected)}`);
  }
}

function protocol(...records: string[]): string {
  return records.map((record) => `${sentinel}${record}`).join("\n");
}

function completionError(output: string, exitCode = 0): string | null {
  return protocolCompletionError(
    parseProtocol(output),
    expectedFiles,
    exitCode,
  );
}

Deno.test("protocol rejects duplicate and missing files despite matching count", () => {
  const output = protocol(
    '{"kind":"header","fileCount":2}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"done"}',
  );
  assertEquals(
    completionError(output),
    "shell reported duplicate file(s): one.json",
  );
});

Deno.test("protocol rejects a header count that disagrees with the manifest", () => {
  const output = protocol(
    '{"kind":"header","fileCount":1}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"file","file":{"path":"two.json"}}',
    '{"kind":"done"}',
  );
  assertEquals(
    completionError(output),
    "shell header declared 1 files; manifest has 2",
  );
});

Deno.test("protocol rejects unknown and missing files despite matching count", () => {
  const output = protocol(
    '{"kind":"header","fileCount":2}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"file","file":{"path":"unknown.json"}}',
    '{"kind":"done"}',
  );
  assertEquals(
    completionError(output),
    "shell file set differed from manifest; missing: two.json; extra: unknown.json",
  );
});

Deno.test("protocol requires exactly one done record", () => {
  const base = [
    '{"kind":"header","fileCount":2}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"file","file":{"path":"two.json"}}',
  ];
  assertEquals(
    completionError(protocol(...base)),
    "shell emitted 0 done records (expected exactly 1)",
  );
  assertEquals(
    completionError(protocol(...base, '{"kind":"done"}', '{"kind":"done"}')),
    "shell emitted 2 done records (expected exactly 1)",
  );
});

Deno.test("protocol rejects malformed records and nonzero shell exit", () => {
  const complete = protocol(
    '{"kind":"header","fileCount":2}',
    '{"kind":"file","file":{"path":"one.json"}}',
    '{"kind":"file","file":{"path":"two.json"}}',
    '{"kind":"done"}',
  );
  assertEquals(
    completionError(`${complete}\n${sentinel}{"kind":"done"`, 0),
    "shell emitted 1 malformed protocol record(s)",
  );
  assertEquals(
    completionError(
      `${complete}\n${sentinel}{"kind":"file","file":`,
      7,
    ),
    "shell exited with code 7",
  );
  assertEquals(
    completionError(
      protocol(
        '{"kind":"header","fileCount":2}',
        '{"kind":"file","file":{"path":"one.json"}}',
        '{"kind":"file","file":{"path":"two.json"}}',
        '{"kind":"done","unexpected":true}',
      ),
    ),
    "shell emitted 1 malformed protocol record(s)",
  );
});

Deno.test("node host exits after complete output despite live background work", async () => {
  const here = fromFileUrl(new URL(".", import.meta.url));
  const repo = join(here, "..", "..");
  const pinnedNode = join(repo, ".shell-cache", "node-pinned", "bin", "node");
  let node = pinnedNode;
  try {
    await Deno.stat(pinnedNode);
  } catch {
    node = "node";
  }
  const fixture =
    new URL("./tests/background-complete.mjs", import.meta.url).href;
  const child = new Deno.Command(node, {
    args: [join(here, "host-node.mjs"), fixture],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const timed = await Promise.race([
    child.output(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("node host did not exit after done")),
        5_000,
      )
    ),
  ]);
  assertEquals(timed.code, 0);
  const stdout = new TextDecoder().decode(timed.stdout);
  assertStringIncludes(stdout, `${sentinel}{"kind":"done"}\n`);
  assertEquals(
    protocolCompletionError(
      parseProtocol(stdout),
      ["background.json"],
      timed.code,
    ),
    null,
  );
});
