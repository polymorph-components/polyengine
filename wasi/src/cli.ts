// `wasi:cli@0.2` + `wasi:cli@0.3` — environment, exit, stdin, stdout,
// stderr, terminal-* (contracts/embedder-api.md §"WASI examination"; 0.2
// leaf inventory mined from `iroh_exec_model_guest.wasm` /
// `engine-go/main.wasm`; 0.3 shapes from the WASI 0.3.1 release —
// WebAssembly/WASI v0.3.1, proposals/cli/wit). This is the CAPTURE impl
// (the batteries fragment `wasi()` merges): stdin from a caller-supplied
// buffer, stdout/stderr into capture buffers, exit recorded. The
// host-stdio impl is à la carte at `@polyengine/wasi/cli-stdio` (cli_stdio.ts
// — it grants terminal/process access, so it never rides the default).
//
// 0.3 reshapes stdio around streams: `stdin.read-via-stream: func() ->
// tuple<stream<u8>, future<result<_, error-code>>>` (the tcp-receive
// tuple shape) and `stdout/stderr.write-via-stream: func(data:
// stream<u8>) -> future<result<_, error-code>>` (the tcp-send shape:
// the async method's promise IS the future source, per embedder-api.md
// §"Streams and futures"); exit
// gains `exit-with-code: func(status-code: u8)`, and environment's cwd
// getter is renamed `get-initial-cwd` (0.2 spells it `initial-cwd`).

import { InputStream, OutputStream } from "./io.ts";
import {
  type CliByteSource,
  type CliIoResult,
  ExitError,
  TerminalInput,
  TerminalOutput,
} from "./internal/cli_shared.ts";

// The shared `wasi:cli` vocabulary lives in internal/cli_shared.ts (both
// impls consume it); THIS module is its public home.
export {
  type CliByteSource,
  type CliErrorCode,
  type CliIoResult,
  ExitError,
  TerminalInput,
  TerminalOutput,
} from "./internal/cli_shared.ts";

export interface CliOptions {
  /** `get-arguments`; default `[]`. */
  args?: string[];
  /** `get-environment`; default `{}`. */
  env?: Record<string, string>;
  /** `initial-cwd`; default `undefined` (none). */
  cwd?: string;
  /** `get-stdin`'s buffer contents; default empty (matches contract: "stdin (empty)"). */
  stdinBuffer?: Uint8Array;
  /** Also `console.log`/`console.error` captured stdout/stderr writes. Default false. */
  passthrough?: boolean;
  /** `exit()` throws `ExitError` instead of merely recording. Default false. */
  throwOnExit?: boolean;
}

/** Captured host-observable state exposed on the returned handle (contract wording). */
export interface CliCaptured {
  stdout(): Uint8Array;
  stderr(): Uint8Array;
  stdoutText(): string;
  stderrText(): string;
  /** Whether `wasi:cli/exit#exit` has been called. */
  exited(): boolean;
  /** The `result` kind of the last `exit()` call's `status`, or `undefined` if never called. */
  exitOk(): boolean | undefined;
  /** The last `exit-with-code` status (0.3), or `undefined` if never called. */
  exitCode(): number | undefined;
}

