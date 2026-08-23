// Unit tests for the host-stdio `wasi:cli` impl (src/cli_stdio.ts): the
// p2 fed-stdin / budgeted-stdout streams (THE parking customers — their
// blocking ops return Promises that the suspending kernel turns into
// frame parks), the 0.3 stream-shaped stdio, and the mark relay this all
// rides on (A14: the blocking declarations are marked on io.ts's
// REGISTERED prototypes; these duck-typed impls override behavior only).

import { ComponentException, isSuspending } from "@polyengine/protocol";
import { cliStdio } from "../src/cli_stdio.ts";
import { type CliIoResult, ExitError } from "../src/cli.ts";
import {
  FedInputStream,
  InputStream,
  OutputStream,
  SinkOutputStream,
  STREAM_HIGH_WATER,
} from "../src/io.ts";
import type { StreamErrorValue } from "../src/io.ts";
import { cli } from "../src/cli.ts";
import { assertEq, assertThrows, assertTrue } from "./asserts.ts";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A manually-driven stdin source. */
function feeder(): {
  source: AsyncIterable<Uint8Array>;
  feed: (b: Uint8Array) => void;
  end: () => void;
} {
  const queue: Uint8Array[] = [];
  let done = false;
  let wake = (): void => {};
  return {
    source: (async function* () {
      for (;;) {
        while (queue.length === 0 && !done) {
          await new Promise<void>((r) => (wake = r));
        }
        if (queue.length > 0) yield queue.shift()!;
        else return;
      }
    })(),
    feed: (b) => {
      queue.push(b);
      wake();
    },
    end: () => {
      done = true;
      wake();
    },
  };
}

// --- the A14 premise -------------------------------------------------------------

Deno.test("cli-stdio: the registered io prototypes carry the A14 marks (the relay premise)", () => {
  // The runtime reads suspendability from the REGISTERED class's
  // prototype at wrap time (A2); cli-stdio's parking streams only work
  // because io.ts marks these declarations.
  for (
    const [proto, member] of [
      [InputStream.prototype, "blockingRead"],
      [InputStream.prototype, "blockingSkip"],
      [OutputStream.prototype, "blockingWriteAndFlush"],
      [OutputStream.prototype, "blockingFlush"],
      [OutputStream.prototype, "blockingWriteZeroesAndFlush"],
      [OutputStream.prototype, "blockingSplice"],
    ] as const
  ) {
    assertTrue(
      isSuspending((proto as unknown as Record<string, unknown>)[member]),
      `${member} is marked park-capable`,
    );
  }
  // The buffer-backed bases keep their sync fast path: no Promise returns.
  assertTrue(!(new InputStream(text("x")).blockingRead(8n) instanceof Promise), "base is sync");
});

// Issue #178: `cli()`'s capture-stdin path (src/cli.ts:150) backs
// `wasi:cli/stdin@0.2` with the buffer-backed InputStream, not
// FedInputStream — a guest reading that stdin until closed must see the
// buffer drain and then `closed`, or it livelocks (the bug this issue
// tracks). Mirrors the FedInputStream drained-ended-is-closed case above,
// but against the actual capture-stdin wiring a guest would hit.
Deno.test("cli-stdio stdin (capture-stdin buffer): guest-visible stream reaches closed after the buffer drains (issue #178 livelock)", () => {
  const { imports } = cli({ stdinBuffer: text("hi") });
  const stdinIface = imports["wasi:cli/stdin@0.2"] as {
    getStdin(): InputStream;
  };
  const stdin = stdinIface.getStdin();
  assertEq(utf8(stdin.read(16n)), "hi", "serves the configured buffer");
  const e = assertThrows(() => stdin.read(1n));
  assertTrue(e instanceof ComponentException, "drained capture-stdin buffer is branded closed");
  assertEq((e as ComponentException<StreamErrorValue>).payload.kind, "closed");
});

// --- p2 stdin ----------------------------------------------------------------------

Deno.test("cli-stdio stdin: sync reads never park; empty-open is empty, drained-ended is closed", async () => {
  const f = feeder();
  const stdin = new FedInputStream(f.source);
  await new Promise((r) => setTimeout(r, 0)); // let the feed start
  assertEq(stdin.read(16n).length, 0, "open + nothing available = empty list");
  f.feed(text("hello"));
  await new Promise((r) => setTimeout(r, 0));
  assertEq(utf8(stdin.read(3n)), "hel", "reads serve from the buffer");
  assertEq(utf8(stdin.read(16n)), "lo");
  f.end();
  await new Promise((r) => setTimeout(r, 0));
  const e = assertThrows(() => stdin.read(1n));
  assertTrue(e instanceof ComponentException, "drained + ended = branded closed");
  stdin[Symbol.dispose]();
});

