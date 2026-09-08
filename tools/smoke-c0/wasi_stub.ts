// Smoke-only host glue from `plan.imports`, not a WASI provider. Consumer binaries
// may import a libc baseline beyond their WIT world. Unimplemented leaves throw
// `StubCalled`; overrides use version-independent `<pkg>:<iface>/<leaf>` keys
// so one implementation can serve the corpus's different interface versions.

import { hostResourceType } from "../../runtime/src/exec/mod.ts";
import type { WirePlan } from "../../runtime/src/plan/format.ts";

export class StubCalled extends Error {
  constructor(readonly importPath: string) {
    super(`stub called: ${importPath} (not implemented by this leg)`);
    this.name = "StubCalled";
  }
}

/** `"wasi:cli/exit@0.2.9"` -> `"wasi:cli/exit"`. */
export function stripVersion(iface: string): string {
  const at = iface.lastIndexOf("@");
  return at < 0 ? iface : iface.slice(0, at);
}

export interface StubOptions {
  /** Version-independent key `"<iface-no-version>/<leaf...>"` -> impl. */
  overrides?: Record<string, unknown>;
  /** Every leaf actually reached at runtime is appended here. */
  trace?: string[];
  /** Resource dtors observed, as `"<iface>/<resource>#<rep>"`. */
  dropped?: string[];
}

export interface StubResult {
  imports: Record<string, unknown>;
  /** Version-independent keys that had no override (pure stubs). */
  stubbed: string[];
  /** Override keys that were consumed (sanity check against typos). */
  matched: string[];
}

/**
 * Build the host-import object for `plan`, stubbing everything not overridden.
 */
export function buildImports(
  plan: WirePlan,
  opts: StubOptions = {},
): StubResult {
  const overrides = opts.overrides ?? {};
  const trace = opts.trace;
  const dropped = opts.dropped;
  const imports: Record<string, unknown> = {};
  const stubbed: string[] = [];
  const matched = new Set<string>();

  for (const imp of plan.imports) {
    const iface = stripVersion(imp.name);
    const leaf = imp.path.join("/");
    const key = leaf === "" ? iface : `${iface}/${leaf}`;
    const display = leaf === "" ? imp.name : `${imp.name}/${leaf}`;

    let value: unknown;
    if (Object.hasOwn(overrides, key)) {
      matched.add(key);
      value = overrides[key];
      if (typeof value === "function" && trace) {
        const inner = value as (...a: unknown[]) => unknown;
        value = (...a: unknown[]) => {
          trace.push(display);
          return inner(...a);
        };
      }
    } else if (imp.kind === "resource") {
      stubbed.push(key);
      value = hostResourceType({
        name: key,
        dtor: (rep: number) => {
          dropped?.push(`${display}#${rep}`);
        },
      });
    } else {
      stubbed.push(key);
      value = () => {
        trace?.push(`${display} (STUB)`);
        throw new StubCalled(display);
      };
    }

    if (imp.path.length === 0) {
      imports[imp.name] = value;
      continue;
    }
    // Instance import: the host object mirrors the component's own instance
    // structure, leaves addressed by `path` (e2e_imports_test.ts).
    let cursor = imports;
    if (!(imp.name in cursor)) cursor[imp.name] = {};
    cursor = cursor[imp.name] as Record<string, unknown>;
    for (let i = 0; i < imp.path.length - 1; i++) {
      const seg = imp.path[i];
      if (!(seg in cursor)) cursor[seg] = {};
      cursor = cursor[seg] as Record<string, unknown>;
    }
    cursor[imp.path[imp.path.length - 1]] = value;
  }

  const unused = Object.keys(overrides).filter((k) => !matched.has(k));
  if (unused.length > 0) {
    // Informational, not an error: overrides are offered for the union of the
    // corpus's import surfaces, and any one component uses a subset. It is
    // still worth printing — a typo'd key would otherwise silently leave a
    // stub in place and fail much later as `StubCalled`.
    console.log(
      `  [stub] offered but not present in plan.imports: ${unused.join(", ")}`,
    );
  }
  return { imports, stubbed: stubbed.sort(), matched: [...matched].sort() };
}
