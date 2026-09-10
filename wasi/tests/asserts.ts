// Minimal, dependency-free assertion helpers for wasi tests.

export function assertEq<T>(actual: T, expected: T, msg?: string): void {
  const ok = Object.is(actual, expected) ||
    (typeof actual === "bigint" && typeof expected === "bigint" &&
      actual === expected);
  if (!ok) {
    throw new Error(
      `${msg ?? "assertEq failed"}: expected ${describe(expected)}, got ${
        describe(actual)
      }`,
    );
  }
}

export function assertTrue(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg ?? "assertTrue failed");
}

export async function assertRejects(
  f: () => unknown | Promise<unknown>,
  msg?: string,
): Promise<unknown> {
  try {
    await f();
  } catch (e) {
    return e;
  }
  throw new Error(msg ?? "expected a throw/rejection, got none");
}

export function assertThrows(f: () => unknown, msg?: string): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error(msg ?? "expected a throw, got none");
}

function describe(v: unknown): string {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) return `Uint8Array[${v.join(",")}]`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
