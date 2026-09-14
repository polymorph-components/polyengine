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

Deno.test({
  name: "worker-style final output is complete before prompt explicit exit",
  ignore: !canRun,
  fn: async () => {
    const expected = {
      source: "x.wast",
      results: [{ line: 1, type: "module", status: "passed" }],
    };
    const script = `
      const bytes = new TextEncoder().encode(JSON.stringify(${
      JSON.stringify(expected)
    }) + "\\n");
      let written = 0;
      while (written < bytes.length) written += Deno.stdout.writeSync(bytes.subarray(written));
      setInterval(() => {}, 10);
      Deno.exit(0);
    `;
    const started = performance.now();
    const outcome = await runChild(
      new Deno.Command(Deno.execPath(), {
        args: ["eval", script],
        stdout: "piped",
        stderr: "piped",
      }),
      1_000,
    );
    if (outcome === "timeout" || !outcome.success) {
      throw new Error("explicit worker exit did not complete");
    }
    if (performance.now() - started > 900) {
      throw new Error("worker did not exit promptly");
    }
    const parsed = JSON.parse(new TextDecoder().decode(outcome.stdout));
    const malformed = validateWorkerResult(
      { source_filename: "x.wast", commands: [{ line: 1, type: "module" }] },
      parsed,
    );
    if (malformed !== undefined) throw new Error(malformed);
  },
});

Deno.test({
  name: "worker failure before final output remains non-green",
  ignore: !canRun,
  fn: async () => {
    const outcome = await runChild(
      new Deno.Command(Deno.execPath(), {
        args: ["eval", 'throw new Error("worker failed before result")'],
        stdout: "piped",
        stderr: "piped",
      }),
      1_000,
    );
    if (outcome === "timeout") throw new Error("failed worker timed out");
    if (outcome.success) throw new Error("failed worker exited successfully");
    if (outcome.stdout.length !== 0) {
      throw new Error("failed worker wrote a partial result");
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
