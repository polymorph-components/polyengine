# polyengine — development protocol

Instructions for agents (and context for humans) working in this repo. The
repo was built by a multi-agent workflow and its discipline is part of the
project: unusually dense objective gates are what make delegated
implementation safe.

## Authorities

- Semantic tie-breaker for runtime behavior: the Component Model spec +
  `design/mvp/canonical-abi/definitions.py` (in the
  `third_party/component-model` submodule), with wasmtime as corroborating
  evidence — never the other way around. See
  [docs/architecture.md](docs/architecture.md) §1 for the parity policy.
- Interface contracts between workstreams live in `contracts/` (plan format,
  descriptor IR, intrinsics, digest, embedder API). **Contract changes are
  versioned events made only by the orchestrator**; implementation tracks
  report contract friction, they never edit around it.
- Design and decisions: [docs/architecture.md](docs/architecture.md).
  Milestone record: [docs/milestones.md](docs/milestones.md). Consumer
  track: [docs/consumers.md](docs/consumers.md). Upstream links:
  [docs/references.md](docs/references.md).

## Gates (exact commands)

The justfile is the command surface: recipe bodies are the exact commands,
and each CI job runs exactly one `gha::` recipe (`just ci` = exactly CI;
`.github/justfile` holds the job bodies). Run the recipes your change can
affect; the full pass before commit is:

```sh
just gates    # everything below, in this order
```

```sh
just build test-rust      # cargo build --workspace; translator-shim/bindgen/testgen tests
just test-runtime         # runtime check + tests (deps: shim, fixtures, corpus)
just test-protocol
just test-wasi test-ct-runner
just test-sockets-node    # sockets fragment's node backend on pinned Node
just test-bundle          # embedder-bundle release asset
just publish-check        # deno publish --dry-run: the JSR publish checks, no upload
just examples test-translate  # embedder examples; build-time translation CLI
just conformance          # official CM suite, Deno lane
just sched-seeds          # seeded-shuffle reruns: POLYENGINE_SCHED_SEED=1, =4242 (FIFO when unset)
just shells               # pinned engine/runtime lanes: sm + node everywhere, jsc on x64, bun findings-only
just browsers             # chromium + firefox lanes incl. worker/shared-worker realm rows (`just browsers-install` once)
just smoke-tls            # polymorph-tls suite (issue #18)
just smoke-c0             # C0 smoke legs
```

Conformance discipline: the harness fails loudly on unexpected failures *and*
on stale xfails; per-browser deltas live in `harness/browser/expectations/`
with stale-delta detection. Never absorb a regression into an xfail/overlay
without a named class and a tracking issue.

## Multi-agent protocol

Work is parallelized across model-pinned subagents defined in the operator's
**global** opencode config — deliberately not vendored into this repo, so all
repo-specific context (contracts, spec authorities, gates) travels in each
dispatch prompt.

| Agent | Model | Role |
|---|---|---|
| orchestrator (primary session) | fable | planning, contracts, dispatch, integration, review, **all commits** |
| `coder` | sonnet | implementation tracks against pinned contracts |
| `coder-hard` | opus | subtle tracks: shim internals, CABI edge cases, scheduler periphery |
| `reviewer` | fable | parallel code review when the orchestrator is the bottleneck |
| `explore` | haiku | fast read-only codebase search |

Dispatch rules:

- Every track prompt names: **territory** (paths owned), **governing
  contracts** (`contracts/*.md` + design-doc sections), and **gates** (exact
  commands). Territories are disjoint across concurrent tracks.
- Subagents never commit (permission-enforced); the orchestrator commits
  after review.
- The task-scheduler **core** is single-owner (coherence risk):
  `coder-hard` at most, under close orchestrator review; parallelism stays at
  the periphery.