export interface CliResult {
  imports: Record<string, unknown>;
  captured: CliCaptured;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * `wasi:cli@0.2` provider fragment (track key).
 *
 * `exit`'s WIT signature is `exit: func(status: result)` — `result` with no
 * type parameters, i.e. `result<_, _>`. Per contracts/embedder-api.md's value
 * table, a `result` in **parameter** (non-return) position is plain nested
 * data: `{ kind: "ok" } | { kind: "err" }` (embedder-api.md §"Naming and
 * casing" — enum/variant case names are data, not `{tag}` wrappers),
 * never a throw. Only a
 * function's own *return*-position result throws/rejects.
 */
export function cli(options: CliOptions = {}): CliResult {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const passthrough = options.passthrough ?? false;
  let exited = false;
  let exitOk: boolean | undefined;
  let exitCode: number | undefined;

  const stdout = new OutputStream((chunk) => {
    stdoutChunks.push(chunk);
    if (passthrough) console.log(new TextDecoder().decode(chunk));
  });
  const stderr = new OutputStream((chunk) => {
    stderrChunks.push(chunk);
    if (passthrough) console.error(new TextDecoder().decode(chunk));
  });

  const captured: CliCaptured = {
    stdout: () => concat(stdoutChunks),
    stderr: () => concat(stderrChunks),
    stdoutText: () => new TextDecoder().decode(concat(stdoutChunks)),
    stderrText: () => new TextDecoder().decode(concat(stderrChunks)),
    exited: () => exited,
    exitOk: () => exitOk,
    exitCode: () => exitCode,
  };

  /** 0.3 write-via-stream into a capture buffer (the promise IS the future — embedder-api.md §"Streams and futures"). */
  const captureViaStream = (
    chunks: Uint8Array[],
    mirror: ((text: string) => void) | undefined,
  ) =>
  async (data: CliByteSource): Promise<CliIoResult> => {
    for await (const chunk of data as AsyncIterable<Uint8Array | number[]>) {
      const bytes = chunk instanceof Uint8Array ? chunk : Uint8Array.from(chunk);
      chunks.push(bytes);
      mirror?.(new TextDecoder().decode(bytes));
    }
    return { kind: "ok" };
  };

  const imports: Record<string, unknown> = {
    "wasi:cli/environment@0.2": {
      getEnvironment: (): [string, string][] => Object.entries(options.env ?? {}),
      getArguments: (): string[] => options.args ?? [],
      initialCwd: (): string | undefined => options.cwd,
    },
    "wasi:cli/exit@0.2": {
      exit: (status: { kind: "ok" | "err" }): void => {
        exited = true;
        exitOk = status.kind === "ok";
        if (options.throwOnExit) throw new ExitError(exitOk);
      },
    },
    "wasi:cli/stdin@0.2": {
      getStdin: (): InputStream => new InputStream(options.stdinBuffer),
    },
    "wasi:cli/stdout@0.2": { getStdout: (): OutputStream => stdout },
    "wasi:cli/stderr@0.2": { getStderr: (): OutputStream => stderr },
    "wasi:cli/terminal-input@0.2": { TerminalInput },
    "wasi:cli/terminal-output@0.2": { TerminalOutput },
    // No terminal is ever attached; `option<terminal-*>` collapses to the
    // outermost-option rule (contract §"Value mapping"): `undefined` = none.
    "wasi:cli/terminal-stdin@0.2": {
      getTerminalStdin: (): TerminalInput | undefined => undefined,
    },
    "wasi:cli/terminal-stdout@0.2": {
      getTerminalStdout: (): TerminalOutput | undefined => undefined,
    },
    "wasi:cli/terminal-stderr@0.2": {
      getTerminalStderr: (): TerminalOutput | undefined => undefined,
    },

    // ---- the @0.3 track (WASI 0.3.1 shapes; module header) -------------------
    "wasi:cli/types@0.3": {},
    "wasi:cli/environment@0.3": {
      getEnvironment: (): [string, string][] => Object.entries(options.env ?? {}),
      getArguments: (): string[] => options.args ?? [],
      getInitialCwd: (): string | undefined => options.cwd,
    },
    "wasi:cli/exit@0.3": {
      exit: (status: { kind: "ok" | "err" }): void => {
        exited = true;
        exitOk = status.kind === "ok";
        if (options.throwOnExit) throw new ExitError(exitOk);
      },
      exitWithCode: (statusCode: number): void => {
        exited = true;
        exitOk = statusCode === 0;
        exitCode = statusCode;
        if (options.throwOnExit) throw new ExitError(exitOk);
      },
    },
    "wasi:cli/stdin@0.3": {
      // The tcp-receive tuple shape: [stream, completion future]. A
      // buffered stdin always delivers cleanly.
      readViaStream: (): [Iterable<Uint8Array>, Promise<CliIoResult>] => [
        options.stdinBuffer === undefined ? [] : [options.stdinBuffer],
        Promise.resolve({ kind: "ok" }),
      ],
    },
    "wasi:cli/stdout@0.3": {
      writeViaStream: captureViaStream(
        stdoutChunks,
        passthrough ? (t) => console.log(t) : undefined,
      ),
    },
    "wasi:cli/stderr@0.3": {
      writeViaStream: captureViaStream(
        stderrChunks,
        passthrough ? (t) => console.error(t) : undefined,
      ),
    },
    "wasi:cli/terminal-input@0.3": { TerminalInput },
    "wasi:cli/terminal-output@0.3": { TerminalOutput },
    "wasi:cli/terminal-stdin@0.3": {
      getTerminalStdin: (): TerminalInput | undefined => undefined,
    },
    "wasi:cli/terminal-stdout@0.3": {
      getTerminalStdout: (): TerminalOutput | undefined => undefined,
    },
    "wasi:cli/terminal-stderr@0.3": {
      getTerminalStderr: (): TerminalOutput | undefined => undefined,
    },
  };

  return { imports, captured };
}
