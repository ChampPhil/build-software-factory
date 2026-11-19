# Build Software Factory — gh-aw Spike Findings

Nov 19, 2026 · Claude

The v0.1 spike required by the Build Plan, run against gh-aw's own source and reference docs at `github/gh-aw@23cb3c212e3cf577717086194517fa1589eb53d3`. Evidence is the compiler's frontmatter schema (`pkg/parser/schemas/main_workflow_schema.json`) and the reference docs in `docs/src/content/docs/reference/`, which are generated from the same schema.

**Result: all five items pass. Two change the design, and three add constraints the docs did not account for.** No item falls back to the earlier design (the runner running agents in its own sandbox and pushing on their behalf).

Not verified here: nothing in this spike was executed. `gh aw compile` could not be run in this session — the Go toolchain the repo requires (1.27.4) and gh-aw's release binaries are both blocked by the session's egress policy. Every finding below is read off the compiler's schema and reference docs, which is authoritative for *what the compiler accepts* but not for runtime behavior. The three items marked **needs a live run** have to be confirmed on a fixture before v0.1 ships.

## Summary

| Spike item | Verdict | Effect on the design |
| --- | --- | --- |
| 1. Custom engine runs Cursor CLI, Kilo Code, Hermes Agent headlessly | **Pass** | None; `engine.command` is the documented seam |
| 2. Safe outputs can use the factory App's token, so their pushes trigger the gates | **Pass** | None; confirms `safe-outputs.github-app` |
| 3. `factory-run` can dispatch a role workflow and read its results; the verifier never sees the builder's transcript | **Pass, build it differently** | Roles become `workflow_call` reusable workflows, not dispatched workflows. Removes the poll-and-wait entirely |
| 4. Pre-agent steps can start the devcontainer and sidecar services; a post-step can run memex | **Pass, with constraints** | Sidecar services need a weaker sandbox profile; "roles run inside the repo's devcontainer" needs restating |
| 5. A gh-aw upgrade reaches a user's compiled `.lock.yml` without a local recompile | **Pass, via a second App** | A recompile job is possible in Actions, but needs a credential with `workflows: write`. Adds a narrowly-scoped recompiler App |

A sixth finding, not on the spike list, is the most consequential of all: **gh-aw protects `.factory/` from the factory's own agents by default** (§6). It has to be configured deliberately or the hardening pipeline stalls.

## 1. Custom engine for Cursor CLI, Kilo Code and Hermes Agent — pass

Built-in engine ids are `claude`, `codex`, `copilot`, `gemini` and `pi`, so Claude Code and pi are built in, as the Architecture doc says.

For the other three, the engine object takes:

| Field | What it gives the adapter |
| --- | --- |
| `command` | "Custom executable path for the AI engine CLI. When specified, the workflow will skip the standard installation steps and use this command instead." |
| `args` | "Ordered native CLI arguments placed before the prompt." |
| `env` | Custom environment variables, including secret overrides — how `CURSOR_API_KEY` reaches Cursor CLI |
| `cwd` | Working directory override, passed as `GH_AW_ENGINE_CWD` |
| `harness` | Replaceable harness script (`.js`/`.cjs`/`.mjs`, Node 24 provisioned automatically) for full control of retry, timeout, prompt delivery and tool policy |

Two caveats for `/adapters`:

- `command` "skips the engine installer, not AWF installation" — the adapter must install the CLI itself in a setup step. Each adapter therefore ships a setup step as well as an engine definition, which the Architecture doc's `HarnessAdapter` interface does not currently model.
- A replacement `harness` "owns its retry, timeout, prompt-delivery, and tool-policy behavior." Prefer `command` + `args` and only drop to `harness` for a CLI whose prompt delivery doesn't fit, so gh-aw keeps owning the retry and timeout behavior.

**Action:** add a `setupSteps` member to `HarnessAdapter` in doc 07.

## 2. Safe outputs with the factory App's token — pass

`safe-outputs.github-app` takes `client-id`, `private-key`, `owner`, `repositories` and extra `permissions`, and the schema states: "When configured, a token will be generated using the app credentials and used for **all safe output operations**."

A top-level `github-app` key also exists and acts "as a fallback for all nested github-app token minting operations (on, safe-outputs, checkout, tools.github, dependencies)", so one block at the top of each role workflow covers it.