Review protocol: every track is reviewed against its contracts before commit
— by the orchestrator inline, or by `reviewer` subagents in parallel. A
review dispatch **must** name the diff scope, the governing `contracts/*.md`,
and — for anything touching CABI/async semantics —
[docs/architecture.md](docs/architecture.md) §5–§7 plus the spec sources
(`definitions.py` as tie-breaker): the reviewer judges only against named
authorities and flags unnamed ones rather than filling gaps from memory.
Revision rounds go back to the *same* coder session via `task_id` (context
intact), not a fresh agent.

Failure recovery (content-filter false positives, driver interrupts): an
aborted `task` call kills neither the child session (context persists in the
opencode db) nor its effects (files/commands persist on disk). Ladder:

1. Locate the orphan (`opencode-agent-sessions <parent-session-id>`, on
   PATH); resume via `task_id` — "summarize status, then continue".
2. Two failed resumes → assume poisoned context: fresh agent, handoff prompt
   = original track + "partial work exists, audit state first" + artifact
   pointers. Gates arbitrate what's already done.
3. Repeated failures across fresh contexts → escalate to the human; the
   trigger may live in the artifacts themselves.

Standing rules:

- After any fan-out, reconcile launched-vs-completed before proceeding — a
  missing result is not missing work.
- Never run one-off `npm:` specifiers (e.g. `deno run npm:yaml`) from the
  workspace root: Deno records them into the root `deno.lock`, silently
  dirtying the tree (bitten twice by YAML-parsing one-offs). Use python3 or
  run from `/tmp`; check `git diff deno.lock` before staging.
- `main` is branch-protected: required checks = the `core` CI matrix,
  force-pushes and deletions blocked, auto-merge enabled. Admin direct
  pushes still work (`enforce_admins: false`), but PR + auto-merge is the
  preferred delivery: it gets the required checks for free. The `browser`
  job is deliberately NOT a required PR check (it runs post-merge only,
  gating the prerelease) — do not add it to the protection contexts or
  PRs will never merge.
- Versioning (README §Consuming): `@polyengine/{runtime,translator,wasi,
  ct-runner}` version in **lockstep**, and the manifests always carry the
  NEXT release. Still 0.x/unstable but caret-honest: a PR that breaks the
  published surface bumps the lockstep minor in the same PR; compatible
  work leaves the version alone. Releases are cut from a green `main`
  commit via release.yml `workflow_dispatch` with `release=true` (guards:
  lockstep, tag-exists, green `pre-<shorthash>` present), followed
  immediately by a manifest-bump PR to the next patch — the four manifests
  plus runtime's A9 copy-identity constant `RUNTIME_VERSION`
  (runtime/src/embedder/copy.ts; `just test-runtime` pins the sync).
  `@polyengine/protocol`
  versions independently; bumping its manifest publishes it for real on
  the next green run.
- Two registries, one version (protocol rides its own manifest version on
  both — A10). JSR is published inline by release.yml; npm
  is published by npm-publish.yml, triggered by the GitHub release, from
  packages built by `tools/npm-build/build.ts` (dnt). The npm side reads
  name/version/exports out of the same `deno.json` manifests, so adding an
  entry point or bumping a version needs no second edit — but `just
  test-npm` is the gate that proves it, and the property it exists to pin
  is that cross-package imports stay npm **dependencies** rather than
  inlined source (duplicate copies are the A9 failure mode). npm auth is
  OIDC trusted publishing keyed on the `npm-publish.yml` filename; there
  is no npm token in the repository or its secrets.
- Consumer checkouts (the polymorph family, under `~/p/polymorph/`) are
  **strictly read-only**: verify `git status` in any consumer tree you ran
  commands near, before and after. Build artifacts go to `/tmp` or a
  redirected `CARGO_TARGET_DIR`, never into consumer trees.
- Findings against foreign repos go in the tracker files
  (`upstream-component-model-repo-findings.md`,
  `upstream-consumer-findings.md`), not inline notes; filing them is the
  operator's call.
