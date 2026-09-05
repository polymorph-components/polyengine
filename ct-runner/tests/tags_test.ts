// Feature-tag scheduling (issue #25): the tags inventory parser/scanner and
// the gated case loop, against polymorph-test's authorities —
// crates/component-test-formats/src/inventory.rs (section format),
// crates/component-test-core/src/tags.rs (applicability), and
// js/viewer/harness.mjs `runCases` (scheduling order, N/A rows, drift).
// The N/A wire shape is pinned to the embed runner's golden
// (expected/verify-pipeline-fixture.jsonl):
//   {"case":…,"status":"not-applicable","detail":"<first excluding mark>",
//    "diagnostics-complete":true}

import { assertEq } from "../../runtime/tests/support/asserts.ts";
import {
  applies,
  collectTagsSections,
  firstExcluding,
  loadTagsInventory,
  parseTagsRecords,
  TAGS_SECTION,
  tagsOf,
} from "../src/tags.ts";
import { runSuite } from "../src/mod.ts";
import {
  artifactsOfBytes,
  haveFixture,
  readArtifact,
  TEST_SUITE_WASM,
} from "./support.ts";

const ready = await haveFixture(TEST_SUITE_WASM);
const enc = new TextEncoder();

function leb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

/** Encode one custom section frame (id 0, name, data). */
function customSection(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = enc.encode(name);
  const payload = [...leb(nameBytes.length), ...nameBytes, ...data];
  return new Uint8Array([0x00, ...leb(payload.length), ...payload]);
}

/** Append a `component-test:tags@0.1` section to a wasm binary (custom
 * sections are legal anywhere after the preamble; appending is simplest). */
function withTags(bytes: Uint8Array, records: string): Uint8Array {
  const section = customSection(TAGS_SECTION, enc.encode(records));
  const out = new Uint8Array(bytes.length + section.length);
  out.set(bytes, 0);
  out.set(section, bytes.length);
  return out;
}

// --- parser ------------------------------------------------------------------

Deno.test("tags: records parse (exact + generated prefix), lookup + applies", () => {
  const inv = parseTagsRecords(enc.encode(
    "a/b/pass\n" +
      "a/b/gated hsm\n" +
      "a/b/decline !hsm\n" +
      "\n" + // blank lines skipped
      "a/gen/* slow net\n",
  ));
  assertEq(tagsOf(inv, "a/b/pass"), []);
  assertEq(tagsOf(inv, "a/b/gated"), ["hsm"]);
  assertEq(tagsOf(inv, "a/gen/tc1"), ["slow", "net"]); // prefix record
  assertEq(tagsOf(inv, "a/gen"), undefined); // prefix needs a leaf below it
  assertEq(tagsOf(inv, "a/b/unknown"), undefined); // drift, caller's problem

  // component-test-core/src/tags.rs applicability: `f` needs f present,
  // `!f` needs f missing; unmarked applies everywhere.
  assertEq(applies([], ["hsm"]), true);
  assertEq(applies(["hsm"], []), true);
  assertEq(applies(["hsm"], ["hsm"]), false);
  assertEq(applies(["!hsm"], []), false);
  assertEq(applies(["!hsm"], ["hsm"]), true);
  assertEq(applies(["slow", "net"], ["net"]), false);

  // harness.mjs `excluding`: the FIRST unsatisfied mark, as the N/A detail.
  assertEq(firstExcluding(["hsm"], ["hsm"]), "hsm");
  assertEq(firstExcluding(["!hsm"], []), "!hsm");
  assertEq(firstExcluding(["slow", "net"], ["net"]), "net");
});

Deno.test("tags: duplicate records and empty marks are rejected (inventory.rs)", () => {
  let threw = "";
  try {
    parseTagsRecords(enc.encode("a/b\na/b\n"));
  } catch (e) {
    threw = String(e);
  }
  assertEq(threw.includes("duplicate record"), true);
  try {
    parseTagsRecords(enc.encode("a/b !\n"));
  } catch (e) {
    threw = String(e);
  }
  assertEq(threw.includes("empty mark"), true);
});

// --- section scanner ---------------------------------------------------------

Deno.test("tags: scanner finds nested core-module sections and repairs newlines", () => {
  // A minimal core module carrying a tags section WITHOUT a trailing
  // newline, nested in a minimal component that carries a second section —
  // the real layout (#[link_section] puts records in the guest core
  // module) plus the concatenation/newline-repair path (inventory.rs).
  const coreCustom = customSection(TAGS_SECTION, enc.encode("m/core hsm"));
  const core = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // core preamble
    ...coreCustom,
  ]);
  const moduleSection = new Uint8Array([0x01, ...leb(core.length), ...core]);
  const componentCustom = customSection(TAGS_SECTION, enc.encode("m/comp\n"));
  const component = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00, // component preamble
    ...moduleSection,
    ...componentCustom,
  ]);

  const collected = collectTagsSections(component);
  assertEq(new TextDecoder().decode(collected!), "m/core hsm\nm/comp\n");
  const inv = parseTagsRecords(collected!);
  assertEq(tagsOf(inv, "m/core"), ["hsm"]);
  assertEq(tagsOf(inv, "m/comp"), []);

  // No section anywhere -> null (suite not built with their SDK).
  const bare = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]);
  assertEq(collectTagsSections(bare), null);
});

// --- gated runs (e2e over the example suite + synthesized inventory) ----------

const RECORDS = "suite/basic/pass\n" +
  "suite/basic/fail\n" +
  "suite/basic/skip !hw\n" +
  "suite/diag/chatty\n" +
  "suite/diag/slow hw\n" +
  "suite/nested/deep/leaf\n";

