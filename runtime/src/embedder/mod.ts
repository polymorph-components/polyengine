// Embedder conventions layer (contracts/embedder-api.md; docs/milestones.md C2 / docs/consumers.md).
//
// The host-facing surface: camelCase facades, resource classes on both sides,
// stream/future handles, version-canonical import resolution and the branded
// error model — all built at instantiate time from the plan's type tables, so
// the layer works fully untyped. Bindgen (a separate track) emits compile-time
// types that cast this facade; no generated code participates.

// Copy registration (contracts/embedder-api.md §"Module identity and
// @polyengine/protocol", amendment A9; issue #83). Runs at module evaluation, so
// merely importing the embedder surface puts this copy on the census — which
// is what makes every cross-copy diagnostic below able to name both sides.
// Multiple copies are DIAGNOSED, NEVER REFUSED: two isolated bundles on one
// page that exchange no values are legal.
import { PROTOCOL_GENERATION, registerRuntimeCopy } from "@polyengine/protocol";
import { COPY_URL, RUNTIME_VERSION } from "./copy.ts";

registerRuntimeCopy({
  // `COPY_URL` (embedder/copy.ts) rather than this module's own
  // `import.meta.url`, so the census and every cross-copy message name the
  // copy identically — one module owns the identity.
  url: COPY_URL,
  runtimeVersion: RUNTIME_VERSION,
  protocolGeneration: PROTOCOL_GENERATION,
});

export { COPY_URL, RUNTIME_VERSION } from "./copy.ts";

// The A9 vocabulary, re-exported unchanged: embedder code needs no import
// change, and consumers that want the multi-copy-robust spellings get them
// from the same module they already import.
export {
  copyCensus,
  defineRealmLocal,
  DROPPED,
  ERROR_CONTEXT,
  fromCloneable,
  FUTURE,
  hasBrand,
  INVALID_HANDLE,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isRealmLocal,
  isStreamProducerError,
  isSuspending,
  isTrap,
  isComponentException,
  PEER_TRAPPED,
  PROTOCOL_GENERATION,
  REALM_LOCAL,
  registerRuntimeCopy,
  RESOURCE_STATE,
  type RuntimeCopy,
  runtimeCopies,
  STREAM,
  STREAM_PRODUCER,
  SUSPENDING,
  toCloneable,
  TRAP,
  COMPONENT_EXCEPTION,
} from "@polyengine/protocol";

export {
  artifactsFromEnvelope,
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  type InstantiateSource,
  type UntranslatedArtifacts,
  instantiate,
  instantiateEmbedder,
  resolveArtifacts,
} from "./instantiate.ts";

export { type FuncSummary, type ImportLeaf, type PlanLike, requiredImports } from "./imports.ts";

export {
  DroppedError,
  InvalidHandleError,
  NameCollisionError,
  PeerTrappedError,
  Trap,
  ComponentException,
} from "./errors.ts";

export {
  type Chunk,
  type ElemCodec,
  ErrorContext,
  Future,
  type FutureSource,
  Stream,
  StreamProducerError,
  type StreamSource,
  StreamWriter,
} from "./streams.ts";

export { GuestResource, HostResourceRegistry } from "./resources.ts";

export { camelCase, type LeafName, parseLeafName, pascalCase } from "./casing.ts";

// Per-declaration suspendability (contracts/embedder-api.md §"Functions and
// async", amendment A1): declares that a sync-typed host import may return a
// Promise, parking the calling wasm frame (JSPI engines only).
export { suspending } from "../jspi/suspending.ts";

export {
  asTrackKeySpelling,
  compareSemver,
  ImportRegistrationError,
  ImportResolutionError,
  ImportResolver,
  type ParsedId,
  parseInterfaceId,
  parseSemver,
  type Semver,
  trackKey,
} from "./version.ts";

export {
  type AdapterOptions,
  BorrowScope,
  fromHost,
  toHost,
  type ValueBridge,
} from "./values.ts";
