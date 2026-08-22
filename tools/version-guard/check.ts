#!/usr/bin/env -S deno run -A
// The release version guard (three modes: `pr`, `publish`, `cut`).
//
// What it defends. The five packages publish under two rules (AGENTS.md
// §Versioning, README §Consuming): @polyengine/{runtime,translator,wasi,
// ct-runner} version in LOCKSTEP and their manifests always carry the NEXT
// release; @polyengine/protocol versions independently and publishes at the
// next cut after its manifest bumps. Breaking changes are
// declared per package by PR labels `breaking/<package>`; no label means
// caret-compatible. Labels are MUTABLE and read live from the GitHub API
// every time — a label corrected after the merge still steers the cut,
// which is the point of reading them at cut time rather than trusting an
// event payload.
//
// The three modes, and why the enforcement point is where it is:
//
//   pr      — early warning, inside `gha::core` on PR runs. Lockstep
//             agreement, monotonicity against the last cut, label/version
//             agreement in both directions, and the protocol-tear warning.
//             Advisory in the sense that matters: label edits deliberately
//             do NOT re-trigger CI, so a PR-time verdict can be stale by
//             merge time. Cheap to be wrong here; a re-run picks up fixes.
//   publish — the AUTHORITATIVE tear guard, in release.yml's publish step,
//             in BOTH modes. Registry publishes happen only at explicit
//             cuts (#223), so the window between a PR-time verdict and a
//             publish is no longer a race — but a PR-time verdict is still
//             the wrong thing to trust: it misses label edits made after
//             the run, commits pushed straight to main, and any run stale
//             by the time the cut happens. This check runs at the publish
//             itself, reads the tree being published, and cannot be stale.
//             On the prerelease path it publishes nothing and is instead
//             early detection: a red means the next CUT would tear.
//   cut     — label/version consistency for the whole release window, plus
//             the release-notes fragment, in release.yml on release=true
//             only. This is where a breaking label becomes a minor bump.
//
// The tear this exists for (the concrete incident): PR #219 changed
// protocol/src without bumping protocol/deno.json, because its merge
// resolution assumed 0.2.0 was still unpublished — under the pre-#223 flow
// every green main published, and one such run had published 0.2.0 hours
// earlier. Every publish after that skipped protocol as already-published,
// so runtime@0.4.0-pre.* shipped importing exports the published
// protocol@0.2.0 did not have: an import-time failure for anyone consuming
// the pair. #221 (protocol 0.2.1) repaired it. `publish` mode is the check
// that would have made that red, loudly, at the first publish after the
// merge.

import { compareSemver, isMinorBumped, parseSemver } from "./semver.ts";
import {
  type Effects,
  ghApi,
  realEffects,
  sha256Hex,
} from "./effects.ts";

/** The four packages that release as one version. */
export const LOCKSTEP = ["runtime", "translator", "wasi", "ct-runner"];
/** Canonical package order for label rendering (lockstep, then protocol). */
export const PACKAGES = [...LOCKSTEP, "protocol"];

const JSR_PROTOCOL = "https://jsr.io/@polyengine/protocol";

export type Check = { name: string; ok: boolean; detail: string };

const pass = (name: string, detail: string): Check => ({
  name,
  ok: true,
  detail,
});
const fail = (name: string, detail: string): Check => ({
  name,
  ok: false,
  detail,
});

// ----- shared helpers ---------------------------------------------------------

const dec = new TextDecoder();

export async function readManifestVersion(
  fx: Effects,
  pkg: string,
): Promise<string> {
  const bytes = await fx.readFile(`${pkg}/deno.json`);
  if (!bytes) throw new Error(`missing ${pkg}/deno.json`);
  const version = JSON.parse(dec.decode(bytes))?.version;
  if (typeof version !== "string") {
    throw new Error(`${pkg}/deno.json has no string "version"`);
  }
  return version;
}

/** The label names attached to a PR, as `breaking/<pkg>` package names. */
export function breakingPackages(labels: string[]): string[] {
  const named = new Set(
    labels
      .filter((l) => l.startsWith("breaking/"))
      .map((l) => l.slice("breaking/".length)),
  );
  return PACKAGES.filter((p) => named.has(p));
}

