// Component *imports*, end to end: host functions reached through
// `plan.imports[].path` (contracts/plan-format.md schema) and
// host-defined resource types reached through `plan.importedResources`
// (contracts/plan-format.md schema).
//
// The official suite's sync corpus never imports anything (every `linking/`
// and `resources/` component is closed), so these shapes get purpose-built
// fixtures: `crates/translator-shim/testdata/{imports,imported-resource}.wat`,
// committed as `.wasm` alongside their sources (regenerate with
// `crates/translator-shim/testdata/gen.sh`).

import { assertEq } from "../support/asserts.ts";
import { Translator } from "../../src/shim/mod.ts";
import {
  hostResourceType,
  instantiateComponent,
} from "../../src/exec/mod.ts";
import { PlanError } from "../../src/plan/mod.ts";
import { ResourceHandle } from "../../src/cabi/mod.ts";
import { SyncCallScope } from "../../src/intrinsics/mod.ts";
import { isInstancePoisoned } from "../../src/task/scheduler.ts";

const root = new URL("../../../", import.meta.url);

async function readIfPresent(rel: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(new URL(rel, root));
  } catch {
    return null;
  }
}

const shimWasm = await readIfPresent(
  "target/wasm32-unknown-unknown/release/translator_shim.wasm",
);
if (shimWasm === null) {
  console.warn(
    "SKIP import e2e: build the shim first — cargo build -p translator-shim " +
      "--release --target wasm32-unknown-unknown",
  );
}
const translator = shimWasm === null ? null : await Translator.create(shimWasm);

async function instantiate(
  fixture: string,
  imports: Record<string, unknown>,
) {
  const bytes = (await readIfPresent(
    `crates/translator-shim/testdata/${fixture}.wasm`,
  ))!;
  const { plan, adapters } = translator!.translate(bytes);
  return await instantiateComponent({
    plan,
    componentBytes: bytes,
    adapters,
    imports,
  });
}

type Fn = (...args: unknown[]) => unknown;
const fn = (c: { exports: Record<string, unknown> }, n: string) =>
  c.exports[n] as Fn;

// ---------------------------------------------------------------------------
// Function imports, direct and through an imported instance
// ---------------------------------------------------------------------------

Deno.test({
  name: "imports: direct func + instance path + string lowering via realloc",
  ignore: shimWasm === null,
  fn: async () => {
    const logged: number[] = [];
    const c = await instantiate("imports", {
      // Direct import: `plan.imports[0] = {name:"log", path:[]}`.
      "log": (x: unknown) => {
        logged.push(x as number);
      },
      // Instance import: leaves are addressed by `path`, so the host object
      // mirrors the component's own instance structure.
      "host:api/math": {
        add: (a: unknown, b: unknown) => (a as number) + (b as number),
        greet: (who: unknown) => `hello ${who as string}`,
      },
    });

    assertEq(fn(c, "run")(2, 40), 42);
    assertEq(logged, [42]);

    // `greet-len` calls the imported `greet` with "ab" and returns the length
    // of the result the host produced — proving the host string was lowered
    // into guest memory through the guest's realloc.
    assertEq(fn(c, "greet-len")(), "hello ab".length);
  },
});

Deno.test({
  name: "imports: a missing instance leaf fails at instantiate, not at call",
  ignore: shimWasm === null,
  fn: async () => {
    let error: unknown;
    try {
      await instantiate("imports", {
        "log": () => {},
        "host:api/math": { add: (a: unknown) => a }, // `greet` missing
      });
    } catch (e) {
      error = e;
    }
    assertEq(error instanceof PlanError, true, `got ${error}`);
    assertEq(
      String(error).includes("host:api/math/greet"),
      true,
      `message should name the full import path: ${error}`,
    );
  },
});

Deno.test({
  name: "imports: an entirely missing import is reported by name",
  ignore: shimWasm === null,
  fn: async () => {
    let error: unknown;
    try {
      await instantiate("imports", { "log": () => {} });
    } catch (e) {
      error = e;
    }
    assertEq(error instanceof PlanError, true, `got ${error}`);
    assertEq(String(error).includes("host:api/math"), true, `${error}`);
  },
});

// ---------------------------------------------------------------------------
// Imported resource types
// ---------------------------------------------------------------------------

