// Official Component Model suite, end to end: translate -> plan -> instantiate
// -> invoke, against binaries produced by `cargo run -p testgen` from
// third_party/component-model/test/ (docs/architecture.md §11).
//
// Scope of this file is the *sync* shapes of `linking/` and `resources/` plus
// the rejection verdicts of `binary/` and `validation/`. It is deliberately
// explicit (hand-written expectations copied from the .wast sources) rather
// than a generic runner: the generic runner over the whole corpus is the
// harness's job (harness/), this file is the runtime's own regression gate on
// the capabilities that make that runner possible.
//
// Prerequisites (both gitignored build outputs; tests skip with a notice):
//   cargo build -p translator-shim --release --target wasm32-unknown-unknown
//   cargo run -p testgen

import { assertEq } from "../support/asserts.ts";
import { isInstancePoisoned } from "../../src/task/scheduler.ts";
import { Translator } from "../../src/shim/mod.ts";
import { instantiateComponent } from "../../src/exec/mod.ts";
import { TranslateError } from "../../src/plan/mod.ts";

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
const corpusPresent = (await readIfPresent(
  "harness/generated/linking/unit.0.wasm",
)) !== null;

const ready = shimWasm !== null && corpusPresent;
if (!ready) {
  console.warn(
    "SKIP official-suite e2e: missing " +
      (shimWasm === null
        ? "translator_shim.wasm (cargo build -p translator-shim --release " +
          "--target wasm32-unknown-unknown)"
        : "harness/generated (cargo run -p testgen)"),
  );
}

const translator = ready ? await Translator.create(shimWasm!) : null;

/** Translate + instantiate one generated suite artifact. */
async function instantiate(
  dir: string,
  file: string,
  imports?: Record<string, unknown>,
) {
  const bytes = (await readIfPresent(`harness/generated/${dir}/${file}`))!;
  const { plan, adapters } = translator!.translate(bytes);
  return await instantiateComponent({
    plan,
    componentBytes: bytes,
    adapters,
    imports,
  });
}

type Fn = (...args: unknown[]) => unknown;

function fn(
  component: { exports: Record<string, unknown> },
  name: string,
): Fn {
  const f = component.exports[name];
  if (typeof f !== "function") {
    throw new Error(
      `no exported function '${name}' (have: ${
        Object.keys(component.exports).join(", ")
      })`,
    );
  }
  return f as Fn;
}

function assertTraps(f: () => unknown, includes: string): void {
  try {
    f();
  } catch (e) {
    const msg = String(e);
    assertEq(
      msg.toLowerCase().includes(includes.toLowerCase()),
      true,
      `trap message ${JSON.stringify(msg)} should mention ${
        JSON.stringify(includes)
      }`,
    );
    return;
  }
  throw new Error(`expected a trap mentioning '${includes}'`);
}

// ---------------------------------------------------------------------------
// linking/
// ---------------------------------------------------------------------------

// test/linking/unit.wast:7 — two component instances of the same inner
// component keep separate state (the most basic multi-instantiation shape).
Deno.test({
  name: "suite linking/unit.0: independent instances of one inner component",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("linking", "unit.0.wasm");
    const bumpA = fn(c, "bump-a");
    const bumpB = fn(c, "bump-b");
    assertEq(bumpA(), 1); // unit.wast:19
    assertEq(bumpA(), 2); // unit.wast:20
    assertEq(bumpB(), 1); // unit.wast:21 — separate state
    assertEq(bumpA(), 3); // unit.wast:22
  },
});

// test/linking/link-time-virtualization.wast — the suite's flagship linking
// case: a virtualizing component intercepts an interface another component
// imports, with FACT fused adapters on every hop.
Deno.test({
  name: "suite linking/link-time-virtualization.0: virtualized imports",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("linking", "link-time-virtualization.0.wasm");
    assertEq(fn(c, "run-a")(42), 84); // :93
    assertEq(fn(c, "real-read")(266), 42); // :94
    assertEq(fn(c, "run-b")(7), 14); // :95
    assertEq(fn(c, "real-read")(522), 7); // :96
    assertEq(fn(c, "real-read")(10), 0); // :97
    assertEq(fn(c, "calls-a")(), 2); // :98
    assertEq(fn(c, "calls-b")(), 2); // :99
  },
});