/** JSR package metadata: `latest` plus the published version set. */
export async function jsrProtocolLatest(fx: Effects): Promise<string | null> {
  const res = await fx.fetchText(`${JSR_PROTOCOL}/meta.json`);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`jsr.io meta.json: HTTP ${res.status}`);
  }
  const latest = JSON.parse(res.body)?.latest;
  return typeof latest === "string" ? latest : null;
}

export type JsrManifest = Record<string, { checksum: string; size: number }>;

/** The published file manifest for one version, or null when unpublished. */
export async function jsrProtocolManifest(
  fx: Effects,
  version: string,
): Promise<JsrManifest | null> {
  const res = await fx.fetchText(`${JSR_PROTOCOL}/${version}_meta.json`);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`jsr.io ${version}_meta.json: HTTP ${res.status}`);
  }
  const manifest = JSON.parse(res.body)?.manifest;
  if (!manifest || typeof manifest !== "object") {
    throw new Error(`jsr.io ${version}_meta.json has no manifest object`);
  }
  return manifest as JsrManifest;
}

/** The version of the most recent CUT release, from `releases/latest` —
 * which excludes prereleases by definition, so the automatic
 * `pre-<shorthash>` stream never answers this question. null before the
 * first cut. */
export async function latestCutVersion(
  fx: Effects,
  repo: string,
): Promise<{ tag: string; version: string } | null> {
  const { status, json } = await ghApi(fx, `repos/${repo}/releases/latest`);
  if (status === 404) return null;
  const tag = (json as { tag_name?: string })?.tag_name;
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new Error(`latest release tag ${JSON.stringify(tag)} is not v<version>`);
  }
  return { tag, version: tag.slice(1) };
}

// ----- pr mode ----------------------------------------------------------------

export type PrEnv = {
  prNumber: string;
  baseSha: string;
  repo: string;
};

/** Files that changed in the PR, and the base revision's runtime manifest.
 *
 * The PR checkout is SHALLOW, so the base commit has to be fetched before
 * either question can be asked. `A...B` is the diff the PR actually
 * proposes; a depth-1 fetch may leave no common ancestor for git to find,
 * in which case we fall back to the two-dot diff (a superset that can
 * include base-side changes — for these checks a false positive costs a
 * re-read, a false negative costs a torn publish).
 */
export async function fetchBase(
  fx: Effects,
  baseSha: string,
): Promise<{ changed: string[]; baseRuntimeVersion: string | null }> {
  await fx.run("git", ["fetch", "origin", baseSha, "--depth=1"]);
  let diff = await fx.run("git", [
    "diff",
    "--name-only",
    `${baseSha}...HEAD`,
  ]);
  if (diff.code !== 0) {
    diff = await fx.run("git", ["diff", "--name-only", baseSha, "HEAD"]);
  }
  if (diff.code !== 0) {
    throw new Error(
      `cannot diff against the PR base ${baseSha}:\n${diff.stderr.trim()}`,
    );
  }
  const show = await fx.run("git", ["show", `${baseSha}:runtime/deno.json`]);
  const baseRuntimeVersion = show.code === 0
    ? JSON.parse(show.stdout)?.version ?? null
    : null;
  return {
    changed: diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean),
    baseRuntimeVersion,
  };
}

