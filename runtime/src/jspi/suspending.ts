// The per-declaration suspendability marker (contracts/embedder-api.md
// §"Functions and async"; docs/architecture.md §5).
//
// The canonical definitions live in `@polyengine/protocol` since §"Module identity and @polyengine/protocol":
// the mark is a process-global `Symbol.for("polyengine.suspending/1")` brand, so
// a function marked by ANY runtime copy is honored by every other copy
// (issue #83 — a module-local symbol made a copy-B mark invisible to copy A's
// `anySuspendingImport`, silently downgrading the calling convention and
// surfacing far away as `NeedsJspi`).
//
// Layering: this module was import-free on purpose (jspi/ stays standalone);
// module identity relaxes that to "imports `@polyengine/protocol` only" — the protocol package
// is itself dependency-free, so jspi/ still pulls in no runtime machinery.

// cancellation discard (`deferCancel`/`isDeferCancel`) and abortable() (`abortable`/`isAbortable`)
// ride the same re-export: they are the other per-declaration host-import
// marks, they live in the same dependency-free package, and
// `exec/executor.ts` reads all three through `jspi/mod.ts`.
// (Host modules import the marks from `@polyengine/protocol` directly —
// the embedder surface stopped re-exporting the vocabulary at host-ABI version.)
export {
  abortable,
  anySuspendingImport,
  deferCancel,
  isAbortable,
  isDeferCancel,
  isSuspending,
  suspending,
} from "@polyengine/protocol";
