export async function runChild(
  command: Deno.Command,
  timeoutMs: number,
): Promise<Deno.CommandOutput | "timeout"> {
  const child = command.spawn();
  const outputPromise = child.output();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([outputPromise, timeout]).finally(() =>
    clearTimeout(timer)
  );
  if (outcome !== "timeout") return outcome;
  try {
    child.kill("SIGKILL");
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await outputPromise;
  return "timeout";
}

export function validateWorkerResult(
  doc: {
    source_filename: string;
    commands: Array<{ line: number; type: string }>;
  },
  value: unknown,
): string | undefined {
  if (typeof value !== "object" || value === null) {
    return "worker result is not an object";
  }
  const result = value as { source?: unknown; results?: unknown };
  if (result.source !== doc.source_filename) {
    return "worker provenance mismatch";
  }
  if (!Array.isArray(result.results)) return "worker results is not an array";
  if (result.results.length !== doc.commands.length) {
    return "worker command count mismatch";
  }
  for (let i = 0; i < doc.commands.length; i++) {
    const row = result.results[i] as {
      line?: unknown;
      type?: unknown;
      status?: unknown;
      detail?: unknown;
      reason?: unknown;
    };
    if (
      typeof row !== "object" || row === null ||
      row.line !== doc.commands[i].line || row.type !== doc.commands[i].type
    ) return `worker command mismatch at index ${i}`;
    if (
      row.status !== "passed" && row.status !== "failed" &&
      row.status !== "skipped"
    ) {
      return `worker command status malformed at index ${i}`;
    }
    if (row.detail !== undefined && typeof row.detail !== "string") {
      return `worker command detail malformed at index ${i}`;
    }
    if (
      row.reason !== undefined && row.reason !== "pending-runtime" &&
      row.reason !== "pending-capability" &&
      row.reason !== "unsupported-directive"
    ) return `worker command reason malformed at index ${i}`;
    if (row.status === "skipped" && row.reason === undefined) {
      return `worker skipped command has no reason at index ${i}`;
    }
    if (row.status !== "skipped" && row.reason !== undefined) {
      return `worker non-skipped command has a reason at index ${i}`;
    }
  }
  return undefined;
}
