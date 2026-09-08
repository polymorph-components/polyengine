// Minimal local assertions for the jspi test corpus (no external deps, no
// network fetch — matches runtime/tests/support/asserts.ts style but scoped
// here since the jspi tests are structurally standalone).

export function assertEquals(
  actual: unknown,
  expected: unknown,
  msg?: string,
): void {
  const ok = actual === expected ||
    (typeof actual === "number" && typeof expected === "number" &&
      Number.isNaN(actual) && Number.isNaN(expected));
  if (!ok) {
    throw new Error(
      `${msg ? msg + ": " : ""}expected ${Deno.inspect(expected)}, got ${
        Deno.inspect(actual)
      }`,
    );
  }
}

export function assert(cond: unknown, msg = "assertion failed"): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Runs `fn`, asserts it throws/rejects, and returns the caught error. */
export async function assertRejects(
  fn: () => Promise<unknown>,
  msg = "expected promise to reject",
): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error(msg);
}