Deno.test("cli-stdio stdin: blocking-read PARKS until fed (the jspi dependence)", async () => {
  const f = feeder();
  const stdin = new FedInputStream(f.source);
  await new Promise((r) => setTimeout(r, 0));
  const parked = stdin.blockingRead(16n);
  assertTrue(parked instanceof Promise, "nothing buffered: the call parks");
  f.feed(text("woken"));
  assertEq(utf8(await parked), "woken", "the park resolves with the fed bytes");
  // With bytes buffered, the sync fast path returns directly.
  f.feed(text("fast"));
  await new Promise((r) => setTimeout(r, 0));
  const fast = stdin.blockingRead(16n);
  assertTrue(fast instanceof Uint8Array, "buffered: sync fast path");
  f.end();
  stdin[Symbol.dispose]();
});

Deno.test("cli-stdio stdin: the subscribe pollable flips ready on feed and on EOF", async () => {
  const f = feeder();
  const stdin = new FedInputStream(f.source);
  await new Promise((r) => setTimeout(r, 0));
  const p = stdin.subscribe();
  assertEq(p.ready(), false, "nothing buffered");
  const wait = p.waitPromise();
  f.feed(text("x"));
  await wait;
  assertEq(p.ready(), true, "fed: ready");
  stdin.read(8n);
  assertEq(p.ready(), false, "drained: unready again");
  f.end();
  await new Promise((r) => setTimeout(r, 0));
  assertEq(p.ready(), true, "EOF: ready (the read will report closed)");
  stdin[Symbol.dispose]();
});

Deno.test("cli-stdio stdin: the feed pauses past the high-water mark (no unbounded buffering)", async () => {
  let pulled = 0;
  const endless: AsyncIterable<Uint8Array> = (async function* () {
    for (;;) {
      pulled++;
      yield new Uint8Array(STREAM_HIGH_WATER / 4);
    }
  })();
  const stdin = new FedInputStream(endless);
  await new Promise((r) => setTimeout(r, 10));
  const afterFill = pulled;
  assertTrue(afterFill <= 6, `the feed paused near the mark (pulled ${afterFill})`);
  await new Promise((r) => setTimeout(r, 10));
  assertEq(pulled, afterFill, "…and stays paused while nobody reads");
  stdin.read(BigInt(STREAM_HIGH_WATER)); // drain -> resume
  await new Promise((r) => setTimeout(r, 10));
  assertTrue(pulled > afterFill, "draining resumes the feed");
  stdin[Symbol.dispose]();
});

// --- p2 stdout -----------------------------------------------------------------------

Deno.test("cli-stdio stdout: budgeted writes; blocking-flush parks until the sink drains", async () => {
  const drained: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const out = new SinkOutputStream(async (chunk) => {
    await gate; // a slow sink
    drained.push(utf8(chunk));
  });
  assertEq(out.checkWrite(), BigInt(STREAM_HIGH_WATER));
  out.write(text("queued"));
  assertEq(out.checkWrite(), BigInt(STREAM_HIGH_WATER - 6), "the permit shrinks by queued bytes");
  const parked = out.blockingFlush();
  assertTrue(parked instanceof Promise, "undrained: the flush parks");
  const sub = out.subscribe();
  assertEq(sub.ready(), true, "budget still free: ready");
  release();
  await parked;
  assertEq(JSON.stringify(drained), JSON.stringify(["queued"]));
  assertEq(out.checkWrite(), BigInt(STREAM_HIGH_WATER), "drained: full permit back");
  out[Symbol.dispose]();
});

Deno.test("cli-stdio stdout: writing past the permit is a trap (unbranded), not a stream-error", () => {
  const out = new SinkOutputStream(() => {});
  const e = assertThrows(() => out.write(new Uint8Array(STREAM_HIGH_WATER + 1)));
  assertTrue(!(e instanceof ComponentException), "an unbranded throw = trap");
  out[Symbol.dispose]();
});

