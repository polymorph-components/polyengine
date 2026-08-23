// The per-declaration suspendability marker (contracts/embedder-api.md
// §"Functions and async", amendments A1/A2; docs/architecture.md §5).
//
// The canonical definitions live in `@polyengine/protocol` since amendment A9:
// the mark is a process-global `Symbol.for("polyengine.suspending/1")` brand, so
// a function marked by ANY runtime copy is honored by every other copy
// (issue #83 — a module-local symbol made a copy-B mark invisible to copy A's
// `anySuspendingImport`, silently downgrading the calling convention and
// surfacing far away as `NeedsJspi`).
//
// Layering: this module was import-free on purpose (jspi/ stays standalone);
// A9 relaxes that to "imports `@polyengine/protocol` only" — the protocol package
// is itself dependency-free, so jspi/ still pulls in no runtime machinery.

// A23 (`deferCancel`/`isDeferCancel`) rides the same re-export: it is the
// other per-declaration host-import mark, it lives in the same dependency-free
// package, and `exec/executor.ts` reads both through `jspi/mod.ts`.
// (Host modules import both marks from `@polyengine/protocol` directly —
// the embedder surface stopped re-exporting the vocabulary at A22.)
export {
  anySuspendingImport,
  deferCancel,
  isDeferCancel,
  isSuspending,
  suspending,
} from "@polyengine/protocol";
