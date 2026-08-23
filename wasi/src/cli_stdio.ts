// `@polyengine/wasi/cli-stdio` — the HOST-STDIO impl of `wasi:cli` (both the
// `@0.2` and `@0.3` tracks), à la carte: it grants access to the host
// process's stdin/stdout/stderr, environment, and arguments, so it never
// rides the default `wasi()` merge (which carries the capture impl,
// cli.ts). Compose it over the batteries:
//
//   instantiate(a, { ...wasi(), ...cliStdio().imports })
//
// Defaults come from `globalThis.process` (real Node, and Deno through
// its stable node compat — the same node-builtins-everywhere stance as
// sockets_platform.ts); every source and sink is injectable for
// virtualization and tests. On a host with no `process` and no
// injection, construction fails loudly — the capture impl is the honest
// browser answer.
//
// THE JSPI DEPENDENCE (the reason this impl exists as its own fragment):
// p2's `blocking-read` / `blocking-write-and-flush` / `blocking-flush`
// are SYNC WIT functions. Against capture buffers they degenerate to
// their non-blocking forms (io.ts base classes, sync fast path); against
// a REAL stdin/stdout they must genuinely wait, which parks the calling
// wasm frame through the suspending kernel (embedder-api A1/A2/A14 —
// io.ts marks the blocking declarations on the REGISTERED stream
// prototypes; these duck-typed stream impls override the behavior, and
// per A2 the mark relays). Consequences: guests linking the blocking
// leaves auto-select jspi mode on V8 engines, and on engines without
// JSPI a genuine wait raises a clean `NeedsJspi` at the park site. The
// `@0.3` track has no such dependence — its stdio is stream-shaped and
// async by construction (`read-via-stream` returns the tcp-receive
// tuple; `write-via-stream`'s promise is the future source, A12).
//
// Semantics:
//
//   * p2 stdin: reads serve synchronously from an internal buffer fed by
//     the source; `read` on an empty open stream returns an empty list
//     (p2's non-blocking contract), `blocking-read` parks until bytes or
//     EOF, and EOF-with-drained-buffer is the `closed` stream-error. The
//     feed pauses past a high-water mark (no unbounded buffering).
//   * p2 stdout/stderr: writes enqueue against a byte BUDGET
//     (`check-write` reports the remaining permit; exceeding it is the
//     guest's contract violation and traps via unbranded throw);
//     `blocking-flush`/`blocking-write-and-flush` park until the sink
//     drained everything; `subscribe` wakes when budget frees.
//   * exit: throws the branded `ExitError` (the embedder decides what
//     process-level exit means; `exitProcess: true` opts into a REAL
//     `process.exit`). `exit-with-code` (0.3) records the code on the
//     error.
//   * terminals: reported from the real streams' `isTTY` (injectable).
//   * environment/arguments/cwd: the host process's, overridable.

import { isStream } from "@polyengine/protocol";
import {
  type CliByteSource,
  type CliErrorCode,
  type CliIoResult,
  ExitError,
  TerminalInput,
  TerminalOutput,
} from "./internal/cli_shared.ts";
import { type ByteSink, FedInputStream, SinkOutputStream } from "./io.ts";

const OK: CliIoResult = { kind: "ok" };

function ioErrorCode(e: unknown): CliErrorCode {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return m.includes("epipe") || m.includes("broken pipe") ? "pipe" : "io";
}

export { type ByteSink } from "./io.ts";

export interface CliStdioOptions {
  /** stdin bytes; default: the host process's stdin. */
  stdin?: AsyncIterable<Uint8Array>;
  /** stdout sink; default: the host process's stdout. */
  stdout?: ByteSink;
  /** stderr sink; default: the host process's stderr. */
  stderr?: ByteSink;
  /** Terminal-ness per stream; default: the real streams' `isTTY`. */
  isTty?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
  /** `get-arguments`; default: the host process's argv (script-relative). */
  args?: string[];
  /** `get-environment`; default: the host process's env. */
  env?: Record<string, string>;
  /** `initial-cwd`/`get-initial-cwd`; default: the host process's cwd. */
  cwd?: string;
  /** `exit` terminates the host process instead of throwing `ExitError`. */
  exitProcess?: boolean;
}

export interface CliStdio {
  imports: Record<string, unknown>;
}

// --- the host-process defaults (structural; node-builtins-everywhere) ---------

interface NodeProcessStream {
  isTTY?: boolean;
  write(chunk: Uint8Array, cb: (err?: Error | null) => void): boolean;
  once(event: string, listener: () => void): unknown;
}

interface NodeProcess {
  stdin?: AsyncIterable<Uint8Array> & { isTTY?: boolean };
  stdout?: NodeProcessStream;
  stderr?: NodeProcessStream;
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  exit?: (code: number) => never;
}

function hostProcess(): NodeProcess | undefined {
  const proc = (globalThis as { process?: unknown }).process;
  return typeof proc === "object" && proc !== null ? (proc as NodeProcess) : undefined;
}

function processSink(stream: NodeProcessStream): ByteSink {
  return (chunk) =>
    new Promise<void>((resolve, reject) => {
      const flushed = stream.write(chunk, (err) => {
        if (err !== null && err !== undefined) reject(err);
      });
      if (flushed) resolve();
      else stream.once("drain", resolve);
    });
}

/**
 * `wasi:cli` over the host process's stdio (both tracks — module header).
 */
