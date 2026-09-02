// `@polyengine/protocol` — the embedder contract's VOCABULARY, dependency-free
// (contracts/embedder-api.md §"Module identity and @polyengine/protocol";
// issue #83).
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
  ABORTABLE,
  defineBrand,
  defineRealmLocal,
  DEFER_CANCEL,
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
  STREAM,
  STREAM_PRODUCER,
  STREAM_WRITER,
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

// Stream/future handles (contracts/embedder-api.md §"Streams and futures";
// §"The host-ABI surface and its version"): executable
// structural interfaces, aux types, and brand predicates. The runtime's
// concrete classes `implements` these; this package never imports them.
export {
  type Chunk,
  type DirectDestination,
  type DirectSource,
  type DirectVerdict,
  type ErrorContext,
  type Future,
  type FutureSource,
  isErrorContext,
  isFuture,
  isStream,
  isStreamWriter,
  type Stream,
  type StreamSource,
  type StreamWriter,
} from "./handles.ts";

// Realm-boundary crossings (contracts/embedder-api.md §"Realm boundaries and
// structured-clone-safe forms"; issue #131). The envelope TAG is
// deliberately not exported: the form is version-internal, and an exported
// constant invites persistence on it.
export {
  fromCloneable,
  toCloneable,
  type ToCloneableOptions,
} from "./cloneable.ts";

export { abortable, isAbortable } from "./abortable.ts";

export { deferCancel, isDeferCancel } from "./defer_cancel.ts";

export { anySuspendingImport, isSuspending, suspending } from "./suspending.ts";

export {
  copyCensus,
  registerRuntimeCopy,
  type RuntimeCopy,
  runtimeCopies,
} from "./registry.ts";
