// INTERNAL shared vocabulary of the `wasi:cli` impls (cli.ts capture,
// cli_stdio.ts host-stdio) — not a package export; the public home of
// these names is `@polyengine/wasi/cli`. Extracting them here is what keeps
// the two IMPLS independent of each other: an impl imports the
// vocabulary, never its sibling.

import { defineBrand, WASI_EXIT } from "@polyengine/protocol";
import type { Stream } from "@polyengine/protocol";

/** `wasi:cli/types@0.3`'s `error-code` ENUM: bare kebab-case strings (the
 * A10 value table — enums are data strings, not `{kind}` variants; this
 * type carried a `{kind}` wrapper until 2026-08-14, a latent bug no err
 * path had exercised). */
export type CliErrorCode = "io" | "illegal-byte-sequence" | "pipe";

/** `result<_, error-code>` AS A VALUE (the 0.3 stdio futures). */
export type CliIoResult = { kind: "ok" } | { kind: "err"; value: CliErrorCode };

/** What 0.3 write-via-stream accepts: the lifted handle or any byte producer. */
export type CliByteSource =
  | Stream<number>
  | AsyncIterable<Uint8Array | number[]>
  | Iterable<Uint8Array | number[]>;

/** Raised by `exit()` when `throwOnExit` is set (contract: "option to throw a named ExitError"). */
export class ExitError extends Error {
  constructor(readonly ok: boolean, readonly code?: number) {
    super(
      `wasi:cli/exit#exit(${ok ? "success" : "failure"}${code === undefined ? "" : `, code ${code}`})`,
    );
    this.name = "ExitError";
  }
}
// A9 brand: an exit unwind propagates out through the embedder and any host
// frames in between, so it must be recognizable across runtime copies
// (contracts/embedder-api.md §"Module identity", issue #83).
defineBrand(ExitError.prototype, WASI_EXIT);

/** `terminal-input`/`terminal-output` are opaque resources; never produced (no terminal). */
export class TerminalInput {}
export class TerminalOutput {}