This confirms the design's load-bearing assumption: because safe-output pushes carry the factory App's token rather than the built-in `GITHUB_TOKEN`, they start `factory-gates` normally. The decision table's claim in doc 02 stands as written.

`safe-outputs.staged` is a bonus the docs don't mention: "When true, emit step summary messages instead of making GitHub API calls (preview mode)." This is how the acceptance tests should exercise a full pipeline on a fixture without opening real PRs or spending on writes — worth adding to the Build Plan's test approach.

## 3. Role dispatch and transcript isolation — pass, but build it as `workflow_call`

**`workflow_call` is a supported trigger**, with typed `inputs`. This is the finding that changes the design.

The current design (doc 07, `factory-run`) has `bsf run` dispatch each role's workflow with `workflow_dispatch`, wait for it, then read its step report. That shape has three costs:

1. A job that waits for another workflow is billed for the whole wait. An agent step has a 45-minute budget, so `factory-run` could sit billing for hours per work item — directly against the "idle factory uses under 15 Actions minutes a day" criterion's spirit and the budget shares.
2. Dispatch-and-poll needs correlation: `workflow_dispatch` returns no run id, so the runner has to search recent runs for its own. That is a race, and gh-aw's own `dispatch-workflow` docs confirm workers "run asynchronously as independent workflow runs."
3. Failure handling is the runner's problem rather than Actions'.

With `workflow_call`, `factory-run` becomes an ordinary workflow whose jobs are the roles:

```yaml
jobs:
  triage:
    uses: ./.github/workflows/factory-role-triage.lock.yml
    with: { work_item: "${{ inputs.work_item }}" }
    secrets: inherit
  spec:
    needs: triage
    uses: ./.github/workflows/factory-role-spec.lock.yml
    with: { work_item: "${{ inputs.work_item }}", triage: "${{ needs.triage.outputs.result }}" }
  build:
    needs: spec
    uses: ./.github/workflows/factory-role-builder.lock.yml
```

What this buys:

- **No wait cost.** Actions sequences the jobs; nothing polls.
- **Transcript isolation becomes structural.** Each role is a separate job on a fresh runner, so the verifier job has no filesystem path to the builder's transcript. The spike item asked whether the verifier's job never sees the builder's transcript; with `workflow_call` the answer is that it *cannot*, rather than that `bsf` declines to pass it. That is a materially stronger guarantee, and it removes a rule `bsf` would otherwise have to enforce correctly forever.
- **Per-role policy parameterization.** Confirmed by the reference docs: "`protected-files` and `patch-format` accept GitHub Actions expression strings, so a reusable `workflow_call` workflow can let callers choose the policy without duplicating the file." This is what makes §6 tractable.
- **Gate feedback stays deterministic.** The retry loop is `factory-run`'s own job graph, with gate results as job outputs.

What it costs:

- Role outputs must pass as job outputs, which are strings capped at 1 MB total per workflow. Step reports and specs must therefore go to `factory-data` or an artifact, with the job output carrying only an id. This is already how the data model works, so it is a clarification rather than a change.
- The retry loop (3 attempts per gate) cannot be expressed as a static job graph. Either `factory-run` re-dispatches itself for attempt *n+1* (cheap: one dispatch, no waiting), or a `matrix` with early exit. Self-redispatch is simpler and keeps each attempt's billing separate, which the cost reporting wants anyway.
- `concurrency.max_runs` can no longer be enforced by counting in-flight dispatches alone; use an Actions `concurrency` group plus the ledger.

`dispatch-workflow` and `call-workflow` safe outputs also exist for agent-chosen fan-out. The factory should not use them for the role chain: routing is deterministic and belongs to `factory-run`, not to an agent's choice. Keep `dispatch-workflow` for the one place the design wants async hand-off — `factory-run` dispatching the next queued item at the end.

**Action:** rewrite doc 07's `factory-run` row and its runtime-model section; add the 1 MB job-output constraint to doc 09; note the self-redispatch retry shape in doc 06's factory-clear loop.

## 4. Pre-agent steps, sidecar services and memex — pass, with three constraints

All four hooks exist:

| Key | When it runs |
| --- | --- |
| `pre-steps` | Very beginning of the agent job, **before checkout** — intended for minting short-lived tokens |
| `pre-agent-steps` | Immediately before AI execution, after all setup |
| `post-steps` | After AI execution — where memex runs |
| `services` | Service containers for the job |

