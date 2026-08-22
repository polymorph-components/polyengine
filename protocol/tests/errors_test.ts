// Recognition is by brand, not class (contracts/embedder-api.md §"Error
// model", amendment A9; issue #83).
//
// Two properties are under test, and they are the two halves of the amendment:
// a value minted by ANY copy is recognized (simulated here by hand-rolling
// the brand, which is exactly what a foreign copy's prototype provides), and
// an unbranded look-alike is NOT.

import { assert, assertEquals, assertFalse } from "./assert.ts";
import {
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
} from "../src/mod.ts";

Deno.test("A9: canonical classes are recognized by their own predicate", () => {
  assert(isComponentException(new ComponentException({ kind: "nope" })));
  assert(isTrap(new Trap("x")));
  assert(isDroppedError(new DroppedError()));
  assert(isPeerTrappedError(new PeerTrappedError("where", new Error("e"))));
  assert(isInvalidHandleError(new InvalidHandleError("x")));
  assert(isStreamProducerError(new StreamProducerError("w", new Error("e"))));
});

Deno.test("A9: the brands do not cross-talk", () => {
  assertFalse(isTrap(new ComponentException(1)));
  assertFalse(isComponentException(new Trap()));
  assertFalse(isDroppedError(new PeerTrappedError("w", "c")));
  assertFalse(isPeerTrappedError(new DroppedError()));
});

Deno.test("A9: a hand-rolled brand IS the value (zero-import host module)", () => {
  // Precisely the shape contracts/embedder-api.md blesses: "an Error with
  // [Symbol.for('polyengine.componentException/1')]: true and a payload property IS a
  // ComponentException to every copy".
  const e = Object.assign(new Error("boom"), {
    [Symbol.for("polyengine.componentException/1")]: true,
    payload: { kind: "denied" },
  });
  assert(isComponentException(e));
  assertEquals(e.payload, { kind: "denied" });

  // Not even an Error: brands are markers, not a class hierarchy.
  assert(isTrap({ [Symbol.for("polyengine.trap/1")]: true }));
  assert(isStreamProducerError(
    { [Symbol.for("polyengine.streamProducer/1")]: true },
  ));
});

Deno.test("A9: unbranded look-alikes are refused", () => {
  class NotAComponentException extends Error {
    payload = 1;
  }
  assertFalse(isComponentException(new NotAComponentException()));
  assertFalse(isComponentException(new Error("plain")));
  assertFalse(isComponentException({ payload: 1 }));
  assertFalse(isComponentException(null));
  assertFalse(isComponentException(undefined));
  assertFalse(isComponentException("polyengine.componentException/1"));
  assertFalse(isComponentException(42));
  // Present but not exactly `true`: refused (no truthiness coercion).
  assertFalse(isComponentException({ [Symbol.for("polyengine.componentException/1")]: 1 }));
});

Deno.test("A9: predicates are NOT instanceof — a foreign prototype passes", () => {
  // A different copy's class: same brand key (registry symbol), different
  // constructor identity. This is the #83 failure mode, made to pass.
  class ForeignComponentException extends Error {
    payload: unknown;
    constructor(payload: unknown) {
      super("foreign");
      this.payload = payload;
    }
  }
  Object.defineProperty(
    ForeignComponentException.prototype,
    Symbol.for("polyengine.componentException/1"),
    { value: true },
  );
  const e = new ForeignComponentException({ kind: "x" });
  assertFalse(e instanceof ComponentException, "premise: class identity differs");
  assert(isComponentException(e), "brand identity holds");
});

Deno.test("A9: Symbol.hasInstance is deliberately NOT overridden", () => {
  // Overriding it would be inherited by consumer subclasses, so
  // `x instanceof MySubclass` would match ANY branded value — a worse footgun
  // than the one A9 removes. instanceof keeps its plain nominal meaning.
  class Sub extends ComponentException<number> {}
  assertFalse(new ComponentException(1) instanceof Sub);
  assert(new Sub(1) instanceof ComponentException);
});
