// Embedder conventions layer (contracts/embedder-api.md; docs/consumers.md).
//
// The host-facing surface: camelCase facades, resource classes on both sides,
// stream/future handles, version-canonical import resolution and the branded
// error model, built from the plan's type tables for typed or untyped callers.
// Generated bindings verify their world digest and delegate to this facade.

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

// Application machinery lives here. Host modules import ABI vocabulary
// (errors, brands, suspension marks, realm crossing) from @polyengine/protocol.

export {
  artifactsFromEnvelope,
  type ComponentArtifacts,
  type EmbedderInstance,
  type EmbedderOptions,
  instantiate,
  instantiateEmbedder,
  type InstantiateSource,
  resolveArtifacts,
  type UntranslatedArtifacts,
} from "./instantiate.ts";

export {
  type FuncSummary,
  type ImportLeaf,
  type PlanLike,
  requiredImports,
} from "./imports.ts";

// Naming failures belong to facade construction/value adaptation, not host ABI.
export { NameCollisionError } from "./errors.ts";

export { type ElemCodec } from "./streams.ts";

// The application creates pairs; host modules use protocol handle interfaces.
import { Stream as InternalStream } from "./streams.ts";
import type {
  Stream as ProtocolStream,
  StreamWriter as ProtocolStreamWriter,
} from "@polyengine/protocol";

/** Create a stream/writer pair. Writer operations wait until passing the
 * stream to a guest binds its element type. */
export function createStream<T>(): {
  stream: ProtocolStream<T>;
  writer: ProtocolStreamWriter<T>;
} {
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