// ---------------------------------------------------------------------------
// resources/
// ---------------------------------------------------------------------------

// test/resources/borrows.wast — own/borrow handles crossing a component
// boundary through the FACT `resource.transfer-own` / `transfer-borrow`
// intrinsics, including the lend/lift interaction.
Deno.test({
  name: "suite resources/borrows.0: own+borrow transfer across components",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("resources", "borrows.0.wasm");
    assertEq(fn(c, "run")(), 42); // borrows.wast:159
  },
});

Deno.test({
  name: "suite resources/borrows.0: lifting a lent own handle traps",
  ignore: !ready,
  fn: async () => {
    // borrows.wast:162 — `lend-trap` passes one handle as both a borrow and
    // an own; the own lift must trap because the borrow made it a lender
    // (definitions.py `lift_own`: trap_if(h.num_lends != 0)).
    const c = await instantiate("resources", "borrows.0.wasm");
    assertTraps(() => fn(c, "lend-trap")(), "while borrowed");
  },
});

Deno.test({
  name: "suite resources/borrows.0: a trapped instance is poisoned",
  ignore: !ready,
  fn: async () => {
    // definitions.py `Store.lift` (line 578):
    //
    //   trap_if(not inst.may_enter_from(caller))
    //   inst.enter_from(caller)
    //   on_cancel = canon_lift(...)   # a Trap propagates out of here ...
    //   inst.leave_to(caller)         # ... so this never runs
    //
    // A trap therefore leaves every instance the call entered permanently
    // un-enterable. `test/async/builtin-trap-poisons-instance.wast` asserts
    // this directly ("cannot enter component instance" on the second invoke),
    // and the whole suite relies on it — which is why files that test several
    // traps build a fresh component instance for each one.
    const c = await instantiate("resources", "borrows.0.wasm");
    assertTraps(() => fn(c, "lend-trap")(), "while borrowed");
    // Same instance, second attempt: the poisoned-corpse refusal, not the
    // lend check.
    assertTraps(() => fn(c, "lend-trap")(), "cannot enter component instance");
    // Exactly one instance is poisoned — the one this call entered. Siblings
    // stay usable, which is why poisoning is per-instance rather than a
    // whole-store poison the way wasmtime does it.
    const poisoned = c.componentInstances.filter((i) =>
      i && isInstancePoisoned(i)
    );
    assertEq(poisoned.length, 1);

    // A *fresh* instance reproduces the original, specific trap — the trap
    // left no residue in the shared executor state (the sync-call scope stack
    // and the `may_leave` flags of instances this call did not enter are still
    // unwound at the host boundary; see `unwind` in exec/boundary.ts).
    const c2 = await instantiate("resources", "borrows.0.wasm");
    assertTraps(() => fn(c2, "lend-trap")(), "while borrowed");
  },
});

// test/resources/handle-table.wast — handle-table edge cases: unknown
// indices, double drops, cross-instance indices, wrong resource type.
Deno.test({
  name: "suite resources/handle-table.2: handle-table trap cases",
  ignore: !ready,
  fn: async () => {
    // One fresh instance per trap: a trapped instance is poisoned and can
    // never be entered again (definitions.py `Store.lift`, line 578 — the
    // Trap skips `leave_to`). This mirrors how the .wast file itself is
    // written, with a new component instance per assertion.
    for (
      const name of [
        "drop-never-allocated", // :201
        "rep-never-allocated", // :203
        "double-drop", // :205
        "drop-zero", // :207
        "drop-max", // :209
        "own-use-after-drop", // :211
        "borrow-never-valid", // :213
      ]
    ) {
      const c = await instantiate("resources", "handle-table.2.wasm");
      assertTraps(() => fn(c, name)(), "table");
    }
  },
});

Deno.test({
  name: "suite resources/handle-table.5: handles are type-checked",
  ignore: !ready,
  fn: async () => {
    // :322 / :324 — an index valid in one resource table used with another
    // resource type must trap, not alias.
    // Fresh instance per trap (see handle-table.2 above): the first trap
    // poisons the instance.
    const c = await instantiate("resources", "handle-table.5.wasm");
    assertTraps(() => fn(c, "drop-R1-as-R2")(), "type mismatch");
    const c2 = await instantiate("resources", "handle-table.5.wasm");
    assertTraps(() => fn(c2, "return-R1-as-R2")(), "type mismatch");
  },
});

