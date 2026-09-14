import { classify } from "../../harness/src/wasmtime-classifier.ts";
import {
  WASMTIME_EXCLUSIONS,
  WASMTIME_EXPECTATIONS,
  WASMTIME_SKIP_EXPECTATIONS,
} from "../../harness/src/wasmtime-expectations.ts";
import type { FileResult } from "../../harness/src/runner.ts";
import { dirname, fromFileUrl, join } from "jsr:@std/path@1";
import { runChild, validateWorkerResult } from "./subprocess.ts";

const repo = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const generated = join(repo, "harness", "generated-wasmtime");
const manifest = JSON.parse(
  await Deno.readTextFile(join(generated, "manifest.json")),
) as { files: string[] };
const generatedMetadata = JSON.parse(
  await Deno.readTextFile(join(generated, "supplementary-metadata.json")),
) as { source_revision: string; files: unknown[] };
const reviewedMetadata = JSON.parse(
  await Deno.readTextFile(join(repo, "tools/wasmtime/metadata.json")),
) as { source_revision: string; files: unknown[] };
const reviewedFiles = (reviewedMetadata.files as Array<{ path: string }>).map((
  f,
) => f.path);
if (JSON.stringify(manifest.files) !== JSON.stringify(reviewedFiles)) {
  throw new Error("Wasmtime inventory drift");
}
if (reviewedMetadata.source_revision !== generatedMetadata.source_revision) {
  throw new Error("Wasmtime reviewed-corpus revision drift");
}
const generatedReviewedShape = {
  source_revision: generatedMetadata.source_revision,
  files:
    (generatedMetadata.files as Array<{ path: string; directives: unknown }>)
      .map((f) => ({
        path: f.path,
        directives: f.directives,
      })),
};
if (
  JSON.stringify(generatedReviewedShape) !== JSON.stringify(reviewedMetadata)
) {
  throw new Error("Wasmtime directive/source metadata drift");
}
for (const file of Object.keys(WASMTIME_EXCLUSIONS)) {
  if (!manifest.files.includes(file)) {
    throw new Error(`stale exclusion: ${file}`);
  }
}

const counts = {
  inventory: manifest.files.length,
  passed: 0,
  setupOnly: 0,
  assertions: 0,
  knownFailures: {} as Record<string, number>,
  skips: {} as Record<string, number>,
  excludedFiles: 0,
  excludedCommands: 0,
  infrastructureFailures: 0,
  infrastructureCommands: 0,
  totalCommands: 0,
  unexpected: 0,
};
const failures: string[] = [];
const seenExpectations = new Set<string>();
const seenSkips = new Set<string>();
const fileResults: Array<Record<string, unknown>> = [];
for (const file of manifest.files) {
  const doc = JSON.parse(await Deno.readTextFile(join(generated, file))) as {
    source_filename: string;
    commands: Array<{ line: number; type: string }>;
  };
  const exclusion = WASMTIME_EXCLUSIONS[file];
  counts.totalCommands += doc.commands.length;
  if (exclusion !== undefined) {
    counts.excludedFiles++;
    counts.excludedCommands += doc.commands.length;
    console.log(`EXCLUDED ${file}: ${exclusion}`);
    fileResults.push({
      file,
      status: "excluded",
      reason: exclusion,
      commands: doc.commands.length,
    });
    continue;
  }
  const command = new Deno.Command(Deno.execPath(), {
    cwd: repo,
    args: [
      "run",
      "--no-lock",
      "--allow-read",
      "--allow-env=POLYENGINE_SCHED_SEED",
      join(repo, "tools/wasmtime/worker.ts"),
      file,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const outcome = await runChild(command, 30_000);
  if (outcome === "timeout") {
    counts.infrastructureFailures++;
    counts.infrastructureCommands += doc.commands.length;
    failures.push(`${file}: infrastructure timeout`);
    fileResults.push({
      file,
      status: "infrastructure-failure",
      reason: "timeout",
    });
    continue;
  }
  if (!outcome.success) {
    counts.infrastructureFailures++;
    counts.infrastructureCommands += doc.commands.length;
    failures.push(
      `${file}: worker failed: ${new TextDecoder().decode(outcome.stderr)}`,
    );
    fileResults.push({
      file,
      status: "infrastructure-failure",
      reason: "worker exit",
    });
    continue;
  }
  let result: FileResult;
  try {
    result = JSON.parse(new TextDecoder().decode(outcome.stdout)) as FileResult;
  } catch (error) {
    counts.infrastructureFailures++;
    counts.infrastructureCommands += doc.commands.length;
    failures.push(`${file}: malformed worker JSON: ${error}`);
    fileResults.push({
      file,
      status: "infrastructure-failure",
      reason: "malformed JSON",
    });
    continue;
  }
  const malformed = validateWorkerResult(doc, result);
  if (malformed !== undefined) {
    counts.infrastructureFailures++;
    counts.infrastructureCommands += doc.commands.length;
    failures.push(`${file}: ${malformed}`);
    fileResults.push({
      file,
      status: "infrastructure-failure",
      reason: malformed,
    });
    continue;
  }
  for (const command of result.results) {
    const verdict = classify(file, command);
    if (verdict.status === "passed") {
      counts.passed++;
      if (
        command.type === "module" || command.type === "module_definition" ||
        command.type === "module_instance"
      ) counts.setupOnly++;
      else counts.assertions++;
    } else if (verdict.status === "known-failure") {
      seenExpectations.add(`${file}:${command.line}`);
      counts.knownFailures[verdict.class] =
        (counts.knownFailures[verdict.class] ?? 0) + 1;
    } else if (verdict.status === "skip") {
      seenSkips.add(`${file}:${command.line}`);
      counts.skips[verdict.class] = (counts.skips[verdict.class] ?? 0) + 1;
    } else {
      counts.unexpected++;
      failures.push(`${file}:${command.line}: ${verdict.detail}`);
    }
  }
  fileResults.push({ file, status: "executed", results: result.results });
}
for (const expected of WASMTIME_EXPECTATIONS) {
  const key = `${expected.file}:${expected.line}`;
  if (!seenExpectations.has(key)) {
    failures.push(`${key}: stale or unreachable expectation`);
  }
}
for (const expected of WASMTIME_SKIP_EXPECTATIONS) {
  const key = `${expected.file}:${expected.line}`;
  if (!seenSkips.has(key)) {
    failures.push(`${key}: stale or unreachable skip expectation`);
  }
}
const accounted = counts.passed +
  Object.values(counts.knownFailures).reduce((a, b) => a + b, 0) +
  Object.values(counts.skips).reduce((a, b) => a + b, 0) +
  counts.excludedCommands + counts.unexpected + counts.infrastructureCommands;
if (accounted !== counts.totalCommands) {
  failures.push(
    `command accounting mismatch: ${accounted} != ${counts.totalCommands}`,
  );
}
await Deno.writeTextFile(
  join(generated, "results.json"),
  JSON.stringify({ counts, files: fileResults, failures }, null, 2) + "\n",
);
console.log(JSON.stringify(counts, null, 2));
if (failures.length > 0) {
  console.error(failures.join("\n"));
  Deno.exit(1);
}