So the memex post-step and the devcontainer/sidecar startup both have a home. Three constraints the docs don't account for:

**4a. Reaching `services:` ports requires a weaker sandbox.** The agent runs inside AWF (Agent Workflow Firewall) in its own container. The agent-runtimes reference is explicit: use `sandbox.agent.runtime: docker-sudo-iptables` "only when the workflow requires `sandbox.agent.allow-host-ports` or access to published GitHub Actions `services:` ports", and "Other profiles reject `allow-host-ports` and published service connectivity." That profile "runs AWF with the host privileges required for legacy iptables networking" and "increases AWF privileges."

The `py-api` fixture is FastAPI + Postgres, so it needs exactly this. The factory therefore cannot claim one uniform sandbox posture: repos whose app needs a sidecar database run their builder and verifier at a measurably weaker isolation level than repos that don't. That is a real trade-off and belongs in doc 02 as a decision with its rationale, and in the setup skill's phase 2 output so the user is told which posture their repo gets.

A better alternative where it works: start the dependency *inside* the agent's network with a `pre-agent-steps` `docker run`, rather than as an Actions `service`. Then the default Docker profile suffices. Needs a live run to confirm AWF permits it.

**4b. "Roles run inside the repo's devcontainer" is not accurate as written.** The agent runs in an AWF-managed container, not in a container the workflow picks. The closest seam is `sandbox.agent.images.agent` ("Agent container image that runs the agentic engine"), but `images` is documented as "Digest-pinned AWF *infrastructure* images" selecting "the container image used for each AWF service role" — these are AWF's own images, which must carry AWF's tooling. Substituting an arbitrary devcontainer image is not what that field is for and should be assumed not to work until tested.

The workable shape is: the job runs on a plain runner; `pre-agent-steps` builds the devcontainer and the agent reaches the app through it, with `sandbox.agent.mounts` ("source:destination:mode") exposing the workspace. The devcontainer is the *app's* environment, not the *agent's*.

**Needs a live run.** This is the spike item most likely to need rework, and the one phase 2 of the setup skill depends on. It could not be tested here: this session has no Docker daemon.

**4c. `pre-steps` runs before checkout**, so token minting for a private data repo belongs there, not in `pre-agent-steps`. Minor, but it decides where the data-repo token comes from.

## 5. gh-aw upgrades reaching compiled `.lock.yml` — pass, via a second App

gh-aw gives three relevant pieces:

- **`actions/setup-cli`** — a composite action that installs the gh-aw CLI inside a workflow, by release tag, major channel or `latest`. So `gh aw compile` can run in Actions.
- **`source` and `source-sha`** — `source-sha` is the "Installed source commit, managed by `gh aw add` and `update`. Used as the immutable base for three-way merges while `source` retains the tracking ref." So gh-aw has a real update path with three-way merging, not just regeneration.
- **`check-for-updates`** (default true) — the activation job "downloads config.json from the gh-aw repository and verifies the compiled version is not blocked and meets the minimum supported version."

That third one matters more than it looks: it is a safety net the design did not know it had. A user whose `.lock.yml` files have gone stale gets a failing activation job naming a blocked version, rather than silently running outdated compiled security logic. The factory should surface that failure on the dashboard as a distinct health state ("lock files need recompiling") rather than as a generic run failure.

The obstruction is credentials, not capability. Compiled lock files live in `.github/workflows/`, which the factory App deliberately cannot write (no `workflows` permission — doc 07), and the built-in `GITHUB_TOKEN` cannot push workflow files either. So a recompile-in-Actions job needs a credential holding `workflows: write`, which the factory App must never hold.

Two options, and the second is better:

1. **Skill repair mode** — the user runs the skill, it recompiles with their own credentials and opens the PR. Preserves the security model exactly. This is the Build Plan's stated fallback. Cost: a gh-aw upgrade needs a human at a terminal, so in practice lock files drift.
2. **A separate recompiler App** holding only `contents: write` + `workflows: write` and nothing else, used by one workflow that installs the pinned gh-aw CLI, recompiles the role sources, and opens a PR. The factory App still cannot touch gates. The recompiler App can touch *only* files, and its PRs hit `factory/policy`, which fails any PR touching `.github/workflows/` without a trusted human's approval — so the human approval that option 1 gets from running the skill, option 2 gets from approving the PR.