export function cliStdio(options: CliStdioOptions = {}): CliStdio {
  const proc = hostProcess();
  const stdinSource = options.stdin ?? proc?.stdin;
  const stdoutSink = options.stdout ??
    (proc?.stdout === undefined ? undefined : processSink(proc.stdout));
  const stderrSink = options.stderr ??
    (proc?.stderr === undefined ? undefined : processSink(proc.stderr));
  if (stdinSource === undefined || stdoutSink === undefined || stderrSink === undefined) {
    throw new TypeError(
      "cliStdio: no host process stdio and no injected replacement — " +
        "on hosts without `process` (browsers), inject sources/sinks or " +
        "use the capture impl (cli.ts)",
    );
  }
  const tty = {
    stdin: options.isTty?.stdin ?? (proc?.stdin as { isTTY?: boolean } | undefined)?.isTTY ?? false,
    stdout: options.isTty?.stdout ?? proc?.stdout?.isTTY ?? false,
    stderr: options.isTty?.stderr ?? proc?.stderr?.isTTY ?? false,
  };
  const env = (): [string, string][] => {
    if (options.env !== undefined) return Object.entries(options.env);
    const e = proc?.env ?? {};
    return Object.entries(e).filter((kv): kv is [string, string] => kv[1] !== undefined);
  };
  const args = (): string[] => options.args ?? proc?.argv?.slice(2) ?? [];
  const cwd = (): string | undefined => options.cwd ?? proc?.cwd?.();

  const doExit = (ok: boolean, code?: number): never => {
    if (options.exitProcess && proc?.exit !== undefined) {
      proc.exit(code ?? (ok ? 0 : 1));
    }
    throw new ExitError(ok, code);
  };

  // One p2 stream per stdio channel, shared across get-* calls (the
  // process's stdio is one resource, not one per call).
  let p2Stdin: FedInputStream | undefined;
  const p2Stdout = new SinkOutputStream(stdoutSink);
  const p2Stderr = new SinkOutputStream(stderrSink);

  // 0.3 write-via-stream: drain the guest's stream to the sink; the
  // promise is the future source (A12).
  const writeViaStream = (sink: ByteSink) => async (data: CliByteSource): Promise<CliIoResult> => {
    try {
      for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
        await sink(chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk));
      }
      return OK;
    } catch (e) {
      if (isStream(data)) data.drop(); // the guest's writer must not hang
      return { kind: "err", value: ioErrorCode(e) };
    }
  };

  // 0.3 read-via-stream: the tcp-receive tuple over the shared source.
  const readViaStream = (): [AsyncIterable<Uint8Array>, Promise<CliIoResult>] => {
    let settle!: (r: CliIoResult) => void;
    const done = new Promise<CliIoResult>((r) => (settle = r));
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of stdinSource) {
          if (chunk.length > 0) yield chunk;
        }
        settle(OK);
      } catch (e) {
        settle({ kind: "err", value: ioErrorCode(e) });
      } finally {
        settle(OK); // reader dropped: the canceller observes (no-op if settled)
      }
    })();
    return [source, done];
  };

  const environment = {
    getEnvironment: env,
    getArguments: args,
  };

  const imports: Record<string, unknown> = {
    // ---- @0.2 -----------------------------------------------------------------
    "wasi:cli/environment@0.2": { ...environment, initialCwd: cwd },
    "wasi:cli/exit@0.2": {
      exit: (status: { kind: "ok" | "err" }): void => {
        doExit(status.kind === "ok");
      },
    },
    "wasi:cli/stdin@0.2": {
      getStdin: (): FedInputStream => (p2Stdin ??= new FedInputStream(stdinSource)),
    },
    "wasi:cli/stdout@0.2": { getStdout: (): SinkOutputStream => p2Stdout },
    "wasi:cli/stderr@0.2": { getStderr: (): SinkOutputStream => p2Stderr },
    "wasi:cli/terminal-input@0.2": { TerminalInput },
    "wasi:cli/terminal-output@0.2": { TerminalOutput },
    "wasi:cli/terminal-stdin@0.2": {
      getTerminalStdin: (): TerminalInput | undefined =>
        tty.stdin ? new TerminalInput() : undefined,
    },
    "wasi:cli/terminal-stdout@0.2": {
      getTerminalStdout: (): TerminalOutput | undefined =>
        tty.stdout ? new TerminalOutput() : undefined,
    },
    "wasi:cli/terminal-stderr@0.2": {
      getTerminalStderr: (): TerminalOutput | undefined =>
        tty.stderr ? new TerminalOutput() : undefined,
    },

    // ---- @0.3 -----------------------------------------------------------------
    "wasi:cli/types@0.3": {},
    "wasi:cli/environment@0.3": { ...environment, getInitialCwd: cwd },
    "wasi:cli/exit@0.3": {
      exit: (status: { kind: "ok" | "err" }): void => {
        doExit(status.kind === "ok");
      },
      exitWithCode: (statusCode: number): void => {
        doExit(statusCode === 0, statusCode);
      },
    },
    "wasi:cli/stdin@0.3": { readViaStream },
    "wasi:cli/stdout@0.3": { writeViaStream: writeViaStream(stdoutSink) },
    "wasi:cli/stderr@0.3": { writeViaStream: writeViaStream(stderrSink) },
    "wasi:cli/terminal-input@0.3": { TerminalInput },
    "wasi:cli/terminal-output@0.3": { TerminalOutput },
    "wasi:cli/terminal-stdin@0.3": {
      getTerminalStdin: (): TerminalInput | undefined =>
        tty.stdin ? new TerminalInput() : undefined,
    },
    "wasi:cli/terminal-stdout@0.3": {
      getTerminalStdout: (): TerminalOutput | undefined =>
        tty.stdout ? new TerminalOutput() : undefined,
    },
    "wasi:cli/terminal-stderr@0.3": {
      getTerminalStderr: (): TerminalOutput | undefined =>
        tty.stderr ? new TerminalOutput() : undefined,
    },
  };

  return { imports };
}
