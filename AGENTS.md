# polyengine development protocol

## Authorities

- Runtime semantics: the pinned Component Model spec and
  `third_party/component-model/design/mvp/canonical-abi/definitions.py`.
  Wasmtime is corroborating evidence, not the tie-breaker. The single named
  corpus exception is defined in
  [architecture §1](docs/architecture.md#1-goals).
- Interfaces: `contracts/`. Semantic contract changes are versioned events owned
  by the orchestrator; implementation tracks report conflicts rather than
  changing the contract to fit their code.
- Design: [architecture](docs/architecture.md). Consumer requirements:
  [consumers](docs/consumers.md). Upstream sources:
  [references](docs/references.md).

## Gates

The justfile is the command surface. `just ci` runs the CI recipes in
`.github/justfile`; each CI job invokes one `gha::` recipe. `just gates` also
includes local consumer smokes and is the full pre-commit gate:

```sh
just gates
```

Use `just --list` for focused gates. Runtime formatting is checked by
`just fmt-check`. Run gates with non-interactive stdin, as in CI; a terminal
session may need `just gates < /dev/null` for WASI terminal-detection tests.

Conformance gates reject unexpected failures and stale expected failures.
Browser deltas live in `harness/browser/expectations/`. Never absorb a
regression into an xfail or overlay without a named class and tracking issue.
Passing with exclusions is not full spec conformance.

## Multi-agent protocol

Agent definitions and model choices live in the operator's global config, not
this repository. Honor session-specific model instructions.

- Dispatches name owned paths, governing contracts/spec sections, and exact gate
  commands. Concurrent implementation territories must be disjoint.
- The scheduler core has one implementation owner. Parallelize peripheral work
  rather than independently changing shared scheduling rules.
- Subagents do not commit. The primary agent integrates, reviews, and commits.
- Review every track against its named authorities. CABI/async reviews include
  architecture §5-§7 and the pinned spec/reference. Flag missing authorities
  rather than supplying rules from memory.
- Resume revision rounds in the same agent session. After fan-out, reconcile
  every launched track with its result; an absent response is not absent work.
- Interrupted sessions retain context and filesystem effects. Resume first;
  after two failed resumes, hand off to a new agent with the partial artifacts.
  Repeated failure requires escalation, not repeated blind relaunches. The
  operator's subagent-recovery instructions describe the tooling.

## Repository and consumers

- `main` is protected. Deliver through a PR and auto-merge after required `core`
  checks. The `browser` job runs post-merge and gates prerelease artifacts; it
  must not become a required PR check.
- Do not run one-off `npm:` imports from the workspace root: Deno may write them
  into `deno.lock`. Use an existing dependency or scratch work under `/tmp`;
  inspect lockfile changes before staging.
- Consumer checkouts under `~/p/polymorph/` are read-only. Check their git
  status before and after verification. Put new build artifacts in `/tmp` or a
  redirected `CARGO_TARGET_DIR`, never in consumer trees.
- Findings against foreign repositories belong in
  `upstream-component-model-repo-findings.md` or
  `upstream-consumer-findings.md`. Public filing requires the operator's
  authorization.

## Versioning and publishing

`@polyengine/{runtime,translator,wasi,ct-runner}` version in lockstep. Their
manifests carry the **next** release. Compatible changes leave versions alone;
breaking changes move the lockstep minor. `@polyengine/protocol` versions
independently, and changing its manifest publishes that version at the next cut.
Runtime's `RUNTIME_VERSION` in `runtime/src/embedder/copy.ts` must match its
manifest.

Declare breaking surfaces with `breaking/runtime`, `breaking/translator`,
`breaking/wasi`, `breaking/ct-runner`, or `breaking/protocol` PR labels. Labels
are read live: correcting a merged PR's label before a release is supported.
Missing labels are not detectable by the mechanical guard; review the release
window's diffs.

`tools/version-guard/check.ts` has four modes (`just test-version-guard`):

| Mode      | Checks                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `local`   | Label-free lockstep, monotonicity, and protocol byte identity; first in `just gates` and unconditional in core CI |
| `pr`      | Live label/minor-bump agreement and golden-change labels; early warning because label edits do not rerun CI       |
| `publish` | In-tree protocol is byte-identical to its named published version; runs for both prereleases and cuts             |
| `cut`     | Release-window labels, required minor advances, golden changes, and release notes                                 |

The host ABI belongs to protocol, not the runtime package. Its committed
transcripts are in `runtime/tests/conventions/golden/`
(`just test-conventions`): modifying/deleting one requires `breaking/protocol`
and the protocol minor bump, unless reviewed as a suite correction under
`conventions-fix`. Adding goldens is free. The cut guard checks the whole
release window. Host modules import protocol at most; runtime exports are
application machinery.

Both JSR and npm use the same package manifests. JSR publishes in `release.yml`;
npm packages are built by `tools/npm-build/build.ts` using dnt and published by
`npm-publish.yml`. `just test-npm` verifies packaged exports, declarations, and
cross-package dependencies: dependencies must not be inlined into duplicate
runtime/protocol copies. npm uses OIDC trusted publishing keyed to the workflow
filename, not a repository token.

Every green main commit produces a GitHub `pre-<shorthash>` release containing
artifacts only. Registry publishing happens only on cut releases; the old npm
`pre` tag is frozen.

## Cutting a release

1. Enumerate changes since the last cut, including direct main commits. Use
   `gh pr list --search "base:main merged:>=<last-cut-date>"` and
   `git log v<last>..origin/main --first-parent --oneline`. Read diffs against
   labels and correct missing breaking labels before proceeding.
2. Check final lockstep versions, `RUNTIME_VERSION`, and protocol's version
   against the release window. A breaking surface requires the appropriate minor
   advance beyond the last cut.
3. Confirm the target SHA has its green `pre-<shorthash>` release.
4. Dispatch `gh workflow run release.yml -f release=true --ref main`.
5. Immediately land a manifest-bump PR to the next patch for the four lockstep
   manifests and `RUNTIME_VERSION`.
6. Confirm the dispatched `npm-publish.yml` run and check
   `npm view @polyengine/runtime dist-tags`: `latest` must name the cut.
