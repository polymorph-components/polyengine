// `@polyengine/protocol` — the embedder contract's VOCABULARY, dependency-free
// (contracts/embedder-api.md §"Module identity and @polyengine/protocol",
// amendment A9; issue #83).
//
// What lives here: the process-global brand symbols, the canonical error
// classes, `suspending()`/`isSuspending`, the recognition predicates, the
// copy registry, and `PROTOCOL_GENERATION`. What does NOT live here: any
// runtime machinery. Copies of THIS package are harmless by construction —
// identity never rests on the package, only on the `Symbol.for` registry
// symbols. Host-module packages SHOULD import at most this package
// (docs/consumers.md "The application owns the import map"), and with
// hand-rolled brands even that import is optional.
//
// `@polyengine/runtime/embedder` re-exports all of it unchanged.

export {
  defineBrand,
  defineRealmLocal,
  DROPPED,
  ERROR_CONTEXT,
  FUTURE,
  hasBrand,
  INVALID_HANDLE,
  isRealmLocal,
  PEER_TRAPPED,
  POLLABLE,
  PROTOCOL_GENERATION,
  REALM_LOCAL,
  RESOURCE_STATE,
  RUNTIME_COPIES,
  STREAM,
  STREAM_PRODUCER,
  SUSPENDING,
  TRAP,
  WASI_EXIT,
  COMPONENT_EXCEPTION,
} from "./brands.ts";

export {
  DroppedError,
  InvalidHandleError,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isStreamProducerError,
  isTrap,
  isComponentException,
  PeerTrappedError,
  StreamProducerError,
  Trap,
  ComponentException,
} from "./errors.ts";

// Realm-boundary crossings (amendment A20; issue #131). The envelope TAG is
// deliberately not exported: the form is version-internal, and an exported
// constant invites persistence on it.
export {
  fromCloneable,
  toCloneable,
  type ToCloneableOptions,
} from "./cloneable.ts";

export { anySuspendingImport, isSuspending, suspending } from "./suspending.ts";

export {
  copyCensus,
  registerRuntimeCopy,
  type RuntimeCopy,
  runtimeCopies,
} from "./registry.ts";