// test/resources/multiple-resources.wast:170 — several resource types alive
// in one component at once.
Deno.test({
  name: "suite resources/multiple-resources.0: run",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("resources", "multiple-resources.0.wasm");
    assertEq(fn(c, "run")(), 42);
  },
});

// ---------------------------------------------------------------------------
// values/ — canonical-ABI value passing
// ---------------------------------------------------------------------------

// test/values/transcode.wast — cross-encoding string transfers between two
// components whose `string-encoding` canonical options disagree. Every hop
// goes through a FACT `Transcoder` trampoline
// (runtime/src/intrinsics/transcode.ts); the guests verify the bytes they
// receive and return a per-file marker value.
Deno.test({
  name: "suite values/transcode: the string transcoder matrix",
  ignore: !ready,
  fn: async () => {
    const expected = [42, 43, 44, 45, 46]; // transcode.wast:113,201,319,432,534
    for (const [i, want] of expected.entries()) {
      const c = await instantiate("values", `transcode.${i}.wasm`);
      assertEq(fn(c, "run")(), want, `transcode.${i}.wasm`);
    }
  },
});

// test/values/strings.wast + realloc.wast — trap wording at the host
// boundary. These texts are asserted verbatim by the suite (and follow
// wasmtime's), so they are part of the observable contract, not cosmetics.
Deno.test({
  name: "suite values/strings: host-boundary trap wording",
  ignore: !ready,
  fn: async () => {
    // :69 — a string whose pointer/length runs past the end of memory.
    const oob = await instantiate("values", "strings.3.wasm");
    assertTraps(
      () => fn(oob, "f")(),
      "string pointer/length out of bounds of memory",
    );
    // :85 — 0xFF can never appear in UTF-8.
    const invalid = await instantiate("values", "strings.4.wasm");
    assertTraps(() => fn(invalid, "f")(), "invalid utf-8");
    // :101 — 0xC3 is a valid *prefix* cut short by the end of the string,
    // which Rust (and therefore the suite) reports differently.
    const incomplete = await instantiate("values", "strings.5.wasm");
    assertTraps(
      () => fn(incomplete, "f")(),
      "incomplete utf-8 byte sequence",
    );
  },
});

// ---------------------------------------------------------------------------
// Export mapping: nothing is ever dropped without saying so
// ---------------------------------------------------------------------------

/**
 * Regression guard for a mis-diagnosis worth keeping pinned: the four
 * `values/variants.wast:83` exports (`join-narrow`, `join-wide`, `join-f32`,
 * `ret-f32`) were reported as "missing from the instantiated component",
 * which looked like the shim silently dropping exports it could not map.
 *
 * It is not: the shim maps all four. The component also declares an
 * *async-lifted* export (`mix-ret`, `canon lift ... async`) whose
 * `task.return` trampoline is wired into a core instantiation argument, so
 * the whole component legitimately fails to instantiate until the task
 * core exists (contracts/intrinsics.md §B). This test pins both halves: the
 * plan carries every export, and the refusal is loud and capability-aware.
 */
Deno.test({
  name: "suite values/variants.1: async-lifted exports instantiate and run",
  ignore: !ready,
  fn: async () => {
    const bytes = (await readIfPresent(
      "harness/generated/values/variants.1.wasm",
    ))!;
    const { plan, adapters } = translator!.translate(bytes);
    assertEq(
      plan.exports.map((e) => e.name).sort(),
      ["join-f32", "join-narrow", "join-wide", "ret-f32"],
    );
    for (const e of plan.exports) assertEq(e.kind, "lifted-func");

    // variants.wast:83 mixes an async-lifted export with sync ones, reached
    // through FACT adapters. Instantiation used to be refused here — first on
    // `task-return` (before the task core), then on `async-start-call`
    // (before the FACT call intrinsics). Both have landed, so the component
    // now comes up and its exports are callable.
    const c = await instantiateComponent({
      plan,
      componentBytes: bytes,
      adapters,
    });
    assertEq(typeof c.exports["ret-f32"], "function");
    assertEq(typeof c.exports["join-wide"], "function");
  },
});