export async function prChecks(fx: Effects, env: PrEnv): Promise<Check[]> {
  const checks: Check[] = [];

  // 1. Lockstep agreement.
  const versions = new Map<string, string>();
  for (const pkg of LOCKSTEP) {
    versions.set(pkg, await readManifestVersion(fx, pkg));
  }
  const lockstep = versions.get("runtime")!;
  const disagreeing = [...versions].filter(([, v]) => v !== lockstep);
  if (disagreeing.length > 0) {
    checks.push(fail(
      "lockstep",
      `the lockstep manifests disagree: ${
        [...versions].map(([p, v]) => `${p}=${v}`).join(" ")
      } — all four of ${LOCKSTEP.join(", ")} must carry the same NEXT version`,
    ));
  } else {
    checks.push(pass("lockstep", `${LOCKSTEP.join(", ")} all at ${lockstep}`));
  }

  const protocolVersion = await readManifestVersion(fx, "protocol");
  const labels = await prLabels(fx, env);
  const breaking = breakingPackages(labels);
  const lockstepBreaking = breaking.filter((p) => p !== "protocol");

  // 2. The last cut. Only checks 3 and 4 have a referent in it: both ask
  // "where is this version relative to the last RELEASED one?". Checks 5-7
  // do not — 5 compares the PR's base to its head, 6 and 7 compare against
  // the protocol version JSR has published — so they run unconditionally,
  // below and outside this block. That placement is deliberate: the tear
  // warning is the check that must never be dead, and a repo with no cut
  // release yet is exactly the state in which skipping it would be least
  // noticed.
  const cut = await latestCutVersion(fx, env.repo);
  if (!cut) {
    checks.push(pass(
      "last-cut",
      "no cut release yet — the monotonicity and breaking-label-bump checks have no referent and are skipped",
    ));
  } else {
    checks.push(pass("last-cut", `latest cut release is ${cut.tag}`));

    // 3. Monotonic: the manifests carry the NEXT release, so they must be
    // ahead of the last one — otherwise a cut would republish it.
    if (compareSemver(lockstep, cut.version) > 0) {
      checks.push(pass("monotonic", `lockstep ${lockstep} > last cut ${cut.version}`));
    } else {
      checks.push(fail(
        "monotonic",
        `lockstep manifests are at ${lockstep}, not ahead of the last cut ${cut.version} — the manifests must carry the NEXT release; bump the four ${LOCKSTEP.join("/")} manifests (and RUNTIME_VERSION in runtime/src/embedder/copy.ts)`,
      ));
    }

    // 4. A breaking label asserts the published surface breaks, and
    // caret-honesty makes that a minor bump within THIS release cycle.
    if (lockstepBreaking.length > 0) {
      if (isMinorBumped(lockstep, cut.version)) {
        checks.push(pass(
          "breaking-label-bumped",
          `breaking/${lockstepBreaking.join(", breaking/")} with ${lockstep} > minor of last cut ${cut.version}`,
        ));
      } else {
        checks.push(fail(
          "breaking-label-bumped",
          `this PR is labelled breaking/${lockstepBreaking.join(", breaking/")} but the lockstep manifests are still on the ${lockstep} minor line, which the last cut ${cut.version} already occupies — bump the lockstep MINOR (all four manifests + RUNTIME_VERSION), or drop the label if the change is caret-compatible`,
        ));
      }
    }
  }

  // 5. The converse of 4, answered entirely from the PR itself (base vs
  // head), so it holds before the first cut too. A minor bump without a
  // label is either a missing label or an unintended bump; a PATCH bump
  // needs no label (that is the routine post-cut manifest-bump PR).
  const { changed, baseRuntimeVersion } = await fetchBase(fx, env.baseSha);
  if (baseRuntimeVersion === null) {
    checks.push(fail(
      "minor-bump-labelled",
      `cannot read runtime/deno.json at the PR base ${env.baseSha} — the base commit did not fetch, so the label/bump agreement cannot be checked`,
    ));
  } else {
    const bumpedHere = isMinorBumped(lockstep, baseRuntimeVersion);
    if (bumpedHere && lockstepBreaking.length === 0) {
      checks.push(fail(
        "minor-bump-labelled",
        `this PR bumps the lockstep minor (${baseRuntimeVersion} -> ${lockstep}) but carries no breaking/{${LOCKSTEP.join(",")}} label — label it with the package(s) whose published surface breaks, or make the bump a patch`,
      ));
    } else {
      checks.push(pass(
        "minor-bump-labelled",
        bumpedHere
          ? `minor bump ${baseRuntimeVersion} -> ${lockstep} is labelled`
          : `no lockstep minor bump (base ${baseRuntimeVersion}, head ${lockstep})`,
      ));
    }
  }

  // 6/7 are measured against the PUBLISHED protocol, not the last cut:
  // protocol is outside the lockstep (embedder-api A10), publishes on its
  // own manifest, and can therefore tear whether or not this repo has ever
  // cut a release.
  const publishedProtocol = await jsrProtocolLatest(fx);
  checks.push(...protocolPrChecks({
    protocolVersion,
    publishedProtocol,
    protocolBreaking: breaking.includes("protocol"),
    changed,
  }));

  return checks;
}

