// This runtime copy's identity (contracts/embedder-api.md §"Module identity
// and @polyengine/protocol", amendment A9; issue #83).
//
// One module owns the copy's URL so every diagnostic composes the same
// message, and so lowering sites deep in the value adapters can name the copy
// without threading it through their signatures.
//
// `import.meta.url` is the identity: it is what distinguishes the source
// checkout from a bundled `polyengine-embedder.mjs`, and two bundles from each
// other. It is stable per module instance and needs no permissions (unlike
// reading deno.json, which embedder paths must never do — no fs perms).

import { copyCensus } from "@polyengine/protocol";

/**
 * The URL of this copy of the runtime. Identity of the copy.
 * @internal — copy-identity constant for the A9 multi-copy diagnostics; not
 * host-facing.
 */
export const COPY_URL: string = import.meta.url;

/**
 * The `@polyengine/runtime` version this copy was built from, recorded in the copy
 * registry alongside the URL.
 *
 * Hardcoded on purpose: embedder code paths run without filesystem
 * permissions (and a browser bundle has no filesystem at all), so reading
 * `runtime/deno.json` at runtime is not an option.
 *
 * INVARIANT: keep in sync with `version` in runtime/deno.json — pinned by
 * runtime/tests/embedder/cross_copy_test.ts.
 * @internal — copy-identity constant for the A9 multi-copy diagnostics; not
 * host-facing.
 */
export const RUNTIME_VERSION = "0.4.0";

/**
 * Compose a cross-copy diagnostic: what was foreign, which copy is speaking,
 * the census of every copy in the graph, and the by-value remediation.
 *
 * Kept to one line but complete — the whole point of A9's stateful half is
 * that "recognized but foreign" is a NAMED failure, never a silent
 * adaptation (a foreign `Stream` pumped as an async iterable) and never a
 * misleading generic ("handle is not an error-context").
 */
export function describeCrossCopy(what: string, remedy?: string): string {
  const census = copyCensus();
  return `${what} was minted by a DIFFERENT polyengine runtime copy and cannot ` +
    `be used through this one (this copy: ${COPY_URL}${
      census === "" ? "" : `; ${census}`
    }). Handles are stateful — their machinery lives in the copy that minted ` +
    `them (contracts/embedder-api.md amendment A9, issue #83)` +
    `${remedy === undefined ? "" : `. ${remedy}`}`;
}