Deno.test({
  name: "imported resources: own in, borrow out, host dtor on guest drop",
  ignore: shimWasm === null,
  fn: async () => {
    const dropped: number[] = [];
    const live = new Set<number>();
    let next = 100;

    const c = await instantiate("imported-resource", {
      "host:api/res": {
        // The resource *type*: identity lives in this object, and its dtor is
        // what runs when the guest drops a handle it owns.
        R: hostResourceType({
          name: "R",
          dtor: (rep) => {
            dropped.push(rep);
            live.delete(rep);
          },
        }),
        // own/borrow are raw reps at the cabi v1 host boundary.
        make: (v: unknown) => {
          const rep = next++;
          live.add(rep);
          return rep + (v as number) * 0; // rep identifies the resource
        },
        value: (rep: unknown) => (rep as number) - 100,
      },
    });

    // make -> borrow -> drop inside one guest call.
    assertEq(fn(c, "roundtrip")(7), 0); // rep 100 -> value 0
    assertEq(dropped, [100]);

    // A handle the guest keeps is not dropped until it says so.
    const handle = fn(c, "make-and-keep")(0) as number;
    assertEq(dropped.length, 1);
    fn(c, "drop-handle")(handle);
    assertEq(dropped, [100, 101]);
  },
});

Deno.test({
  name: "imported resources: the host must supply a HostResourceType",
  ignore: shimWasm === null,
  fn: async () => {
    let error: unknown;
    try {
      await instantiate("imported-resource", {
        "host:api/res": {
          R: {}, // a plain object is not a resource type
          make: () => 1,
          value: () => 1,
        },
      });
    } catch (e) {
      error = e;
    }
    assertEq(error instanceof PlanError, true, `got ${error}`);
    assertEq(String(error).includes("HostResourceType"), true, `${error}`);
  },
});

Deno.test({
  name: "imported resources: ResourceIndex counts imports first",
  ignore: shimWasm === null,
  fn: async () => {
    // Regression guard for the `importedResources` field (contracts/plan-format.md schema): the component's
    // single resource table refers to ResourceIndex 0, which is the *imported*
    // resource. An executor that read it as DefinedResourceIndex 0 would bind
    // the table to a resource this component never defines.
    const bytes = (await readIfPresent(
      "crates/translator-shim/testdata/imported-resource.wasm",
    ))!;
    const { plan } = translator!.translate(bytes);
    assertEq(plan.importedResources?.length, 1);
    assertEq(plan.resourceTables.length, 1);
    const table = plan.resourceTables[0];
    assertEq(table.kind, "concrete");
    assertEq(table.kind === "concrete" ? table.resource : -1, 0);
    assertEq(
      plan.initializers.some((i) => i.op === "resource"),
      false,
      "this component defines no resources",
    );
  },
});


// ---------------------------------------------------------------------------
// Re-lending a borrow across three components
// ---------------------------------------------------------------------------

Deno.test({
  name: "relend: a borrow handle can be lent onward and is released on return",
  ignore: shimWasm === null,
  fn: async () => {
    // $App --borrow--> $Mid --borrow--> $Def. $Mid does not implement the
    // resource, so it holds a real borrow *handle* and lending it on is a
    // re-lend (definitions.py `lift_borrow` -> `add_lender`, no own check).
    const c = await instantiate("relend-borrow", {});

    // The chain returns the rep the defining component sees (0x41 for the
    // first resource made), and the final `resource.drop` in `run` only
    // succeeds if every lend was released when its call returned.
    assertEq(fn(c, "run")(), 0x41);
    assertEq(fn(c, "live")(), 0);
  },
});

Deno.test({
  name: "relend: own transfer of an already-lent handle traps",
  ignore: shimWasm === null,
  fn: async () => {
    const c = await instantiate("relend-borrow", {});
    let error: unknown;
    try {
      fn(c, "lend-trap")();
    } catch (e) {
      error = e;
    }
    assertEq(
      String(error).includes("while borrowed"),
      true,
      `expected a lend trap, got: ${error}`,
    );
    // The trap escaped a FACT sync-call bracket mid-argument-translation, so
    // the entered instance is now poisoned — polyengine's per-instance corpse
    // divergence, which `test/async/builtin-trap-poisons-instance.wast`
    // pins by requiring the next call to be refused.
    assertEq(
      String(catchOf(() => fn(c, "run")())).includes(
        "cannot enter component instance",
      ),
      true,
      "the trapped instance must be poisoned",
    );
    // Exactly one instance is poisoned. The other two components in this
    // three-component fixture were never entered by the trapping call, and
    // the host-boundary unwind keeps their bookkeeping clean: `may_leave`
    // restored and the shared sync-call scope stack emptied (see `unwind` in
    // exec/boundary.ts — that hygiene is still load-bearing for *siblings*
    // even though the entered instance is now poisoned).
    const poisoned = c.componentInstances.filter((i) =>
      i && isInstancePoisoned(i)
    );
    assertEq(poisoned.length, 1);
    for (const i of c.componentInstances) {
      if (i && !isInstancePoisoned(i)) assertEq(i.mayLeave, true);
    }
    // A fresh instantiation is unaffected and runs the success path.
    const c2 = await instantiate("relend-borrow", {});
    assertEq(fn(c2, "run")(), 0x41);
  },
});

