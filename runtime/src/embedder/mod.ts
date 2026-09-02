// Embedder conventions layer (contracts/embedder-api.md; docs/consumers.md).
//
// The host-facing surface: camelCase facades, resource classes on both sides,
// stream/future handles, version-canonical import resolution and the branded
// error model — all built at instantiate time from the plan's type tables, so
// the layer works fully untyped. Bindgen (a separate track) emits compile-time
// types that cast this facade; no generated code participates.

// Copy registration (contracts/embedder-api.md §"Module identity and
// @polyengine/protocol"; issue #83). Runs at module evaluation, so
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

// The host-ABI version (contracts/embedder-api.md §"The host-ABI surface and its
// version"): the runtime's exported surface is application-only. The
// courtesy re-exports (error classes, predicates, brands, `suspending`,
// realm crossing, the copy registry) are removed — host modules import that
// vocabulary from `@polyengine/protocol` directly. The runtime still
// registers its own copy on the census above; it just no longer hands out
// the registry API to callers of this module.

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

// `NameCollisionError` is the one error class that stays here: it's raised
// while building an instantiation facade, before any handle/value exists —
// application machinery, not host-ABI vocabulary (contracts/embedder-api.md
// §"The host-ABI surface and its version", §"The host-ABI surface and its version").
export { NameCollisionError } from "./errors.ts";

export { type ElemCodec } from "./streams.ts";

// `createStream<T>()` — the host-ABI version stream-pair factory (contracts/embedder-api.md
// §"The host-ABI surface and its version" / §"Streams and futures"): the
// `Stream.create()` static's application-surface spelling, since the
// concrete `Stream`/`StreamWriter` classes are no longer exported. Handle
// TYPES are spelled against `@polyengine/protocol`'s structural interfaces.
import { Stream as InternalStream } from "./streams.ts";
import type { Stream as ProtocolStream, StreamWriter as ProtocolStreamWriter } from "@polyengine/protocol";

export function createStream<T>(): { stream: ProtocolStream<T>; writer: ProtocolStreamWriter<T> } {
  return InternalStream.create<T>();
}

export { GuestResource, HostResourceRegistry } from "./resources.ts";

export { camelCase, pascalCase } from "./casing.ts";

export {
  ImportRegistrationError,
  ImportResolutionError,
  ImportResolver,
} from "./version.ts";

export {
  type AdapterOptions,
  BorrowScope,
  fromHost,
  toHost,
  type ValueBridge,
} from "./values.ts";

export { type Sync, sync } from "./sync.ts";
