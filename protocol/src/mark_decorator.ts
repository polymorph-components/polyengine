// Module-private factory shared by suspending(), deferCancel(), and
// abortable() (contracts/embedder-api.md §"Functions and async"). The three
// marks differ only in name, brand symbol, and one describing adjective; this
// helper carries the byte-identical validation body so the three public
// functions stay in lockstep without copy-paste. Not exported from mod.ts —
// intra-package only.

import { defineBrand, hasBrand } from "./brands.ts";

/**
 * Build a mark function `(fn, context?, legacyDescriptor?) => fn` that
 * validates the stage-3-decorator / direct-call calling convention, throws
 * the shared error messages (parameterized by `name` and `adjective`), and
 * brands `fn` with `brand` in place.
 */
export function makeMark(
  name: string,
  adjective: string,
  brand: symbol,
): <F extends CallableFunction>(
  fn: F,
  context?: unknown,
  legacyDescriptor?: unknown,
) => F {
  return function mark<F extends CallableFunction>(
    fn: F,
    context?: unknown,
    legacyDescriptor?: unknown,
  ): F {
    // TypeScript-legacy method decorator convention: (prototype, key,
    // descriptor). Detectable because stage-3 contexts are objects with a
    // string `kind`, never string/symbol property keys.
    if (
      typeof context === "string" || typeof context === "symbol" ||
      legacyDescriptor !== undefined
    ) {
      throw new TypeError(
        `${name}: legacy (experimentalDecorators) method decoration is not ` +
          `supported — the decorator would receive the prototype, not the ` +
          `method. Compile with stage-3 decorators (the default), or use the ` +
          `call form: \`f: ${name}(fn)\`.`,
      );
    }
    if (context !== undefined) {
      const kind = (context as { kind?: unknown }).kind;
      if (kind !== "method") {
        throw new TypeError(
          `${name}: cannot decorate a ${String(kind)} — only methods ` +
            `(instance or static) can be marked ${adjective}. Constructors are ` +
            `synchronous by contract; for record-literal imports use the call ` +
            `form: \`f: ${name}(fn)\`.`,
        );
      }
    }
    if (typeof fn !== "function") {
      throw new TypeError(
        `${name}: expected a function, got ${typeof fn}`,
      );
    }
    // Non-enumerable (`defineBrand`): the mark must not show up in value
    // walks of an imports record, and re-marking the same function is a
    // no-op.
    defineBrand(fn as unknown as object, brand);
    return fn;
  };
}
