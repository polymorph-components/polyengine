import {
  type CaseType,
  CoreValueIter,
  liftFlatVariant,
  loadVariant,
  MemInst,
  Trap,
} from "../src/cabi/mod.ts";
import { mkCx } from "./support/driver.ts";

function cases(length: number): CaseType[] {
  return Array.from({ length }, (_, i) => ({
    label: `case-${i}`,
    type: null,
  }));
}

function assertExactTrap(fn: () => unknown, expected: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Trap && error.message === expected) return;
    throw new Error(`expected Trap(${expected}), got ${String(error)}`);
  }
  throw new Error(`expected Trap(${expected}), but returned`);
}

Deno.test("memory variant traps include the discriminant and case count", () => {
  for (const [tag, count] of [[2, 2], [3, 3]] as const) {
    const memory = new MemInst(new Uint8Array([tag]), "i32");
    assertExactTrap(
      () => loadVariant(mkCx(memory), 0, cases(count), 1, 1),
      `discriminant ${tag} out of range [0..${count})`,
    );
  }
});

Deno.test("flat variant traps include the discriminant and case count", () => {
  for (const [tag, count] of [[2, 2], [3, 3]] as const) {
    assertExactTrap(
      () => liftFlatVariant(mkCx(), new CoreValueIter([tag]), cases(count)),
      `discriminant ${tag} out of range [0..${count})`,
    );
  }
});