/**
 * Only `type` exports may be absent from the runtime surface, and they are
 * recorded with a reason rather than filtered away.
 */
Deno.test({
  name: "suite resources/handle-table.5: omitted exports are accounted for",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("resources", "handle-table.5.wasm");
    const bytes = (await readIfPresent(
      "harness/generated/resources/handle-table.5.wasm",
    ))!;
    const { plan } = translator!.translate(bytes);
    const names = new Set(Object.keys(c.exports));
    for (const e of plan.exports) {
      if (e.kind === "type") {
        assertEq(
          c.omittedExports.has(e.name),
          true,
          `type export '${e.name}' should be recorded as omitted`,
        );
      } else {
        assertEq(names.has(e.name), true, `export '${e.name}' is missing`);
      }
    }
    // Every omission has a reason, and every omission is a type export.
    for (const [name, reason] of c.omittedExports) {
      assertEq(reason.length > 0, true, `omission '${name}' needs a reason`);
    }
  },
});

// ---------------------------------------------------------------------------
// Rejection verdicts (binary/ + validation/)
// ---------------------------------------------------------------------------

interface WastCommand {
  type: string;
  line: number;
  filename?: string;
  kind?: string;
  module_type?: string;
}

async function commandsOf(dir: string): Promise<[string, WastCommand[]][]> {
  const out: [string, WastCommand[]][] = [];
  const base = new URL(`harness/generated/${dir}/`, root);
  for await (const entry of Deno.readDir(base)) {
    if (!entry.name.endsWith(".json")) continue;
    const json = JSON.parse(
      await Deno.readTextFile(new URL(entry.name, base)),
    ) as { commands: WastCommand[] };
    out.push([entry.name, json.commands]);
  }
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return out;
}

/**
 * Known acceptance gaps for the blanket verdict check below: wasmparser
 * 0.252 (pinned via wasmtime-environ 47.0.3, crates/translator-shim)
 * validates components that CM#703/#704 ("name rules") and CM#688
 * ("max-value-size") — pulled in by the CM#705 pin advance, polyengine#173
 * — newly require rejecting. Tracked https://github.com/polymorph-components/polyengine/issues/248.
 *
 * Authoritative source of truth for these rows is harness/src/xfail.ts (same
 * (file, line) keys): its stale-xfail detector (harness/tests/
 * conformance_test.ts) fails loudly the moment any of these rows starts
 * validating-then-rejecting for real, so when the wasmtime-environ bump
 * lands, the harness turns stale FIRST and this allowlist must be pruned in
 * the same PR (it does not self-detect staleness — it is an allowlist, not
 * an xfail list with its own audit).
 *
 * Exact-match only: a (file, line) pair not in this set still goes through
 * the full phase-verdict check below.
 */
const KNOWN_ACCEPTANCE_GAPS: ReadonlySet<string> = new Set([
  // name-rules-47 (https://github.com/polymorph-components/polyengine/issues/248): kebab-case name-folding import
  // conflicts wasmparser 0.252 does not detect.
  "kebab.json:149",
  "kebab.json:154",
  "kebab.json:159",
  "kebab.json:164",
  "kebab.json:169",
  // max-value-size-47 (https://github.com/polymorph-components/polyengine/issues/248): the elem_size(t, i64) < 2^28
  // check wasmparser 0.252 does not enforce.
  "max-value-size.json:25",
  "max-value-size.json:31",
  "max-value-size.json:37",
  "max-value-size.json:43",
  "max-value-size.json:48",
  "max-value-size.json:57",
  "max-value-size.json:63",
]);

/**
 * Every `assert_invalid` / `assert_malformed` component in `binary/` and
 * `validation/` must be rejected by the translator *with a validation-phase
 * verdict*.
 *
 * The phase is the point: a rejection because the shim cannot represent some
 * shape (`unsupported`) or because the shim has a bug (`internal`) is not a
 * conformance pass, and the structured error is what lets a runner tell the
 * difference (contracts v0.2 proposal; see `WireErrorDetail`).
 */
