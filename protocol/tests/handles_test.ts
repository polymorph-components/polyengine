// Recognition of the stream/future handle vocabulary is by brand, not class
// (contracts/embedder-api.md §"Streams and futures", §"The host-ABI surface
// and its version").
//
// Same two-halves shape as errors_test.ts: a hand-rolled brand IS the value
// (any copy, or a zero-import host module), and an unbranded look-alike is
// NOT.

import { assert, assertFalse } from "./assert.ts";
import {
  ERROR_CONTEXT,
  FUTURE,
  isErrorContext,
  isFuture,
  isStream,
  isStreamWriter,
  STREAM,
  STREAM_WRITER,
} from "../src/mod.ts";

Deno.test("isStream recognizes a branded value, any copy or hand-rolled", () => {
  assert(isStream({ [STREAM]: true }));
  assert(isStream({ [Symbol.for("polyengine.stream/1")]: true }));
  assertFalse(isStream({}));
  assertFalse(isStream(null));
  assertFalse(isStream(undefined));
  assertFalse(isStream({ [STREAM]: false }));
});

Deno.test("isStreamWriter recognizes the writer brand only", () => {
  assert(isStreamWriter({ [STREAM_WRITER]: true }));
  assert(isStreamWriter({ [Symbol.for("polyengine.streamWriter/1")]: true }));
  assertFalse(isStreamWriter({}));
  // Does not cross-talk with the reader-side stream brand.
  assertFalse(isStreamWriter({ [STREAM]: true }));
  assertFalse(isStream({ [STREAM_WRITER]: true }));
});

Deno.test("isFuture recognizes a branded value, any copy or hand-rolled", () => {
  assert(isFuture({ [FUTURE]: true, then() {} }));
  assertFalse(isFuture({ then() {} }));
  assertFalse(isFuture(null));
});

Deno.test("isErrorContext requires the brand AND a string message", () => {
  assert(isErrorContext({ [ERROR_CONTEXT]: true, message: "boom" }));
  // Branded but no string message: refused — the acceptance rule is
  // "message-valued", not "brand alone".
  assertFalse(isErrorContext({ [ERROR_CONTEXT]: true }));
  assertFalse(isErrorContext({ [ERROR_CONTEXT]: true, message: 42 }));
  // A string message with no brand: also refused (brand is not optional).
  assertFalse(isErrorContext({ message: "boom" }));
  assertFalse(isErrorContext(null));
  assertFalse(isErrorContext(undefined));
});

Deno.test("the three stateful brands don't cross-talk", () => {
  assertFalse(isStream({ [FUTURE]: true }));
  assertFalse(isFuture({ [STREAM]: true }));
  assertFalse(isStreamWriter({ [Symbol.for("polyengine.errorContext/1")]: true }));
});