async function prLabels(fx: Effects, env: PrEnv): Promise<string[]> {
  // Live labels, never the event payload: a retroactive label edit must
  // count, and the payload is frozen at the event that started the run.
  const { status, json } = await ghApi(
    fx,
    `repos/${env.repo}/issues/${env.prNumber}/labels`,
  );
  if (status !== 200) {
    throw new Error(`cannot read labels for PR #${env.prNumber}: HTTP ${status}`);
  }
  return (json as { name?: string }[]).map((l) => l.name ?? "");
}

/** Checks 6 and 7, split out so the tear warning is testable on its own. */
export function protocolPrChecks(input: {
  protocolVersion: string;
  publishedProtocol: string | null;
  protocolBreaking: boolean;
  changed: string[];
}): Check[] {
  const { protocolVersion, publishedProtocol, protocolBreaking, changed } =
    input;
  const checks: Check[] = [];
  if (publishedProtocol === null) {
    checks.push(pass(
      "protocol",
      "@polyengine/protocol is not published yet — protocol checks skipped",
    ));
    return checks;
  }

  // 6.
  if (protocolBreaking) {
    if (isMinorBumped(protocolVersion, publishedProtocol)) {
      checks.push(pass(
        "protocol-breaking-label",
        `breaking/protocol with manifest ${protocolVersion} > minor of published ${publishedProtocol}`,
      ));
    } else {
      checks.push(fail(
        "protocol-breaking-label",
        `this PR is labelled breaking/protocol but protocol/deno.json is at ${protocolVersion}, on the same minor line as the published ${publishedProtocol} — bump protocol's MINOR, or drop the label if the change is caret-compatible`,
      ));
    }
  }

  // 7. The tear, caught early: protocol source moving without a version
  // move means the next publish silently skips protocol as
  // already-published and its dependents ship against stale exports.
  // The reference point is JSR's CURRENT latest, which is a cut version:
  // since #223 a merged bump stays unpublished until the next cut, so
  // replaying this check on an already-merged protocol PR still passes.
  // The question it asks is always the live one — "would publishing from
  // this tree tear?".
  const touched = changed.filter((f) =>
    f.startsWith("protocol/src/") || f === "protocol/deno.json"
  );
  if (touched.length > 0) {
    if (compareSemver(protocolVersion, publishedProtocol) > 0) {
      checks.push(pass(
        "protocol-tear",
        `protocol changed and its manifest ${protocolVersion} is ahead of the published ${publishedProtocol}`,
      ));
    } else {
      checks.push(fail(
        "protocol-tear",
        `this PR changes ${touched.join(", ")} but protocol/deno.json is at ${protocolVersion}, which is already published on JSR (latest ${publishedProtocol}) — the next publish would skip protocol as already-published and ship its dependents against the OLD protocol. Bump protocol/deno.json or revert the protocol/src change.`,
      ));
    }
  } else {
    checks.push(pass("protocol-tear", "no protocol/src or protocol/deno.json change"));
  }
  return checks;
}

// ----- publish mode -----------------------------------------------------------

/** Every in-tree file that `deno publish` would upload for protocol:
 * protocol/src/**\/* plus the manifest (protocol/deno.json excludes tests/).
 * Returned as JSR manifest paths — package-root-relative, leading slash. */
export async function inTreeProtocolFiles(fx: Effects): Promise<string[]> {
  const src = await fx.listFiles("protocol/src");
  return [...src.map((f) => `/src/${f}`), "/deno.json"].sort();
}