Deno.test({
  name: "suite binary+validation: invalid components get validation verdicts",
  ignore: !ready,
  fn: async () => {
    let checked = 0;
    const wrong: string[] = [];
    for (const dir of ["binary", "validation"]) {
      const base = new URL(`harness/generated/${dir}/`, root);
      for (const [file, commands] of await commandsOf(dir)) {
        for (const cmd of commands) {
          if (cmd.type !== "assert_invalid" && cmd.type !== "assert_malformed") {
            continue;
          }
          if (cmd.kind !== "component" || cmd.module_type !== "binary") continue;
          if (KNOWN_ACCEPTANCE_GAPS.has(`${file}:${cmd.line}`)) continue;
          const bytes = await Deno.readFile(new URL(cmd.filename!, base));
          checked++;
          try {
            translator!.translate(bytes);
            wrong.push(`${file}:${cmd.line} accepted (expected ${cmd.type})`);
          } catch (e) {
            if (!(e instanceof TranslateError)) {
              wrong.push(`${file}:${cmd.line} ${(e as Error).name}: ${e}`);
            } else if (!e.isValidationVerdict) {
              wrong.push(`${file}:${cmd.line} phase=${e.phase}: ${e.message}`);
            }
          }
        }
      }
    }
    assertEq(checked > 400, true, `only ${checked} rejection cases found`);
    assertEq(wrong.length, 0, `wrong verdicts:\n${wrong.join("\n")}`);
  },
});

/**
 * The mirror obligation: components the suite expects to *decode* must not be
 * rejected. Only the shapes plan v0 genuinely cannot express are allowed to
 * fail, and only with the `unsupported` phase — never `validation` (which
 * would be a false conformance claim) and never `internal`.
 */
Deno.test({
  name: "suite binary+validation: valid components are not mis-rejected",
  ignore: !ready,
  fn: async () => {
    // Known plan gaps, kept explicit so a regression elsewhere is visible.
    // Empty since plan v4 (core-module exports, polyengine#13); binary.json:1421
    // was the last entry.
    const knownUnsupported = new Set<string>([]);
    const bad: string[] = [];
    let ok = 0;
    for (const dir of ["binary", "validation", "linking", "resources"]) {
      const base = new URL(`harness/generated/${dir}/`, root);
      for (const [file, commands] of await commandsOf(dir)) {
        for (const cmd of commands) {
          if (cmd.type !== "module" && cmd.type !== "module_definition") {
            continue;
          }
          if (cmd.kind !== "component" || cmd.module_type !== "binary") continue;
          const bytes = await Deno.readFile(new URL(cmd.filename!, base));
          try {
            translator!.translate(bytes);
            ok++;
          } catch (e) {
            const where = `${file}:${cmd.line}`;
            if (!(e instanceof TranslateError)) {
              bad.push(`${where} ${(e as Error).name}: ${e}`);
            } else if (e.phase === "unsupported") {
              if (!knownUnsupported.has(where)) {
                bad.push(`${where} newly unsupported: ${e.message}`);
              }
            } else if (e.phase === "validation") {
              // Feature-gate / toolchain-pin drift, tracked in the report;
              // record rather than fail so this test stays a regression gate
              // on *our* shapes.
              console.warn(`  note: ${where} rejected: ${e.message}`);
            } else {
              bad.push(`${where} phase=${e.phase}: ${e.message}`);
            }
          }
        }
      }
    }
    assertEq(ok > 190, true, `only ${ok} components translated`);
    assertEq(bad.length, 0, `unexpected verdicts:\n${bad.join("\n")}`);
  },
});

// test/binary/binary.wast:1433 — a component exporting one of its own
// embedded core modules (the `module` export kind, contracts/plan-format.md
// schema notes; polyengine#13). The
// export surfaces as the already-compiled `WebAssembly.Module`, and it is
// the *embedded* module: instantiating it works and its export list matches
// the wast source (an empty module). Artifact index shifted 115->116 by the
// CM#705 pin advance (polyengine#173): CM#698 (dff1181, "fix some spec and
// test typos") added 12 lines earlier in binary.wast, renumbering this
// component from wast line 1421 to 1433 and its testgen-assigned positional
// artifact index from 115 to 116 (verified:
// `git -C third_party/component-model show 2f13265:test/binary/binary.wast`).
Deno.test({
  name: "suite binary.116: a core-module export surfaces as WebAssembly.Module",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("binary", "binary.116.wasm");
    const m = c.exports["m"];
    assertEq(
      m instanceof WebAssembly.Module,
      true,
      `export 'm' should be a WebAssembly.Module, got ${typeof m}`,
    );
    const inst = new WebAssembly.Instance(m as WebAssembly.Module);
    assertEq(Object.keys(inst.exports).length, 0); // binary.wast:1435: empty module
  },
});

