// Trap and assertion machinery (definitions.py `Trap`, `trap`, `trap_if`).
//
// `Trap`'s canonical definition lives in `@polyengine/protocol`
// (contracts/embedder-api.md §"Module identity": it is an embedder-contract value and must be recognizable across
// runtime copies, issue #83); it is re-exported here so every existing
// `from "../cabi/trap.ts"` import path is unchanged. The protocol package is
// dependency-free, so this import introduces no cycle.
//
// `Trap` models a Component Model trap — a deterministic guest-visible fault.
// `AssertionError` models the reference's Python `assert`s: internal
// invariants that callers are supposed to make unviolable. Tests treat only
// `Trap` as an expected outcome.

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

/** Marks a definitions.py code path this v1 interpreter does not port yet. */
export class NotImplemented extends Error {
  constructor(what: string) {
    super(`not implemented in cabi v1: ${what}`);
    this.name = "NotImplemented";
  }
}
