// ROW (g) — ERROR-CONTEXT (contracts/embedder-api.md §"Realm boundaries and
// structured-clone-safe forms", amendment A20: "Error-context is
// message-valued").
//
// An error-context's state is exactly its debug message (definitions.py), so
// A20 supersedes "lowering accepts only lifted instances": lowering accepts
// ANY branded carrier of a string `message`, minting a fresh LOCAL context —
// a new local value, never "the same" one. A branded carrier WITHOUT a string
// message keeps the loud A9 cross-copy refusal, because that shape is a
// genuinely foreign stateful handle rather than a message carrier.
//
// Fixture: `error-context-relay.wat` (this directory) — the only component
// anywhere in the tree that puts an `error-context` in a function signature.

import { haveFixture, instantiateFixture, local } from "./harness.ts";
import { transcript } from "./support.ts";
import { classify, type ErrorContext } from "./probe.ts";
import {
  ERROR_CONTEXT_KEY,
  handRolledErrorContext,
} from "./probe_zero_import.ts";

const FIXTURE = local("error-context-relay");
const ready = await haveFixture(FIXTURE);

Deno.test({
  name: "conventions/g: a lifted error-context is branded and carries its message",
  ignore: !ready,
  fn: async () => {
    await transcript("g-error-context-lift", async (t) => {
      let seen: unknown;
      const c = await instantiateFixture(FIXTURE, {
        "host:api/ec": {
          relay: (ctx: ErrorContext) => {
            seen = ctx;
            // Hand the very same lifted value back down.
            return ctx;
          },
        },
      });
      // The guest returns the byte length of the message it reads back —
      // "guest-ctx", 9 bytes, if the round trip preserved it.
      await t.attempt("probe", () => c.exports.probe());
      t.note("host-received", {
        classified: classify(seen),
        message: (seen as ErrorContext).message,
      });
    });
  },
});

Deno.test({
  name: "conventions/g: A20 — a hand-rolled branded message carrier lowers",
  ignore: !ready,
  fn: async () => {
    await transcript("g-error-context-message-valued", async (t) => {
      const c = await instantiateFixture(FIXTURE, {
        "host:api/ec": {
          // Zero protocol imports on this side: the brand key spelled out by
          // hand, plus a string `message`. A20 mints a fresh LOCAL context
          // from it — there is nothing to alias, so identity is not in play.
          relay: (_ctx: ErrorContext) => handRolledErrorContext("from-host!"),
        },
      });
      // "from-host!" is 10 bytes; the guest reports what it read back.
      await t.attempt("probe", () => c.exports.probe());
    });
  },
});

Deno.test({
  name: "conventions/g: a branded carrier WITHOUT a string message is refused",
  ignore: !ready,
  fn: async () => {
    await transcript("g-error-context-no-message", async (t) => {
      const c = await instantiateFixture(FIXTURE, {
        "host:api/ec": {
          relay: (_ctx: ErrorContext) => {
            // Branded, but message-less: the shape A20 leaves under A9's loud
            // cross-copy refusal, because it is a foreign stateful handle
            // whose machinery lives in another copy's tables.
            const foreign: Record<string | symbol, unknown> = {};
            foreign[Symbol.for(ERROR_CONTEXT_KEY)] = true;
            return foreign;
          },
        },
      });
      await t.attempt("probe", () => c.exports.probe());

      // …and an entirely unbranded object is refused too, with the generic
      // message: a host that returns the wrong kind of thing is a host bug.
      const bare = await instantiateFixture(FIXTURE, {
        "host:api/ec": { relay: (_c: ErrorContext) => ({ message: "nope" }) },
      });
      await t.attempt("probe/unbranded", () => bare.exports.probe());
    });
  },
});

Deno.test({
  name: "conventions/g: isErrorContext accepts a hand-rolled carrier, rejects a husk",
  fn: async () => {
    await transcript("g-error-context-predicate", async (t) => {
      // The vocabulary claim on its own: recognition is brand + string
      // `message`, in any copy, hand-rolled or not.
      t.note("hand-rolled", {
        classified: classify(handRolledErrorContext("m")),
        value: handRolledErrorContext("m"),
      });
      const husk: Record<string | symbol, unknown> = { message: 42 };
      husk[Symbol.for(ERROR_CONTEXT_KEY)] = true;
      t.note("branded-non-string-message", { classified: classify(husk) });
      t.note("unbranded", { classified: classify({ message: "m" }) });
    });
  },
});
