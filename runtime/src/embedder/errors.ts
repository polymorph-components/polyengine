// The embedder-facing error model (contracts/embedder-api.md §"Error model").
//
// ABI error definitions live in @polyengine/protocol. This internal module
// also defines the unbranded, application-facing NameCollisionError.
//
// Recognition at the runtime's own boundaries is by BRAND, not class: use the
// `is*` predicates re-exported below, never `instanceof`, for any value that
// arrives from embedder code (issue #83).

export {
  ComponentException,
  DroppedError,
  InvalidHandleError,
  isComponentException,
  isDroppedError,
  isInvalidHandleError,
  isPeerTrappedError,
  isStreamProducerError,
  isTrap,
  PeerTrappedError,
  Trap,
} from "@polyengine/protocol";

/**
 * Two WIT labels in one scope camelCase to the same JS name.
 *
 * Raised during facade construction or value adaptation instead of letting
 * one field, flag or function silently shadow another.
 */
export class NameCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameCollisionError";
  }
}