Option 2 keeps the invariant that matters ("the bot can't tamper with its own gates") because the recompiler cannot approve its own PR and `factory/policy` loads from main. It costs one more App in setup — one extra pair of clicks.

**Action:** add the recompiler App to doc 07's GitHub App section and doc 05's phase 6, with option 1 as the documented fallback when a user declines the second App. Add the stale-lock health state to doc 08.

## 6. Not on the spike list: gh-aw protects `.factory/` from the factory

`create-pull-request`, `push-to-pull-request-branch` and `merge-pull-request` enforce protected-file checks by default. Protected, among others:

- **"Top-level dot-folders**: any top-level directory whose name starts with `.`, such as `.cursor/`, `.vscode/`, or `.devcontainer/`, **including newly created ones**."
- `.github/`, `.agents/`, `.githooks/`, `.husky/` by path prefix.
- **Dependency manifests by basename anywhere in the repo**: `package.json`, `pyproject.toml`, `go.mod`, `pom.xml`, `Gemfile`, and the rest.
- Engine instruction files: `CLAUDE.md` and `.claude/` for the Claude engine.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`.

The default policy is `request-review`: the PR is created, and gh-aw submits a `REQUEST_CHANGES` review listing the protected files.

Three collisions with the design as specced:

1. **`.factory/` is a top-level dot-folder.** Hardening's whole job is to add rules under `.factory/guardrails/rules/` and lower counts in `.factory/guardrails/baselines.json`. Every hardening PR would arrive carrying an automatic `REQUEST_CHANGES`.
2. **`policy.yaml` lists `pyproject.toml#tool.ruff` as a guardrail path** (doc 09). Hardening tightening a ruff rule edits a protected manifest, matched by basename.
3. **`.claude/settings.json` is the session-capture hook location** (doc 07) and `.claude/` is protected for the Claude engine.

And a subtler one: an automatic `REQUEST_CHANGES` review is authored by the App. Doc 06 says "Approvals from the factory App never count" — correct for approvals, but a *rejection* from the App does count against the PR in GitHub's eyes wherever reviews are required. The merge queue must distinguish the two: ignore App approvals, and treat an App `REQUEST_CHANGES` as a gate signal to resolve rather than as a human's objection.

**The resolution is per-role `protected-files`, and it is a feature, not a workaround.** Because the roles are `workflow_call` workflows and `protected-files` accepts an expression, `factory-run` passes a different policy per pipeline:

| Pipeline | `protected-files` exclusions |
| --- | --- |
| Product work | none — code and tests only |
| Gardening | none |
| Hardening | `.factory/guardrails/` and the rooted manifest paths found at setup (for example `/pyproject.toml`), and nothing else |
| Definition | `.factory/definition/` — and these PRs already require a trusted human |

`exclude` matches by basename or path prefix, and a leading `/` makes it an exact repo-root path, so `"/pyproject.toml"` opts in the root file while `lib/foo/pyproject.toml` stays protected — exactly the granularity needed. A dot-folder prefix such as `.factory/guardrails/` "also opts that directory out of the top-level dot-folder rule."

Nothing excludes `.github/`, ever, in any role.

This gives the factory defense in depth it was not designed for: gh-aw's protected-files check *and* the factory's own `factory/policy` path check, enforced by different code at different layers. Worth keeping both, and worth stating in doc 02 that the overlap is deliberate.

**Action:** add a `protected_files` section per pipeline to `policy.yaml` in doc 09; record the overlap as a decision in doc 02; fix the App-review handling in doc 06's merge queue.

## What still needs a live run before v0.1 ships

1. **4b** — whether the agent can reach an app running in a `pre-agent-steps` devcontainer, with `sandbox.agent.mounts` for the workspace. The phase 2 "prove it works" step depends on it.
2. **4a** — whether a `pre-agent-steps` `docker run` dependency is reachable from inside AWF on the default Docker profile, which would avoid `docker-sudo-iptables` for `py-api`.
3. **§6** — that a hardening role workflow with `protected-files.exclude: [.factory/guardrails/]` opens a PR with no `REQUEST_CHANGES`, and that one *without* the exclusion does get one.
4. That `gh aw compile` accepts the seven role workflows as written, which could not be run in this session.
