import { PlanError, TranslateError } from "@polyengine/runtime/plan";
import { Translator } from "@polyengine/runtime/shim";
import type { Artifact } from "../src/executor.ts";
import { runWastJson } from "../src/runner.ts";
import { RuntimeExecutor } from "../src/runtime-executor.ts";

const shim = await Deno.readFile(
  new URL(
    "../../target/wasm32-unknown-unknown/release/translator_shim.wasm",
    import.meta.url,
  ),
);
const emptyComponent = new Uint8Array([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]);

function artifact(bytes: Uint8Array<ArrayBuffer>): Artifact {
  return {
    filename: "validation.wasm",
    kind: "component",
    moduleType: "binary",
    bytes,
  };
}

async function thrown(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an exception, but returned normally");
}

async function negativeAssertions(
  executor: RuntimeExecutor,
  bytes: Uint8Array<ArrayBuffer>,
) {
  return (await runWastJson(
    {
      source_filename: "validation.wast",
      commands: (["assert_invalid", "assert_malformed"] as const).map((
        type,
        line,
      ) => ({
        type,
        line,
        filename: "validation.wasm",
        module_type: "binary",
        text: "invalid component",
      })),
    },
    () => Promise.resolve(bytes),
    executor,
  )).results;
}

Deno.test("runtime validation: valid unsupported component fails negative assertions", async () => {
  const bytes = await Deno.readFile(
    new URL(
      "fixtures/validation-imported-module.wasm",
      import.meta.url,
    ),
  );
  const translator = await Translator.create(shim);
  const error = await thrown(() => translator.translate(bytes));
  if (!(error instanceof TranslateError) || error.phase !== "unsupported") {
    throw new Error(`expected structured unsupported error, got ${error}`);
  }
  const executor = await RuntimeExecutor.create(shim);
  const propagated = await thrown(() => executor.validate(artifact(bytes)));
  if (
    !(propagated instanceof TranslateError) ||
    propagated.phase !== "unsupported"
  ) {
    throw new Error(
      `expected unsupported error to propagate, got ${propagated}`,
    );
  }
  for (const result of await negativeAssertions(executor, bytes)) {
    if (result.status !== "failed" || result.detail !== String(error)) {
      throw new Error(
        `unsupported translation satisfied ${result.type}: ${
          JSON.stringify(result)
        }`,
      );
    }
  }
});

Deno.test("runtime validation: genuine malformed component satisfies negative assertions", async () => {
  // Valid component preamble followed by an invalid section ID.
  const bytes = new Uint8Array([...emptyComponent, 0xff]);
  const translator = await Translator.create(shim);
  const error = await thrown(() => translator.translate(bytes));
  if (!(error instanceof TranslateError) || !error.isValidationVerdict) {
    throw new Error(`expected structured validation error, got ${error}`);
  }
  const executor = await RuntimeExecutor.create(shim);
  const verdict = await executor.validate(artifact(bytes));
  if (verdict.valid || verdict.error !== error.message) {
    throw new Error(
      `expected invalid verdict with translator message: ${
        JSON.stringify(verdict)
      }`,
    );
  }
  for (const result of await negativeAssertions(executor, bytes)) {
    if (result.status !== "passed") throw new Error(JSON.stringify(result));
  }
  if (!(await executor.validate(artifact(emptyComponent))).valid) {
    throw new Error("empty component should validate");
  }
});

Deno.test("runtime validation: pipeline failures propagate unchanged and fail negative assertions", async () => {
  const executor = await RuntimeExecutor.create(shim);
  const original = Translator.prototype.translate;
  try {
    for (
      const error of [
        new TranslateError({
          phase: "internal",
          message: "adapter validation failed",
        }),
        new PlanError("invalid plan"),
        new Error("unexpected translator failure"),
        { phase: "validation", isValidationVerdict: true },
        "unexpected non-Error failure",
      ]
    ) {
      Translator.prototype.translate = () => {
        throw error;
      };
      if (
        await thrown(() => executor.validate(artifact(emptyComponent))) !==
          error
      ) {
        throw new Error("pipeline failure was replaced");
      }
      for (const result of await negativeAssertions(executor, emptyComponent)) {
        if (result.status !== "failed" || result.detail !== String(error)) {
          throw new Error(
            `pipeline failure satisfied ${result.type}: ${
              JSON.stringify(result)
            }`,
          );
        }
      }
    }
  } finally {
    Translator.prototype.translate = original;
  }
});
