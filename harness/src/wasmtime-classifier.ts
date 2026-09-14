import type { CommandResult } from "./runner.ts";
import {
  expectedWasmtimeFailure,
  expectedWasmtimeSkip,
  WASMTIME_EXPECTATIONS,
  WASMTIME_SKIP_EXPECTATIONS,
} from "./wasmtime-expectations.ts";

export type Classified =
  | { status: "passed" }
  | { status: "known-failure"; class: string }
  | { status: "skip"; class: string }
  | { status: "unexpected"; detail: string };

export function classify(file: string, result: CommandResult): Classified {
  if (result.status === "passed") {
    if (
      WASMTIME_EXPECTATIONS.some((e) =>
        e.file === file && e.line === result.line
      ) || WASMTIME_SKIP_EXPECTATIONS.some((e) =>
        e.file === file && e.line === result.line
      )
    ) {
      return { status: "unexpected", detail: "stale expectation passed" };
    }
    return { status: "passed" };
  }
  if (result.status === "failed") {
    const expected = expectedWasmtimeFailure(
      file,
      result.line,
      result.detail ?? "",
    );
    return expected === undefined
      ? {
        status: "unexpected",
        detail: result.detail ?? "failure without detail",
      }
      : { status: "known-failure", class: expected.class };
  }
  const expected = expectedWasmtimeSkip(
    file,
    result.line,
    result.reason,
    result.detail ?? "",
  );
  if (expected !== undefined) {
    return { status: "skip", class: expected.class };
  }
  return {
    status: "unexpected",
    detail: `unclassified skip: ${result.detail}`,
  };
}