Deno.test({
  name: "tags e2e: missing feature schedules the requiring case out (N/A row exact)",
  ignore: !ready,
  fn: async () => {
    const bytes = withTags((await readArtifact(TEST_SUITE_WASM))!, RECORDS);
    const lines: string[] = [];
    const counts = await runSuite(artifactsOfBytes(bytes), {
      target: "polyengine/test",
      suiteName: "test-suite",
      missing: ["hw"],
      emit: (l) => lines.push(l),
    });
    // hw missing: diag/slow (hw) is N/A; basic/skip (!hw) APPLIES and runs
    // to its usual skipped verdict.
    assertEq(counts, {
      passed: 3,
      failed: 1,
      skipped: 1,
      na: 1,
      deselected: 0,
      selected: 6,
      total: 6,
    });

    const envelope = JSON.parse(lines[0]);
    assertEq(envelope.run.scheduling, "tags");

    const rows = lines.slice(1, -1).map((l) => JSON.parse(l));
    const na = rows.find((r) => r.status === "not-applicable");
    // The embed runner's exact N/A shape (verify-pipeline-fixture.jsonl).
    assertEq(na, {
      case: "suite/diag/slow",
      status: "not-applicable",
      detail: "hw",
      "diagnostics-complete": true,
    });
    // Suite order preserved: N/A rows are emitted in place, not batched.
    assertEq(rows.map((r) => r.case).indexOf("suite/diag/slow"), 4);
  },
});

Deno.test({
  name: "tags e2e: gating is on whenever an inventory exists (decline case N/As)",
  ignore: !ready,
  fn: async () => {
    const bytes = withTags((await readArtifact(TEST_SUITE_WASM))!, RECORDS);
    const lines: string[] = [];
    const counts = await runSuite(artifactsOfBytes(bytes), {
      target: "polyengine/test",
      suiteName: "test-suite",
      // no `missing`: the !hw decline case does not apply on a
      // fully-featured target (tags.rs polarity).
      emit: (l) => lines.push(l),
    });
    assertEq(counts, {
      passed: 4,
      failed: 1,
      skipped: 0,
      na: 1,
      deselected: 0,
      selected: 6,
      total: 6,
    });
    const na = lines.slice(1, -1).map((l) => JSON.parse(l))
      .find((r) => r.status === "not-applicable");
    assertEq(na?.case, "suite/basic/skip");
    assertEq(na?.detail, "!hw");
  },
});

Deno.test({
  name: "tags e2e: capability wins over selection (N/A outranks deselected)",
  ignore: !ready,
  fn: async () => {
    const bytes = withTags((await readArtifact(TEST_SUITE_WASM))!, RECORDS);
    const lines: string[] = [];
    const counts = await runSuite(artifactsOfBytes(bytes), {
      target: "polyengine/test",
      suiteName: "test-suite",
      missing: ["hw"],
      only: "basic/",
      emit: (l) => lines.push(l),
    });
    const rows = lines.slice(1, -1).map((l) => JSON.parse(l));
    const byCase = Object.fromEntries(rows.map((r) => [r.case, r]));
    // diag/slow (hw) is N/A even though it's outside `only: "basic/"` —
    // capability outranks selection (docs/runner-policy.md "Selection is
    // not capability").
    assertEq(byCase["suite/diag/slow"].status, "not-applicable");
    // basic/ cases execute per their usual verdicts; basic/skip (!hw)
    // APPLIES with hw missing and runs to its usual skipped verdict.
    assertEq(byCase["suite/basic/pass"].status, "pass");
    assertEq(byCase["suite/basic/fail"].status, "fail");
    assertEq(byCase["suite/basic/skip"].status, "skipped");
    // The remaining non-basic, non-excluded cases are deselected.
    assertEq(byCase["suite/diag/chatty"], {
      case: "suite/diag/chatty",
      status: "deselected",
      detail: "only basic/",
    });
    assertEq(byCase["suite/nested/deep/leaf"], {
      case: "suite/nested/deep/leaf",
      status: "deselected",
      detail: "only basic/",
    });
    assertEq(counts, {
      passed: 1,
      failed: 1,
      skipped: 1,
      na: 1,
      deselected: 2,
      selected: 3,
      total: 6,
    });
  },
});

Deno.test({
  name: "tags e2e: inventory drift (uncovered case) is unsound, throws",
  ignore: !ready,
  fn: async () => {
    const partial = RECORDS.replace("suite/basic/pass\n", "");
    const bytes = withTags((await readArtifact(TEST_SUITE_WASM))!, partial);
    let threw = "";
    try {
      await runSuite(artifactsOfBytes(bytes), {
        target: "polyengine/test",
        suiteName: "test-suite",
        emit: () => {},
      });
    } catch (e) {
      threw = String(e);
    }
    assertEq(threw.includes("inventory drift"), true);
    assertEq(threw.includes("suite/basic/pass"), true);
  },
});

Deno.test({
  name: "tags e2e: --missing without an inventory refuses (no silent feature-blind run)",
  ignore: !ready,
  fn: async () => {
    const bytes = (await readArtifact(TEST_SUITE_WASM))!; // no section
    let threw = "";
    try {
      await runSuite(artifactsOfBytes(bytes), {
        target: "polyengine/test",
        suiteName: "test-suite",
        missing: ["hw"],
        emit: () => {},
      });
    } catch (e) {
      threw = String(e);
    }
    assertEq(threw.includes("no component-test:tags@0.1 inventory"), true);
  },
});