/**
 * The authoritative tear guard: if protocol's manifest version is ALREADY
 * published, the in-tree protocol must be byte-identical to what was
 * published under that version — because `deno publish` will skip it, and
 * every dependent published in the same run will resolve to the registry's
 * copy, not this tree's.
 *
 * Identity is exact and bidirectional (every published path matches in
 * tree, every publishable in-tree file appears in the manifest) BY DESIGN:
 * this check's red must be unarguable, and a "meaningful difference"
 * heuristic is exactly the kind of thing that talks a release into
 * shipping. Softer variants are parked in issue #222 — do not implement
 * them here.
 */
export async function publishChecks(
  fx: Effects,
  version: string,
): Promise<Check[]> {
  const manifest = await jsrProtocolManifest(fx, version);
  if (manifest === null) {
    return [pass(
      "protocol-identity",
      `@polyengine/protocol@${version} is not published — this run publishes it`,
    )];
  }

  const problems: string[] = [];
  const publishedPaths = Object.keys(manifest).sort();
  for (const path of publishedPaths) {
    const bytes = await fx.readFile(`protocol${path}`);
    if (!bytes) {
      problems.push(`missing in tree: protocol${path}`);
      continue;
    }
    const want = manifest[path].checksum;
    const got = `sha256-${await sha256Hex(bytes)}`;
    if (got !== want) {
      problems.push(
        `content differs: protocol${path} (published ${want}, in tree ${got})`,
      );
    }
  }
  const published = new Set(publishedPaths);
  for (const path of await inTreeProtocolFiles(fx)) {
    if (!published.has(path)) {
      problems.push(`not in the published version: protocol${path}`);
    }
  }

  if (problems.length === 0) {
    return [pass(
      "protocol-identity",
      `in-tree protocol is byte-identical to the published @polyengine/protocol@${version} (${publishedPaths.length} files)`,
    )];
  }
  return [fail(
    "protocol-identity",
    `in-tree protocol differs from the published @polyengine/protocol@${version} — bump protocol/deno.json (or revert the protocol change). This run would SKIP protocol as already-published and publish its dependents against the registry's older copy:\n  ${
      problems.join("\n  ")
    }`,
  )];
}

// ----- cut mode ---------------------------------------------------------------

export type CutPr = {
  number: number;
  title: string;
  labels: string[];
};

export type DirectCommit = { sha: string; subject: string };

export type ReleaseWindow = {
  prs: CutPr[];
  direct: DirectCommit[];
};

/** The PRs and direct commits between the last cut tag and the cut sha, in
 * commit order, deduped by PR number.
 *
 * Labels come back on the association response, which means CURRENT labels
 * — a label corrected after the merge feeds the guard here, which is the
 * whole reason the enforcement point is the cut and not the PR.
 */
export async function releaseWindow(
  fx: Effects,
  repo: string,
  lastTag: string,
  sha: string,
): Promise<ReleaseWindow> {
  const { status, json } = await ghApi(
    fx,
    `repos/${repo}/compare/${lastTag}...${sha}`,
  );
  if (status !== 200) {
    throw new Error(`cannot compare ${lastTag}...${sha}: HTTP ${status}`);
  }
  const cmp = json as {
    total_commits?: number;
    commits?: { sha: string; commit: { message: string } }[];
  };
  const commits = cmp.commits ?? [];
  // The compare endpoint returns at most 250 commits. At this cadence a
  // release window is far below that, so the cap is not paginated around —
  // it is refused, loudly, rather than silently truncating the notes and
  // the label scan.
  if (typeof cmp.total_commits === "number" && cmp.total_commits > commits.length) {
    throw new Error(
      `${lastTag}...${sha} spans ${cmp.total_commits} commits but the compare endpoint returned ${commits.length} (250-commit cap) — the label scan would be incomplete; cut a release more often or paginate this call`,
    );
  }

  const prs: CutPr[] = [];
  const seen = new Set<number>();
  const direct: DirectCommit[] = [];
  for (const c of commits) {
    const res = await ghApi(fx, `repos/${repo}/commits/${c.sha}/pulls`);
    if (res.status !== 200) {
      throw new Error(`cannot list PRs for ${c.sha}: HTTP ${res.status}`);
    }
    const associated = res.json as {
      number: number;
      title: string;
      labels?: { name?: string }[];
    }[];
    if (associated.length === 0) {
      direct.push({
        sha: c.sha,
        subject: c.commit.message.split("\n")[0],
      });
      continue;
    }
    for (const pr of associated) {
      if (seen.has(pr.number)) continue;
      seen.add(pr.number);
      prs.push({
        number: pr.number,
        title: pr.title,
        labels: (pr.labels ?? []).map((l) => l.name ?? ""),
      });
    }
  }
  return { prs, direct };
}

