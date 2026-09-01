// The runtime-copy registry (contracts/embedder-api.md §"Module identity and
// @polyengine/protocol"; issue #83).
//
// Each embedder module instance appends itself here when it is evaluated. The
// array lives on `globalThis` under the registry symbol `polyengine.runtimeCopies/1`,
// so copies that share no modules still share the census — that is the point.
//
// Multiple copies are DIAGNOSED, NEVER REFUSED: two isolated bundles on one
// page that exchange no values are legal (and cross-copy value exchange is
// legal for the stateless brands regardless of copy identity). The registry exists so
// that the failures which remain — foreign stateful handles, unbranded throws
// from an unregistered copy — name the copies instead of leaving a latent puzzle.

import { RUNTIME_COPIES } from "./brands.ts";

/** One registered runtime copy. Frozen on registration. */
export interface RuntimeCopy {
  /** The registering module's `import.meta.url`. Identity of the copy. */
  readonly url: string;
  /** The `@polyengine/runtime` version that copy was built from. */
  readonly runtimeVersion: string;
  /** The brand generation that copy speaks (`PROTOCOL_GENERATION`). */
  readonly protocolGeneration: number;
}

type Slot = { [RUNTIME_COPIES]?: RuntimeCopy[] };

/**
 * The shared array, created on first use. A pre-existing array placed by
 * ANOTHER copy (possibly an older/newer protocol package, possibly a bundle)
 * is adopted as-is and never replaced — adopting a foreign array is the whole
 * mechanism, so nothing here may assume the array was built by this module.
 */
function slot(): RuntimeCopy[] {
  const g = globalThis as unknown as Slot;
  const existing = g[RUNTIME_COPIES];
  if (Array.isArray(existing)) return existing;
  const fresh: RuntimeCopy[] = [];
  Object.defineProperty(globalThis, RUNTIME_COPIES, {
    value: fresh,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return fresh;
}

/**
 * Register this runtime copy. Idempotent per URL: a module evaluated once
 * registers once, and a defensive second call (re-import of the same URL
 * cannot re-evaluate, but a bundle may embed the call twice) is a no-op.
 */
export function registerRuntimeCopy(entry: RuntimeCopy): RuntimeCopy[] {
  const copies = slot();
  for (const c of copies) if (c.url === entry.url) return copies;
  copies.push(Object.freeze({
    url: entry.url,
    runtimeVersion: entry.runtimeVersion,
    protocolGeneration: entry.protocolGeneration,
  }));
  return copies;
}

/** A read-only snapshot of the copies registered so far. */
export function runtimeCopies(): readonly RuntimeCopy[] {
  return slot().slice();
}

/**
 * A one-line human census for diagnostics, or `""` when the graph is healthy
 * (0 or 1 copies) — callers append it unconditionally and get nothing in the
 * single-copy case, which keeps every existing message byte-identical.
 */
export function copyCensus(): string {
  const copies = slot();
  if (copies.length <= 1) return "";
  return `${copies.length} polyengine copies loaded: ${
    copies.map((c) => c.url).join(", ")
  }`;
}