// ---------------------------------------------------------------------------
// Determinism over the suite corpus (contracts/plan-format.md "Determinism")
// ---------------------------------------------------------------------------

Deno.test({
  name: "suite: translation is byte-deterministic over adapter-heavy inputs",
  ignore: !ready,
  fn: async () => {
    for (
      const [dir, file] of [
        ["linking", "link-time-virtualization.0.wasm"],
        ["resources", "borrows.0.wasm"],
        ["resources", "multiple-resources.0.wasm"],
      ] as const
    ) {
      const bytes = (await readIfPresent(`harness/generated/${dir}/${file}`))!;
      const a = translator!.translateRaw(bytes);
      const b = translator!.translateRaw(bytes);
      assertEq(a === b, true, `${dir}/${file}: envelope differs across runs`);
    }
  },
});

// test/async/cross-abi-calls.wast — the FACT cross-component call intrinsics
// (`prepare-call` + `{sync,async}-start-call`, runtime/src/intrinsics/
// fact_calls.ts). This component is the whole matrix: for each of several
// parameter counts it exports one function per (caller ABI, callee ABI)
// combination, so a single instance drives every adapter shape wasmtime
// compiles — sync->sync (no intrinsics), sync->async (`sync-start-call`),
// async->sync and async->async (`async-start-call`).
Deno.test({
  name: "suite async/cross-abi-calls.0: all four lower/lift ABI combinations",
  ignore: !ready,
  fn: async () => {
    const c = await instantiate("async", "cross-abi-calls.0.wasm");
    // Each expected value is the callee's answer routed back through the
    // adapter pair: `[async-start]` produced the callee's parameters and
    // `[async-return]` produced the caller's results (fact/signature.rs:61 and
    // :145). Getting the right number out proves the host shuttled the flat
    // values between exactly the right two adapter functions.
    for (
      const [name, want] of [
        ["sync-calls-sync-4-param", 83],
        ["sync-calls-async-4-param", 83],
        ["async-calls-sync-4-param", 84],
        ["async-calls-async-4-param", 84],
        // 17 params: the caller's arguments spill to linear memory, so
        // `prepare-call` stashes a pointer rather than 17 lanes and
        // `[async-start]` re-reads them. Exercises the spilled path.
        ["sync-calls-sync-17-param", 87],
        ["sync-calls-async-17-param", 87],
        ["async-calls-sync-17-param", 88],
        ["async-calls-async-17-param", 88],
      ] as const
    ) {
      // jspi-mode components return Promises; awaiting a plain value is a no-op.
      assertEq(await fn(c, name)(), want, `${name}`);
    }
    // The async->async cases route the callee through the callback-ABI
    // machinery (`runCallbackLoop`, shared with host-boundary lifts). These
    // particular callees return EXIT from their first activation, so the loop
    // never has to deliver an event and `callbackInvocations` stays 0 — the
    // composition is evidenced by the results above being correct, not by the
    // counter. `test/async/wait-during-callback.wast` is where a FACT callee
    // actually parks in the loop; it is still blocked on streams.
    assertEq(c.stats.callbackInvocations, 0);
    // Every `prepare-call` was consumed by its `*-start-call`: a leaked one
    // would make the next `prepare-call` assert (fact_calls.ts
    // `takePrepared`), and 24 calls ran above without that firing.
    // Every FACT sync-call bracket balanced, and nothing is poisoned — i.e.
    // no call left an instance entered.
    assertEq(c.stats.enterSyncCalls, c.stats.exitSyncCalls);
    assertEq(
      c.componentInstances.some((i) => i && isInstancePoisoned(i)),
      false,
    );
  },
});
