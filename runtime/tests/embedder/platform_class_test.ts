// Characterization test: the "zero-glue platform class" pattern — a WIT
// resource import satisfied by handing the runtime a NATIVE web platform
// class directly (`URLSearchParams`, `TextDecoder`), no wrapper. This is the
// ergonomic idea from the upstream web-embedding draft
// (WebAssembly/component-model#686), claimed here in test form against
// polyengine's EXISTING host-resource semantics.
//
// Governing docs (contracts/embedder-api.md):
//   - §"Value mapping (normative)": the option rule — outermost `none` is
//     `undefined`, never `null`.
//   - §"Error model": an unbranded host throw traps; only a
//     `throw new ComponentException(payload)` crosses as a WIT `err`.
//   - §"Resources": host-implemented direction — a class sits at the
//     resource's position in the imports object.
//   - §"Naming and casing": kebab-case member names resolve through
//     `camelCase` (`to-string` -> `toString`).
//
// Mechanics cited (instantiate.ts:580-660): `[method]` dispatch is a
// PER-CALL prototype lookup — `self[camelCase(member)]` then
// `.apply(self, rest)` — so a getter-backed property (no callable member) is
// a `Trap` raised at CALL time, not at instantiation.
//
// Fixture: platform-class.wat/.wasm in this directory (see its header for
// the WIT shape and the ABI bookkeeping behind the trampolines).

import { assertEq } from "../support/asserts.ts";
import { caught, haveFixture, instantiateFixture } from "./support.ts";
import { ComponentException, isTrap, Trap } from "@polyengine/protocol";

const FIXTURE = "runtime/tests/embedder/platform-class.wasm";
const ready = await haveFixture(FIXTURE);

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Instance imports are two-level: the interface name keys a namespace object,
// and the resources sit inside it — the classes themselves, nothing else.
const WEB = {
  "test:platform/web": { params: URLSearchParams, decoder: TextDecoder },
};

Deno.test({
  name: "platform class: happy path — native URLSearchParams/TextDecoder with no wrapper",
  ignore: !ready,
  fn: async () => {
    const c = await instantiateFixture(FIXTURE, WEB);

    // Constructor args, string conversions, and kebab->camel (`to-string` ->
    // `toString`) all round-trip through the native class untouched.
    assertEq(
      await c.exports.roundtrip("a=1&b=2", "c", "3"),
      "a=1&b=2&c=3",
    );
    assertEq(await c.exports.probeHas("a=1", "a"), true);
    assertEq(await c.exports.probeGet("a=1", "a"), "1");

    // `decode` is result-typed on purpose; a clean decode is the ok side and
    // lifts as the plain string (result in function-result position: T on
    // ok, ComponentException on err — contract's error model).
    const ok = await c.exports.probeDecode(false, bytesOf("hello"));
    assertEq(ok, "hello");
  },
});

Deno.test({
  name: "platform class: option-limit — a missing key surfaces null, which fails (not none)",
  ignore: !ready,
  fn: async () => {
    // `URLSearchParams.prototype.get` returns `null` for a missing key. The
    // option rule maps JS `undefined` -> none; `null` is NOT `undefined`, so
    // it takes the `some` branch and the inner string conversion of `null`
    // fails. Characterized behavior: the failure surfaces as the conversion
    // layer's own TypeError naming the import — NOT a Trap (the instance is
    // not poisoned), and NOT a ComponentException (never an `err` value).
    // Platform APIs speak null-for-absent; WIT option speaks
    // undefined-for-none — bridging them needs a wrapper (`?? undefined`).
    const c = await instantiateFixture(FIXTURE, WEB);
    const e = await caught(() => c.exports.probeGet("a=1", "missing"));
    assertEq(isTrap(e), false, `${e}`);
    assertEq(e instanceof ComponentException, false, `${e}`);
    assertEq(e instanceof TypeError, true, `expected a TypeError, got ${e}`);
    // Pinned wording: the import label plus values.ts's string-case message.
    assertEq(
      String(e).includes(
        "import 'test:platform/web/[method]params.get': string expects a string",
      ),
      true,
      `${e}`,
    );
  },
});

Deno.test({
  name: "platform class: getter limit — `size` is a property, not a method, and traps",
  ignore: !ready,
  fn: async () => {
    // `URLSearchParams.prototype.size` is an accessor (getter), so
    // `self["size"]` is a number, not a function — the per-call dispatch at
    // instantiate.ts:630-643 throws a Trap naming the missing method.
    const c = await instantiateFixture(FIXTURE, WEB);
    const e = await caught(() => c.exports.probeSize());
    assertEq(isTrap(e), true, `expected a Trap, got ${e}`);
    assertEq(
      /has no method 'size'/.test(String(e)),
      true,
      `${e}`,
    );
  },
});

Deno.test({
  name: "platform class: a native platform exception traps, even from a result-typed import",
  ignore: !ready,
  fn: async () => {
    // `fatal: true` + invalid UTF-8 makes native TextDecoder.prototype.decode
    // throw a TypeError. That throw is UNBRANDED (not a ComponentException),
    // so per the error model it traps the component — even though
    // `[method]decoder.decode` is `result<string, string>` at the WIT level.
    // A result-typed WIT signature does not make host exceptions into `err`
    // values; only `throw new ComponentException(payload)` does that.
    const c = await instantiateFixture(FIXTURE, WEB);
    const e = await caught(() =>
      c.exports.probeDecode(true, new Uint8Array([0xff]))
    );
    assertEq(isTrap(e), true, `expected a Trap (native throw is unbranded), got ${e}`);
    assertEq(
      e instanceof ComponentException,
      false,
      "a platform TypeError must never surface as the WIT err side",
    );
  },
});

Deno.test({
  name: "platform class: the one-line wrapper recipe turns a native throw into a WIT err",
  ignore: !ready,
  fn: async () => {
    // Contrast pin for the previous test: wrapping just the fallible method
    // to translate the platform exception into `throw new
    // ComponentException(payload)` is enough to make the SAME failure
    // surface as the guest's `err` case instead of a trap. This is the
    // recipe the doc references for platform classes whose failure modes
    // must reach the guest as WIT errors.
    class CheckedDecoder extends TextDecoder {
      override decode(input?: BufferSource): string {
        try {
          // deno-lint-ignore no-explicit-any
          return super.decode(input as any);
        } catch (e) {
          throw new ComponentException(String(e));
        }
      }
    }
    const c = await instantiateFixture(FIXTURE, {
      "test:platform/web": { params: URLSearchParams, decoder: CheckedDecoder },
    });
    const e = await caught(() =>
      c.exports.probeDecode(true, new Uint8Array([0xff]))
    );
    assertEq(e instanceof ComponentException, true, `expected ComponentException, got ${e}`);
    const payload = (e as ComponentException).payload;
    assertEq(
      typeof payload === "string" && payload.length > 0,
      true,
      `expected a non-empty string payload, got ${payload}`,
    );
  },
});