/** Run `f` and return whatever it threw (or undefined). */
function catchOf(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
}

Deno.test({
  name: "relend: a trap two adapter hops down keeps its specific message",
  ignore: shimWasm === null,
  fn: async () => {
    // `nested-trap` makes $Mid lend a handle index that was never allocated,
    // so the trap is raised inside the $Mid -> $Def adapter and must survive
    // *two* FACT exception barriers ($Mid->$Def, then $App->$Mid). Without
    // the pending-trap hand-off the outer barrier reports the generic
    // "uncaught exception propagated out of component" instead.
    const c = await instantiate("relend-borrow", {});
    let error: unknown;
    try {
      fn(c, "nested-trap")();
    } catch (e) {
      error = e;
    }
    assertEq(
      String(error).includes("table index out of range"),
      true,
      `specific trap message should survive both barriers, got: ${error}`,
    );
  },
});

Deno.test({
  name: "relend: a borrowed handle is lendable and blocks drop while lent",
  fn: () => {
    // Unit-level statement of the rule the e2e fixture exercises, straight
    // from definitions.py: `Subtask.add_lender` (line 890) has no `own`
    // check, and `canon_resource_drop` (line 2325) traps on
    // `num_lends != 0` for borrowed handles just as for owning ones.
    const rt = { impl: null, dtor: null };
    const borrowed = new ResourceHandle(
      rt as never,
      0x41,
      /* own */ false,
      null,
    );
    const scope = new SyncCallScope();
    scope.addLender(borrowed); // must not throw for a non-owning handle
    assertEq(borrowed.numLends, 1);
    scope.releaseLenders();
    assertEq(borrowed.numLends, 0);
  },
});


// ---------------------------------------------------------------------------
// Cross-encoding strings (FACT Transcoder trampoline)
// ---------------------------------------------------------------------------

Deno.test({
  name: "transcode: a utf16 caller reaching a utf8 callee converts in flight",
  ignore: shimWasm === null,
  fn: async () => {
    // The two inner components disagree on `string-encoding`, so FACT routes
    // the argument through a `Transcoder` trampoline
    // (runtime/src/intrinsics/transcode.ts, op "utf16-to-utf8"). The callee
    // returns the byte length the string occupies in *its* memory. The
    // caller sends "h\u00e9": 2 utf16 code units, 3 utf8 bytes — so the
    // result distinguishes a real conversion from a straight copy.
    const c = await instantiate("transcode", {});
    assertEq(fn(c, "run")(), 3);
  },
});

// ---------------------------------------------------------------------------
// HOST-MEDIATED REENTRANCE IS VALID (CM#705)
// ---------------------------------------------------------------------------

Deno.test({
  name: "reentrance: a host import may synchronously re-enter its own instance",
  ignore: shimWasm === null,
  fn: async () => {
    // Host calls `run`; `run` calls the host import `log`; the host handler
    // synchronously calls `run` on the SAME instance again.
    //
    // Reference (definitions.py @ 2f13265): `Store.lift` runs
    // `canon_lift` with no gate, `may_enter`/`entering_set`/`enter_from`/
    // `leave_to` do not exist, and nesting host entries is simply legal.
    // Both calls complete.
    const logged: number[] = [];
    let depth = 0;
    let inner: number | undefined;
    const c: { exports: Record<string, unknown> } = await instantiate("imports", {
      "log": (x: unknown) => {
        logged.push(x as number);
        if (depth === 0) {
          depth = 1;
          // Re-entry into the live instance, host-mediated.
          inner = fn(c, "run")(10, 20) as number;
        }
      },
      "host:api/math": {
        add: (a: unknown, b: unknown) => (a as number) + (b as number),
        greet: (who: unknown) => `Hello, ${who as string}!`,
      },
    });

    const outer = fn(c, "run")(1, 2) as number;
    assertEq(outer, 3, "the outer call completed");
    assertEq(inner, 30, "and so did the re-entrant inner call");
    assertEq(logged.join(","), "3,30", "both activations reached the import");
  },
});