Deno.test("cli-stdio stdout: a failed sink surfaces as last-operation-failed with an io error resource", async () => {
  const out = new SinkOutputStream(() => {
    throw new Error("EPIPE: broken pipe");
  });
  out.write(text("x"));
  await new Promise((r) => setTimeout(r, 0));
  const e = assertThrows(() => out.checkWrite());
  assertTrue(e instanceof ComponentException, "branded stream-error");
  const payload = (e as ComponentException<{ kind: string; value?: { toDebugString(): string } }>)
    .payload;
  assertEq(payload.kind, "last-operation-failed");
  assertTrue(
    payload.value!.toDebugString().includes("EPIPE"),
    "the io error resource carries the cause",
  );
  out[Symbol.dispose]();
});

// --- the fragment ----------------------------------------------------------------------

Deno.test("cli-stdio fragment: both tracks; injected stdio round-trips through 0.3 shapes", async () => {
  const outChunks: Uint8Array[] = [];
  const f = feeder();
  const { imports } = cliStdio({
    stdin: f.source,
    stdout: (c) => {
      outChunks.push(c);
    },
    stderr: () => {},
    env: { A: "1" },
    args: ["x"],
    cwd: "/tmp",
    isTty: { stdout: true },
  });
  assertTrue("wasi:cli/stdin@0.2" in imports && "wasi:cli/stdin@0.3" in imports, "both tracks");

  // 0.3 stdout: the guest's stream drains to the sink; the promise is the
  // future source (A12).
  const stdout03 = imports["wasi:cli/stdout@0.3"] as {
    writeViaStream(data: AsyncIterable<Uint8Array>): Promise<CliIoResult>;
  };
  const wrote = await stdout03.writeViaStream((async function* () {
    yield text("via ");
    yield text("stream");
  })());
  assertEq(wrote.kind, "ok");
  assertEq(outChunks.map(utf8).join(""), "via stream");

  // 0.3 stdin: the tcp-receive tuple shape.
  const stdin03 = imports["wasi:cli/stdin@0.3"] as {
    readViaStream(): [AsyncIterable<Uint8Array>, Promise<CliIoResult>];
  };
  const [rx, done] = stdin03.readViaStream();
  f.feed(text("input"));
  f.end();
  const got: string[] = [];
  for await (const chunk of rx) got.push(utf8(chunk));
  assertEq(got.join(""), "input");
  assertEq((await done).kind, "ok");

  // environment + terminals reflect the injections.
  const env03 = imports["wasi:cli/environment@0.3"] as {
    getEnvironment(): [string, string][];
    getInitialCwd(): string | undefined;
  };
  assertEq(JSON.stringify(env03.getEnvironment()), JSON.stringify([["A", "1"]]));
  assertEq(env03.getInitialCwd(), "/tmp");
  const term = imports["wasi:cli/terminal-stdout@0.3"] as {
    getTerminalStdout(): unknown;
  };
  assertTrue(term.getTerminalStdout() !== undefined, "isTty.stdout reports a terminal");
  const termIn = imports["wasi:cli/terminal-stdin@0.3"] as {
    getTerminalStdin(): unknown;
  };
  assertEq(termIn.getTerminalStdin(), undefined, "stdin is not a terminal here");
});

Deno.test("cli-stdio exit: ExitError (branded unwind) with the 0.3 status code preserved", () => {
  const { imports } = cliStdio({
    stdin: (async function* () {})(),
    stdout: () => {},
    stderr: () => {},
  });
  const exit03 = imports["wasi:cli/exit@0.3"] as {
    exit(status: { kind: "ok" | "err" }): void;
    exitWithCode(code: number): void;
  };
  const e1 = assertThrows(() => exit03.exit({ kind: "ok" }));
  assertTrue(e1 instanceof ExitError && e1.ok, "exit(ok)");
  const e2 = assertThrows(() => exit03.exitWithCode(3));
  assertTrue(e2 instanceof ExitError && !(e2 as ExitError).ok, "nonzero = failure");
  assertEq((e2 as ExitError).code, 3, "the code rides the error");
});

Deno.test("cli-stdio defaults: the host process serves when nothing is injected", () => {
  // Under Deno, `globalThis.process` exists (node compat) — construction
  // must succeed and register both tracks without touching the streams.
  const { imports } = cliStdio();
  assertTrue("wasi:cli/stdout@0.2" in imports && "wasi:cli/stdout@0.3" in imports);
});
