// Trap and assertion machinery (definitions.py `Trap`, `trap`, `trap_if`).
//
// `Trap`'s canonical definition lives in `@polyengine/protocol`
// so it is recognizable across runtime copies
// (contracts/embedder-api.md §"Module identity").
//
// `Trap` represents a Component Model trap. `AssertionError` represents
// reference assertions and host-precondition violations, such as an invalid
// value supplied to scalar lowering, not a guest's canonical trap outcome.
// Throwing a JS exception does not itself ensure guest uncatchability;
// see intrinsics/mod.ts `HostTrapState` for that limitation.

import { Trap } from "@polyengine/protocol";

export { isTrap, Trap } from "@polyengine/protocol";

export function trap(message?: string): never {
  throw new Trap(message);
}

export function trapIf(cond: boolean, message?: string): void {
  if (cond) trap(message);
}

export class AssertionError extends Error {
  constructor(message = "internal assertion failed") {
    super(message);
    this.name = "AssertionError";
  }
}

export function assert_(cond: boolean, message?: string): asserts cond {
  if (!cond) throw new AssertionError(message);
}

/** Marker for an unsupported interpreter path, distinct from a guest trap. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented in cabi v1: ${what}`);
    this.name = "NotImplemented";
  }
}