/** protocol/deno.json's version at a given ref, via the contents API (the
 * release runner's checkout is shallow and has no history at the tag). */
export async function protocolVersionAtRef(
  fx: Effects,
  repo: string,
  ref: string,
): Promise<string> {
  const { status, json } = await ghApi(
    fx,
    `repos/${repo}/contents/protocol/deno.json?ref=${ref}`,
  );
  if (status !== 200) {
    throw new Error(`cannot read protocol/deno.json at ${ref}: HTTP ${status}`);
  }
  const content = (json as { content?: string }).content ?? "";
  return JSON.parse(atob(content.replace(/\n/g, ""))).version;
}

export function cutGuards(input: {
  version: string;
  lastCutVersion: string;
  protocolVersion: string;
  protocolAtLastCut: string;
  window: ReleaseWindow;
}): Check[] {
  const checks: Check[] = [];
  const { version, lastCutVersion, window } = input;

  const lockstepBreaking = window.prs.filter((pr) =>
    breakingPackages(pr.labels).some((p) => p !== "protocol")
  );
  if (lockstepBreaking.length === 0) {
    checks.push(pass(
      "cut-lockstep-labels",
      `no breaking/{${LOCKSTEP.join(",")}} label in this window (${window.prs.length} PRs)`,
    ));
  } else if (isMinorBumped(version, lastCutVersion)) {
    checks.push(pass(
      "cut-lockstep-labels",
      `breaking PRs ${lockstepBreaking.map((p) => `#${p.number}`).join(", ")}; ${version} bumps the minor over ${lastCutVersion}`,
    ));
  } else {
    checks.push(fail(
      "cut-lockstep-labels",
      `this window contains breaking changes (${
        lockstepBreaking
          .map((p) => `#${p.number} [${breakingPackages(p.labels).join(",")}]`)
          .join(", ")
      }) but ${version} is on the same minor line as the last cut ${lastCutVersion} — caret-honesty requires a MINOR bump; bump the four lockstep manifests + RUNTIME_VERSION, or correct the labels if they are wrong`,
    ));
  }

  const protocolBreaking = window.prs.filter((pr) =>
    pr.labels.includes("breaking/protocol")
  );
  if (protocolBreaking.length === 0) {
    checks.push(pass("cut-protocol-labels", "no breaking/protocol label in this window"));
  } else if (isMinorBumped(input.protocolVersion, input.protocolAtLastCut)) {
    checks.push(pass(
      "cut-protocol-labels",
      `breaking PRs ${protocolBreaking.map((p) => `#${p.number}`).join(", ")}; protocol ${input.protocolVersion} bumps the minor over ${input.protocolAtLastCut}`,
    ));
  } else {
    checks.push(fail(
      "cut-protocol-labels",
      `this window contains breaking/protocol changes (${
        protocolBreaking.map((p) => `#${p.number}`).join(", ")
      }) but protocol is at ${input.protocolVersion}, on the same minor line as ${input.protocolAtLastCut} at the last cut — bump protocol's MINOR, or correct the labels`,
    ));
  }

  return checks;
}

/** The release-notes fragment: GitHub-flavoured markdown, breaking changes
 * first (with the packages they break), then everything else, then commits
 * that landed without a PR. Empty sections are omitted entirely. */
