// Protocol-owned host-import markers. Their Symbol.for brands work across
// runtime copies. Host modules import @polyengine/protocol directly; the
// executor consumes these re-exports through jspi/mod.ts.
export {
  abortable,
  anySuspendingImport,
  deferCancel,
  isAbortable,
  isDeferCancel,
  isSuspending,
  suspending,
} from "@polyengine/protocol";
