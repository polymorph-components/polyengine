import {
  runChild,
  validateWorkerResult,
} from "../../tools/wasmtime/subprocess.ts";

const canRun =
  (await Deno.permissions.query({ name: "run" })).state === "granted";

Deno.test({
  name: "subprocess timeout kills and reaps the child",
  ignore: !canRun,
  fn: async () => {
    const started = performance.now();
    const outcome = await runChild(
      new Deno.Command(Deno.execPath(), {
        args: ["eval", "setTimeout(() => {}, 10000)"],
        stdout: "piped",
        stderr: "piped",
      }),
      25,
    );
    if (outcome !== "timeout") throw new Error("child did not time out");
    if (performance.now() - started > 2_000) {
      throw new Error("child was not reaped");
    }
  },
});

Deno.test("malformed worker result is rejected", () => {
  const doc = {
    source_filename: "x.wast",
    commands: [{ line: 1, type: "module" }],
  };
  if (
    validateWorkerResult(doc, { source: "x.wast", results: [] }) === undefined
  ) throw new Error("missing command accepted");
  if (
    validateWorkerResult(doc, {
      source: "other",
      results: [{ line: 1, type: "module" }],
    }) === undefined
  ) throw new Error("wrong provenance accepted");
  if (
    validateWorkerResult(doc, {
      source: "x.wast",
      results: [{ line: 1, type: "module", status: "mystery" }],
    }) === undefined
  ) throw new Error("unknown status accepted");
  if (
    validateWorkerResult(doc, {
      source: "x.wast",
      results: [{ line: 1, type: "module", status: "skipped", reason: 7 }],
    }) === undefined
  ) throw new Error("malformed skip reason accepted");
  if (
    validateWorkerResult(doc, {
      source: "x.wast",
      results: [{ line: 1, type: "module", status: "failed", detail: {} }],
    }) === undefined
  ) throw new Error("malformed detail accepted");
});