export function renderNotes(window: ReleaseWindow): string {
  const breaking: string[] = [];
  const changes: string[] = [];
  for (const pr of window.prs) {
    const pkgs = breakingPackages(pr.labels);
    if (pkgs.length > 0) {
      breaking.push(`- ${pr.title} (#${pr.number}) — breaks: ${pkgs.join(", ")}`);
    } else {
      changes.push(`- ${pr.title} (#${pr.number})`);
    }
  }
  for (const c of window.direct) {
    changes.push(`- ${c.subject} (${c.sha.slice(0, 7)})`);
  }

  const out: string[] = [];
  if (breaking.length > 0) out.push("## Breaking", "", ...breaking, "");
  if (changes.length > 0) out.push("## Changes", "", ...changes, "");
  return out.join("\n");
}

export async function cutChecks(
  fx: Effects,
  input: { repo: string; sha: string; version: string; out: string | null },
): Promise<Check[]> {
  const cut = await latestCutVersion(fx, input.repo);
  if (!cut) {
    // First cut ever: no window to scan, no prior version to be ahead of.
    if (input.out) await fx.writeFile(input.out, "");
    return [pass("cut", "no previous cut release — nothing to compare against")];
  }

  const window = await releaseWindow(fx, input.repo, cut.tag, input.sha);
  const checks = cutGuards({
    version: input.version,
    lastCutVersion: cut.version,
    protocolVersion: await readManifestVersion(fx, "protocol"),
    protocolAtLastCut: await protocolVersionAtRef(fx, input.repo, cut.tag),
    window,
  });
  if (input.out) await fx.writeFile(input.out, renderNotes(window));
  checks.push(pass(
    "cut-notes",
    `${window.prs.length} PRs and ${window.direct.length} direct commits since ${cut.tag}${
      input.out ? ` -> ${input.out}` : ""
    }`,
  ));
  return checks;
}

// ----- main -------------------------------------------------------------------

function report(fx: Effects, mode: string, checks: Check[]): number {
  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      fx.log(`version-guard ${mode}: PASS ${c.name}: ${c.detail}`);
    } else {
      failed++;
      fx.log(`version-guard ${mode}: FAIL ${c.name}: ${c.detail}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

export async function main(fx: Effects, argv: string[]): Promise<number> {
  const mode = argv[0];
  const flag = (name: string): string | null => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
  };
  const required = (name: string): string => {
    const v = fx.env(name);
    if (!v) throw new Error(`${name} is required in ${mode} mode`);
    return v;
  };

  switch (mode) {
    case "pr": {
      const prNumber = fx.env("PR_NUMBER");
      if (!prNumber) {
        // Push runs and local `just ci` have no PR context. Skipping keeps
        // the guard as gha::core's first step without making the local
        // gate depend on GitHub.
        fx.log("version-guard pr: SKIP — no PR_NUMBER (not a pull_request run)");
        return 0;
      }
      return report(fx, "pr", await prChecks(fx, {
        prNumber,
        baseSha: required("PR_BASE_SHA"),
        repo: required("GITHUB_REPOSITORY"),
      }));
    }
    case "publish": {
      // The override exists for rehearsing the failure path against the
      // real registry (point it at an older published version and watch
      // the mismatch fire); release.yml never passes it.
      const version = flag("--protocol-version") ??
        await readManifestVersion(fx, "protocol");
      return report(fx, "publish", await publishChecks(fx, version));
    }
    case "cut": {
      return report(
        fx,
        "cut",
        await cutChecks(fx, {
          repo: required("GITHUB_REPOSITORY"),
          sha: required("GITHUB_SHA"),
          version: required("VERSION"),
          out: flag("--out"),
        }),
      );
    }
    default:
      fx.log(`usage: check.ts <pr|publish|cut> [--out <path>] [--protocol-version <v>]`);
      return 2;
  }
}

if (import.meta.main) {
  const fx = realEffects();
  let code: number;
  try {
    code = await main(fx, Deno.args);
  } catch (e) {
    fx.log(`version-guard: ERROR ${e instanceof Error ? e.message : e}`);
    code = 1;
  }
  Deno.exit(code);
}

// parseSemver is re-exported so the tests (and any future caller) get the
// whole surface from one module.
export { compareSemver, isMinorBumped, parseSemver };
