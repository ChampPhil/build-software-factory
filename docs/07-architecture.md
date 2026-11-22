# Build Software Factory — Architecture & Repo Layout

Nov 18, 2026 · @Philip

Build Software Factory is a skill that installs a factory into the user's own GitHub repo; the factory then runs on GitHub Actions, stores its data in git refs of that repo, and is viewed through a static dashboard. Nothing is hosted by the maintainer.

## System at a glance

```
 user's machine          user's GitHub repo                       user's browser
+--------------+  setup PR  +-------------------------------+  reads  +---------------+
| setup skill  | ---------> | main: code + .factory/ +      | <------ | dashboard     |
| (agent CLI)  |            |       factory workflows       |         | (static app,  |
+--------------+            | GitHub Actions runs bsf       | ------> | Cloudflare    |
                            | factory-data: runs, index,    | writes  | Pages)        |
                            |   ledger; factory-media       | (PRs,   +---------------+
                            +-------------------------------+ issues)
```

The setup skill runs once on the user's machine. After that, the factory's definition lives in the repo and its engine is a pinned dependency: work arrives as GitHub events, Actions runs the pinned runner, which runs agents and gates, results land as PRs on main and as data on `factory-data`, and the dashboard reads that data straight from GitHub.

**The definition lives in the repo; the engine is a pinned dependency.** Everything that says *what* the factory does (config, policy, roles, context, rubrics, guardrails) is files in the user's repo. The code that *runs* it (`bsf`) is a versioned dependency that every workflow pins to an exact commit SHA. That keeps gates deterministic code an agent can't edit, and makes upgrades a reviewable one-line change that arrives on its own.

## Built on existing open source

The factory reuses mature tools wherever one fits its constraints (free, nothing hosted, works on free GitHub plans, harness-agnostic, MIT-compatible) and writes custom code only where nothing fits.

| Job | Reused tool | What the factory adds |
| --- | --- | --- |
| Running agents inside Actions: read-only sandbox, network firewall, writes only through checked outputs, threat detection, secret redaction | **GitHub Agentic Workflows (gh-aw)**, MIT, maintained by GitHub, generally available on Free, Team and Enterprise | One gh-aw workflow per role; the deterministic orchestration around them |
| Harness execution | gh-aw's built-in `claude` engine (Claude Code), the only harness whose spend gh-aw's credit cap is proven to stop | Nothing; the adapter registry records why the others are not supported |
| Tokens, cost, past local sessions | **memex** (MIT) plus a **LiteLLM** price table | Nothing |
| Trust rules for who may trigger an agent | gh-aw's role checks; rules modelled on **anthropics/claude-code-action**'s actor and permission checks | The `factory:accept` flow for outside and integration-bot issues |
| Per-job GitHub App tokens | **actions/create-github-app-token** | Nothing |
| Merge queue | **GitHub's native merge queue** wherever the repo qualifies (org-owned public repos; private repos on Enterprise Cloud) | A one-PR-at-a-time fallback queue for repos that don't qualify |
| Violation baselines and ratchets | Each linter's **native baseline** (ESLint bulk suppressions in `eslint-suppressions.json`, Oxlint suppressions, Semgrep `--baseline-commit`, and the equivalents in other rule packs); **Betterer** for checks without one | The cross-tool weakening check and suppression caps |
| Mutation testing on changed lines | **StrykerJS** (incremental / changed-line ranges), **Stryker.NET** `--since`, **cargo-mutants** `--in-diff`, **Infection** `--git-diff-lines`, and each rule pack's equivalent | Nothing |
| Diff coverage | **diff-cover** | Nothing |
| Secret scanning and transcript redaction | **gitleaks** rules (MIT); gh-aw's built-in output redaction | Nothing |
| Dependency-graph and clone rules | Existing checkers per rule pack (for example **dependency-cruiser**, **jscpd**) | Nothing |
| Runtime verification evidence | **Playwright** (screenshots, video, traces) and **Playwright MCP** for the verifier agent's browser | Nothing |
| Sandbox definition | The **devcontainer** spec (`devcontainer.json`) | Generating one when the repo has none |
| Language and stack detection | **go-enry** (GitHub Linguist's data) | Detecting existing tool configs and dominant patterns |
| Scorers and benchmark comparisons | **promptfoo** (MIT): LLM-rubric graders, repeated runs, side-by-side configurations | A custom provider that runs a pipeline on a frozen task |
| Runner upgrades | **Dependabot** | Nothing |
| Settings as code (org-wide) | **github/safe-settings** is the recommendation for organizations that want org-wide settings | A thin single-repo sync (safe-settings needs its own App and a central admin repo) |
| Path-policy vocabulary | **Palantir policy-bot**'s YAML vocabulary (`changed_files`, approval rules) | A thin `pull_request_target` check, since policy-bot needs a hosted server |

**Built custom because nothing fits:** correction mining into guardrail candidates; the hardening pipeline; benchmark-gated definition changes; the cross-tool weakening check; the path-policy check and single-repo settings sync; the merge-queue fallback; the git-ref data store, live status and static dashboard; budget shares; and the setup skill.

**Prior art.** Other "software factories" exist (for example addyosmani/factory, claude-software-factory, agent-factory, Elastic's AI software factory). None examined combines five harnesses, turning human corrections into static rules, benchmark-gated self-improvement, a merge queue on free plans and a zero-backend dashboard; that combination is this project's reason to exist, and the README names this prior art.

## Monorepo layout

Everything lives in one public repo, `build-software-factory`, MIT licensed. Each top-level folder ships something different:

| Folder | What it is | Ships as |
| --- | --- | --- |
| `/skill` | The setup skill: `SKILL.md`, phase scripts (`assess`, `mine-corrections`, `install`, `baseline`, `switch-on`), reference notes | A skill folder the user adds to their agent CLI |
| `/runner` | The factory's deterministic runtime, a TypeScript CLI (`bsf`): intake, ledger, pipeline orchestration (dispatching the role workflows and collecting their results), gates orchestration, policy, merge-queue fallback, rollup, audit, settings sync, budget. It never runs an agent itself | A versioned GitHub Action, pinned by commit SHA in each user's workflows (`build-software-factory/runner@<sha>`) |
| `/adapters` | One entry per agent CLI (`claude-code`, `cursor-cli`, `kilo-code`, `pi`, `hermes-agent`): its gh-aw engine (or custom engine definition) and memex source | Bundled into `/runner` and `/templates` |
| `/rules` | Language rule packs for TypeScript, JavaScript, Python, Go, Java, Rust, C#, Ruby: configuration for existing tools (linters and their native baselines, Semgrep rules, dependency-graph and clone checkers, mutation testers, coverage reporters, gitleaks) | Bundled into `/runner`; copied into user repos at setup |
| `/templates` | Everything setup installs into a user repo: thin trigger workflows, one gh-aw workflow source per role (`.md`), default config, roles, rubrics, hooks | Copied by the skill |
| `/schema` | JSON Schemas for every file format (Schemas & Contracts doc) | Bundled into `/runner` and `/dashboard` |
| `/dashboard` | The Next.js static-export dashboard | Deployed to Cloudflare Pages |
| `/worker` | The optional Cloudflare Worker for GitHub sign-in | Deployed by users who pick it, or by the maintainer for the hosted dashboard |
| `/fixtures` | Small test repos used in CI and acceptance tests | Not shipped |
| `/docs` | These docs plus the public README and guides | Published with the dashboard |

- **One version number for everything.** A runner release, its adapters, rule packs and schemas are versioned together; the dashboard reads the schema version from each repo's data.
- **Workflows stay thin.** Installed trigger workflows only set triggers and call `bsf <command>`; all deterministic logic lives in `/runner`. Agent work lives in the gh-aw role workflows, whose prompts come from `.factory/definition/roles/`.
- **gh-aw upgrades.** gh-aw's compiled `.lock.yml` files must be regenerated by `gh aw compile` when gh-aw changes, which Dependabot can't do. Each runner release pins a gh-aw version; how a gh-aw upgrade reaches a user's repo without a local recompile is settled in the v0.1 spike (Build Plan), with the skill's repair mode, which recompiles with the user's own credentials and opens the PR, as the fallback.
- **Upgrades open themselves; a human merges them.** Each workflow pins the runner by SHA with the version in a comment (`runner@<sha> # v0.2.1`). Setup configures GitHub's Dependabot for the `github-actions` ecosystem, limited to the runner, with a 3-day cooldown after each release so a bad or compromised release has time to be caught and pulled. When a release ships, Dependabot opens a PR that bumps the SHA and comment, with the release notes. Dependabot may edit workflow files, so the App still can't.
- **What an upgrade PR gets:** policy allows it to change only the runner pin; it runs the deterministic gates (Dependabot-triggered workflows don't receive the repo's Actions secrets, so no agent step runs); it shows on Home; and a trusted human must approve it, whatever the auto-merge toggles say. If the new runner needs config changes, it opens a migration definition PR on its first run after merge.

## What gets installed into a user's repo

Setup adds four things to the user's repo: a `.factory/` folder, factory workflows, a sandbox definition, and the `factory-data` ref.

```
.factory/
  definition/                 ← factory definition: changes need a trusted human's approval
    factory.yaml              ← pipelines, triggers, schedules, toggles, models, budget
    policy.yaml               ← path policy, trust, guardrail paths
    roles/                    ← triage, spec, builder, verifier, gardener, hardener, scorer
    context/                  ← feature-map.md, runbook.md, fundamentals.md, history.md
    rubrics/                  ← one scorer rubric per pipeline + shared.yaml
  guardrails/                 ← guardrails: hardening may add or tighten
    rules/                    ← custom static rules (Semgrep, AST, dependency graph)
    baselines.json            ← per-rule violation counts during cleanup
    candidates.json           ← mined corrections awaiting a decision
    coverage.json             ← coverage ratchet floor and skip count
  sandbox/                    ← Dockerfile or devcontainer reference + start scripts
.github/workflows/factory-*.yml   ← thin trigger files calling `bsf`
.github/workflows/factory-role-*.md, *.lock.yml   ← one gh-aw workflow per role (source + compiled)
<harness hook configs>        ← e.g. .claude/settings.json, for local session capture
```

- **Existing tool configs stay where they are.** The repo's own linter, type-checker and test configs are guardrails too; `policy.yaml` lists their paths so the gates treat them the same way.
- **Data lives in refs, not branches.** `factory-data` is stored at `refs/factory/data`, `factory-media` at `refs/factory/media`, and live status at `refs/factory/live/<run-id>`. They work like orphan branches (git history, pushes, rebases) but sit outside `refs/heads/`, so they don't show in the branch list and pushing to them doesn't fire `push` workflows. Without this, a team CI that runs `on: push` would run on every factory write and burn its minutes. Readers resolve the ref to a commit, then read files at that commit. In a separate private data repo, the same refs are used.
- **`factory-data` ref** (orphan, never merged): work items, run files, the rollup index, the ledger, review reports, benchmark tasks and session transcripts.
- **`factory-media` ref** (orphan, never merged): screenshots and short clips, kept for `data.media_retention_months` (default 12). Once a month rollup rewrites it as a single commit without expired media, so repo size stays bounded. If the user chose private data storage, the same layout lives in a separate private repo instead. Session transcripts are stored only when the data store is private; on a public repo with its data in the same repo, `sessions/` stays empty.
- **Repo secrets:** the factory GitHub App's ID and private key, plus one model API key per harness the user enabled.

## Runtime model

Fifteen deterministic workflows run the factory, each a thin trigger file that calls `bsf`. Agents run in eight more: one **gh-aw workflow per role** (`factory-role-<role>.md`, compiled by `gh aw compile` into `factory-role-<role>.lock.yml`), started by `factory-run` (the gardener by `factory-garden`), plus the setup agent (`factory-setup-agent.md`), started by `factory-setup`. The compiled roles ship with the skill, so a user needs gh-aw only for a non-default engine or network.

| Workflow | Triggered by | Calls | What it does |
| --- | --- | --- | --- |
| `factory-intake` | Issue opened or labeled, issue/PR comment, review comment on a factory PR, CI failure on main, dashboard "run" button (`workflow_dispatch`) | `bsf intake` | Checks trust, normalizes events into work item files, shortlists possible duplicates, dispatches `factory-run` or leaves items queued. Single concurrency group with `queue: max`, and each run processes every event not yet processed (by cursor), not only the one that started it, so no request is lost if a pending run is dropped |
| `factory-run` | `workflow_dispatch` from intake, gardening, the review, a finishing run, or itself for the next gate attempt | `bsf run <work-item>` | Orchestrates one pipeline: calls each role's gh-aw workflow as a `workflow_call` job in order (`needs:` for sequencing, job outputs for ids), reads its step report from `factory-data`, and feeds gate failures back to the builder by re-dispatching itself for the next attempt; at the end dispatches the next queued item. Nothing polls and nothing is billed while waiting |
| `factory-role-<role>` (gh-aw, ×7) | `workflow_call` from `factory-run` (or the review, for the scorer) | gh-aw | Runs one role's agent in gh-aw's read-only AWF sandbox, behind its network firewall, with the app's sandbox brought up by `bsf sandbox start` in `pre-agent-steps` from the frozen manifest on the default branch. Its only way to change anything is gh-aw safe outputs, applied after threat detection in separate jobs: the builder's code arrives as `create-pull-request` (a draft on its `factory/*` branch) and later attempts as `push-to-pull-request-branch`; comments and labels as `add-comment` and `add-labels`. The caller passes this role's `protected-files` policy. A `post-steps` step runs memex to write the step report |
| `factory-policy` | `pull_request_target` (PR opened, pushed, labeled), review submitted | `bsf policy` | The `factory/policy` check. Because it runs on `pull_request_target`, GitHub always uses main's copy of this workflow, so a PR can't edit it. It never checks out or runs the PR's code: it reads only the list of changed files, reviews and labels, and fails any PR that touches `.github/workflows/`, `.github/dependabot.yml` or `.factory/definition/` without a trusted human's approval, plus the per-pipeline path and test-edit rules |
| `factory-gates` | Every PR and every push to it (the factory's own PRs included); `merge_group` (native merge queue) | `bsf gates` | Agent branches: static rules, ratchets, weakening check, coverage, tests, runtime verification. A commit that only merges main into the branch (the queue's update) re-runs static rules and tests, and agent verification only if main's incoming changes touch the PR's feature folders. Human PRs: the deterministic gates only (agent verification when labeled `factory:verify`). Each gate's result is its check run on the PR's head commit (not the merge commit Actions checks out), so a passed gate is never repeated for the same commit; the final job always reports `factory/gates`, the one check branch protection requires. The runner, the definition and the sandbox manifest a gate uses come from the default branch, never from the change |
| `factory-merge` | PR approved, a factory check completed, a PR becoming eligible for auto-merge; a PR closing | `bsf merge-queue`, `bsf run closed` | Where the repo has GitHub's native merge queue: enables auto-merge so GitHub queues the PR. Elsewhere: the factory's fallback queue; one job works through the whole queue, then exits. When a PR closes, its work item becomes `merged` (with `merged_at`; its runs' outcome too) or `rejected`, and waiting sandbox reports are swept |
| `factory-drop` | `workflow_dispatch` by an owner | `bsf run drop` | Takes work back: each named work item becomes `rejected`, its live run is cancelled and its PR closed with the reason |
| `factory-conflicts` | Push to main; the "Rebuild on main" button on a `factory/conflicts` check | `bsf conflicts scan`, `bsf conflicts button` | Finds open factory PRs that became conflicting, starts a rebuild for each (`factory-run`, reason `conflict`) and puts a grey `factory/conflicts` check with a "Rebuild on main" button on the PR |
| `factory-garden` | Nightly schedule | `bsf budget check`, the gardener role | Runs the gardener agent once: it reads the drift (`bsf garden-scan`) and its picks become gardening work items (`bsf garden-file`), at most `max_prs_per_run`, none overlapping another pick's or an open gardening item's files. Each item then runs builder and verifier in `factory-run`; the gardener does not run again per item |
| `factory-review` | Daily schedule; runs only when its thresholds say so | `bsf review` | The scheduled self-improvement review (every 3 days, early at 50 runs, skipped under 10) |
| `factory-rollup` | Called as the last step of every factory workflow; a daily sweep as backstop | `bsf rollup` | Updates `index.json` and `ledger.json` on `factory-data`; dispatches queued work items when concurrency slots are free (so a crashed run can't stall the queue); monthly, squashes `factory-media` |
| `factory-budget-settle` | Called right after every agent step, before the next one starts | `bsf budget settle` | Replaces the step's budget hold with what it measured: the agent's cost and its threat detection's, each the larger of the session's figure and the tokens at list price; anything unmeasured is charged at the ceiling (§Budget) |
| `factory-audit` | Push to main | `bsf audit` | Re-runs gates on the pushed commit; flags anything that bypassed them |
| `factory-sync` | Push to main that changes `factory.yaml` | `bsf sync-settings` | Applies branch protection, rulesets and repo settings from config |
| `factory-setup` | `workflow_dispatch` once the bootstrap PR is merged; again with an inadequacy report to amend the sandbox | `bsf models`, `bsf sandbox freeze` | Phase 2 as an episode: up to three rounds of the setup agent writing a complete candidate (context files, sandbox manifest, stubs) and a trial measuring the tier it reaches; freezes the best measured round into the setup PR. A round is done only when every dependency's probe passed (sign-in, databases, outside APIs). An amendment merges itself when it changes only the sandbox, reaches no new host or secret, and proves at least what main's did (`bsf sandbox land`), then the changes that reported the need are verified again |
| `factory-recompile` | Push to the default branch changing the sandbox's research hosts or a role's source; `workflow_dispatch` | `bsf recompile-prepare` | With the optional recompiler App: applies the frozen sandbox's choices to the role sources (today, the spec role's research hosts), runs `gh aw compile --strict` and opens a PR. Without it, does nothing and says so |
| `factory-setup-trial` | `workflow_call` from `factory-setup`, once per round | `bsf sandbox trial` | Brings up exactly what a candidate manifest declares on the runner, where Docker is, runs each command, starts the app and screenshots it, and records the tier actually reached with every step's output |

**Concurrency and limits**

- `factory-run` is capped by `factory.yaml` (`concurrency.max_runs`, default 5), well under GitHub Free's 20 concurrent jobs.
- `factory-intake`, `factory-merge`, `factory-rollup` and `factory-sync` each use a single concurrency group, so they never run twice at once. By default a group keeps only one pending run and cancels older pending ones; that's harmless for merge, rollup and sync, which redo all their work each time, and intake uses `queue: max` and drains every unprocessed event.
- **No polling schedules.** Apart from nightly gardening, the daily review check and the daily rollup sweep, nothing runs on a timer: an idle factory uses almost no Actions minutes.
- Each agent step has a time budget (`limits.step_time_budget_sec`, default 75 minutes, the builder's write-run-look-fix loop being the longest) far below GitHub-hosted runners' 6-hour job limit.
- A run that hits its time budget fails its gate attempt and counts toward the retry cap of 3.

## The factory's GitHub App

The factory acts on GitHub as its own GitHub App, created during setup and installed only on the user's repo (and their private data repo, if any).

| Permission | Level | Why |
| --- | --- | --- |
| Contents | Read & write | Push branches, write the `refs/factory/*` refs |
| Pull requests | Read & write | Open draft PRs, comment, merge |
| Issues | Read & write | Read requests, label, comment status |
| Checks / commit statuses | Read & write | Report gate results as required checks |
| Actions | Read & write | Dispatch `factory-run`, read run logs and artifacts |
| Administration | Read & write | Apply branch protection, rulesets and auto-merge settings from `factory.yaml` |
| Metadata | Read | Required by GitHub |
| **Workflows** | **None** | The App can't create or edit `.github/workflows`, so it can't tamper with its own gates |

- **Tokens are short-lived and down-scoped.** Each job mints its own installation token with `actions/create-github-app-token`, asking only for the permissions that job needs; only `factory-sync` gets Administration. Nothing long-lived is stored except the App's private key in repo secrets.
- **The agent never holds a write token.** Agent jobs are gh-aw's read-only sandbox; every write (pushing code, opening the draft PR, commenting, labelling) is a gh-aw safe output, checked by gh-aw's threat detection for prompt injection, leaked secrets and malicious patches, then applied in a separate job with the App's token, so those pushes trigger the gates. gh-aw's network firewall lets the agent reach only the model API, package registries and the app's own sidecar services.
- **The App's actions trigger workflows.** Unlike the built-in `GITHUB_TOKEN`, PRs and pushes made with the App token start `factory-gates` normally.
- **Approvals never come from the App.** The path policy and merge queue ignore any approval whose author is the App; only trusted humans approve. gh-aw's protected-file check can make the App submit an automatic `REQUEST_CHANGES` review (below), so the merge queue treats an App *rejection* as a gate signal to resolve, not as a human's objection.
- **gh-aw's protected-file check is a second, independent layer.** `create-pull-request`, `push-to-pull-request-branch` and `merge-pull-request` protect dependency manifests, `.github/`, engine instruction files and **every top-level dot-folder, `.factory/` included**, defaulting to an automatic `REQUEST_CHANGES` review. Each role workflow is therefore passed a per-pipeline `protected-files` policy by its caller (`policy.yaml`, doc 09): only hardening excludes `.factory/guardrails/` and the rooted manifest paths found at setup, only definition PRs exclude `.factory/definition/`, and nothing excludes `.github/` in any role. The overlap with the factory's own `factory/policy` path check is deliberate: two different layers, enforced by different code.

### The recompiler App

gh-aw's compiled `.lock.yml` files live in `.github/workflows/`, which the factory App must never be able to write. So a second, deliberately minimal App does the recompiling:

| App | Permissions | Used by |
| --- | --- | --- |
| Factory App | the table above, no `workflows` | every factory workflow |
| Recompiler App | `contents: write`, `workflows: write`, nothing else | one workflow: install the pinned gh-aw CLI with `github/gh-aw/actions/setup-cli`, run `gh aw compile`, open a PR |

The recompiler can change files and nothing else — it cannot approve, merge, label or administer — and its PRs hit `factory/policy`, which fails any PR touching `.github/workflows/` until a trusted human approves. The invariant holds: neither App can both rewrite a gate and clear it.

Setup offers this App as two more clicks. A user who declines gets the skill's repair mode instead, recompiling locally with their own credentials. Either way, gh-aw's `check-for-updates` fails the activation job of a lock file that has gone too stale, which the dashboard shows as its own health state rather than a generic run failure.

## Agent CLI adapters

**The factory runs its agents on Claude Code only.** Every harness would run as a gh-aw engine, so the runner never launches agents itself; what decides support is whether gh-aw's per-step credit cap stops the harness, because the budget (§Budget) is built on that cap. Each was tested live with a 2-credit cap:

| Harness | Cap test | Supported |
| --- | --- | --- |
| Claude Code | `bsf-fixtures/go-cli` run 44946845429: the proxy refused the second request (`403 Maximum AI credits exceeded (6.078150 / 2)`) and the agent stopped, $0.061 spent | yes |
| Cursor CLI | run 44940807705: 49 tool calls and about $0.58 spent, 29 times the cap. Cursor's requests go to Cursor's own servers, so gh-aw's proxy never meters them | no |
| pi, Kilo Code, Hermes Agent | not run | no, until a cap test passes |

The engine notes below record what was learned about each while they were candidates.

| Harness | How gh-aw runs it |
| --- | --- |
| Claude Code, pi | gh-aw's built-in engines (`claude`, `pi`) |
| Cursor CLI | gh-aw's built-in `cursor` engine (v1.3.1), with `/adapters/cursor-cli.md` vendored beside it as the reference definition and imported by every Cursor role workflow; `CURSOR_API_KEY` auth. **Proven live** on `bsf-fixtures/go-cli` (issue #21 → PR #22): triage, spec, builder and verifier all ran on Cursor and every gate passed |
| Kilo Code, Hermes Agent | A behaviour-defined engine definition this project would have to write. gh-aw ships no engine for either, so these cannot be finished without the CLI installed and run; `/adapters` records that rather than shipping a guess |

- **The sandbox posture is a compile-time decision.** gh-aw accepts no expression for `sandbox.agent.runtime` — it is a literal from a four-value enum — so the posture cannot come from a repo variable. Phase 2 of setup decides it and phase 6 writes the literal in before compiling; changing it afterwards needs a recompile, which is the recompiler App's job or the skill's repair mode.
- **`allowed-files` is not usable as a per-pipeline allowlist.** It takes a literal array and is *exclusive*: every file in a patch must match it, so anything unlisted is refused, including ordinary source files. It also accepts no expression. The per-pipeline path allowlist therefore stays with `factory/policy` and gh-aw's `protected-files`, and no role sets `allowed-files`.
- **Adapters are engine definitions, not `engine.command`** (changed during the build; see Build Plan §Spike). gh-aw accepts a complete engine definition whose `engine.behaviors` carries `installation`, `execution`, `capabilities`, `network.provider-domains` and a `log-parser`. gh-aw then installs the CLI, runs it, and parses its log into the unified session artifact, keeping its own retry, timeout and tool-policy behaviour. `engine.command` would run the binary but leave the factory owning install steps and log parsing; `engine.harness` would replace prompt delivery and its retry behaviour with ours. The definition is the middle option and the one gh-aw's own third-party samples use.
- **"Adding a harness = one adapter entry" holds only for a well-behaved CLI.** gh-aw's own OpenCode sample needed a ~200-line `harness-script` on top of the definition, plus a custom log parser, and is labelled an unsupported repository sample. A CLI whose headless mode emits clean JSONL needs the definition alone; one that does not needs a harness script, which is a different size of job. Each adapter in `/adapters` records what it still needs, and no harness is shippable until a conformance run proves its step yields token data.
- **Only Claude Code is installed.** The installer has no harness flag; a repo whose `factory.yaml` names another harness (an earlier version allowed Cursor) is switched back with its models, and `bsf budget reserve` refuses to start any agent step on another harness.
- **Only the App's safe-output token is a write path.** Each role workflow sets `safe-outputs.github-app` to the factory App, so every safe output is applied with that token and its pushes start `factory-gates`.

```ts
interface HarnessAdapter {
  id: "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";
  engineId: string;               // the `engine:` a role workflow sets
  engineDefinition: string | null;// null for gh-aw's built-ins; else the file in /adapters
  keySecret: string;              // one key covers four; Cursor needs its own
  memex: {
    engineLabel: string;          // the engine's name in memex's own table
    store: string | null;         // the session store memex documents, where it does
    tokenUsage: "yes" | "credits_only" | "no";
  };
  localHook: { path: string; kind: "hooks" | "none" };
  status: { kind: "builtin" | "definition"; conformance: "passed" | "not_run"; needs: string[] };
}
```

- **No adapter hardcodes a memex source name.** memex documents each engine's session store but not its full `--source` list, and a guessed name fails silently: the step reports no tokens and a cost of zero that the budget then believes. Setup asks the installed memex for its sources and matches on the engine label, falling back to the documented store path; when neither matches it refuses the harness and names the sources it did find.

- **Tokens and cost: gh-aw's session evidence first, then memex** (changed during the build). gh-aw already normalizes per-step `totalCostUsd` and token `usage` into `agent-session.jsonl`, and its API proxy meters tokens independently of what the CLI claims, into `token-usage.jsonl` — both inside the agent job, which is where the role workflow's post-step runs. So the order is: gh-aw's normalized session, then its proxy metering, then the harness's own session log read with **memex** (MIT), then the bundled **LiteLLM** price table to price tokens that arrived without a cost. When none of them has it, the report says `cost_source: "unknown"`.
- **An unknown cost is never written as zero.** The budget pauses pipelines on spend, so a fabricated zero quietly raises the ceiling on what the factory may spend. gh-aw's session specification states the same rule — absence is not zero — and the step report carries a `usage_source` so a missing cost is diagnosable rather than invisible.
- **Past local sessions: memex.** This is the job gh-aw cannot do, and memex's real reason to be here. Setup's correction mining and `bsf contribute-corrections` read past sessions on the user's own machine for all five harnesses, which memex covers with token counters for each (`~/.local/share/kilo/kilo.db` or `$XDG_DATA_HOME/kilo/kilo.db` for Kilo Code, a local `state.db` for Hermes). One limit worth stating: memex reads Hermes's usage counters and metadata but not its message content, so Hermes sessions can be costed and cannot be mined for corrections.
- **`StepReport` is mandatory and identical for every harness:** exit status, normalized transcript path, files changed, tokens in/out/cached, cost in USD, duration (format in Schemas & Contracts). A harness whose step yields no token data fails conformance and isn't shippable.
- **One key.** The factory needs one Anthropic API key, `ANTHROPIC_API_KEY`, for every agent step and threat-detection check.
- **Dependencies are pinned.** gh-aw, memex and each harness CLI are pinned to exact versions in the runner release, and the adapter conformance suite runs a real step per harness on every release, so a change in any of them shows up as a failing test, not wrong numbers.
- **Adding a harness** = one adapter entry (its gh-aw engine and memex source) plus a conformance run — *when gh-aw already has an engine for it.* That covers more than the five this spec names: gh-aw has built-in engines for Codex, Copilot, Gemini and Antigravity, and maintained definitions for OpenCode, goose, Kiro, aider, crush, Factory, LangGraph, mini-swe-agent and DeepSeek. `adapters.ts` lists them, with whether memex also reads each one's local sessions. When gh-aw has no engine, adding a harness is an integration of unknown size instead, and the two in that position are recorded as such.

## Budget

The budget is a ceiling, not an estimate: **the factory stops before it can
spend past it, even if that means stopping with money left.** It is kept in
one file on the data ref, `budget.json` (schema `budget/2`): this month's spend
per pipeline, the holds of steps still running, and the keys already charged.

**Before an agent step** (`bsf budget reserve`, the role workflow's first
step after fetching the trusted runner, before the sandbox starts) the step
holds its ceiling: its gh-aw `max-ai-credits` cap, plus the most one request
can cost, for the agent and again for its threat-detection check. One request
is added because gh-aw checks the cap before each request, so the request that
crosses it still finishes: in the live cap test the cap was 2 credits and the
run stopped at 6.08. The most one request can cost is bounded by two settings
every role sets, `CLAUDE_CODE_DISABLE_1M_CONTEXT` (a 200k window, so with one
capped tool result on top no request sends more than 250k tokens) and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`, priced at the dearest list rate
(`runner/src/lib/prices.ts`, Anthropic's published prices). The step starts
only if this month's spend, the holds of steps still running and its own hold
fit within the monthly budget and within its pipeline's share; otherwise it
exits before the agent is invoked and says why on the job summary. A model
with no list price cannot be bounded, so a step on one does not start.

**After the step**, the role uploads what it measured (`bsf budget measure`):
the agent's cost, taken as the larger of what its session reported and what
its tokens cost at list price. The caller's next job, `factory-budget-settle`,
which every following agent step waits for, adds the threat-detection run's
cost from that job's own usage record and replaces the hold with the measured
charge. Whatever cannot be measured is charged at its full hold, never as
zero, and a hold that is never settled (a cancelled run) is charged in full by
the rollup after four hours.

**Every write is a compare-and-swap** on the data ref: the new `budget.json`
is committed on the very commit it was read from, and the non-forced ref
update fails if anyone wrote in between, so the writer re-reads and decides
again. Two runs reading the same last dollars cannot both be told yes.

**Work that cannot fit waits.** Dispatch treats a pipeline as paused when
what is left of the total or of its share cannot cover the largest single step
its run would hold (for product work on the defaults, the Opus spec), and a
run's plan checks the same before claiming its item. Queued work then stays
queued until the month turns or the budget is raised, instead of starting runs
that would be refused halfway.

**Shares.** Gardening (25% by default) and review and benchmarks (15%) stay
within their share. Product work may use whatever they leave, up to the whole
budget. Setup is charged against the total only.

**Actions minutes are not counted by the factory.** GitHub's own Actions
spending limit, $0 by default, already stops runners at a plan's included
minutes. On a private Free repository that is 2,000 a month;
`estimate-spend.mjs` estimates what the factory will use.

**Proven live** on `bsf-fixtures/go-cli` (doc 12): a $0.01 budget refused the
first step before its agent started and charged nothing; with $15, the
builder was refused before it started because its hold would have passed
product work's share as the rules stood then (product work may now use the
whole budget); and across every step of the proof the factory
charged at or above what each step really cost.

## Data flow

All factory data lands on the `factory-data` ref (or the private data repo), written append-only so parallel runs never conflict.

```
factory-data/
  index.json                  ← rollup: metrics, recent runs, open work (one file the dashboard reads first)
  ledger.json                 ← derived from work items and open PRs, plus the merge queue order
  work-items/<id>.json        ← one file per work item, including its spec
  runs/2026/11/<run-id>.json  ← one file per run, written once at run end
  reviews/<date>.json         ← scheduled review reports
  benchmarks/tasks/<id>.json  ← benchmark tasks built from completed work
  sessions/<session-id>.jsonl ← redacted local agent transcripts (from hooks; private stores only)

factory-media/
  media/<run-id>/…            ← key screenshots, short clips, diagrams (size-capped, kept 12 months by default)

refs/factory/live/<run-id>         ← one small status file per in-progress run, force-updated, deleted at run end
```

1. **During a run:** at every step change the runner force-updates the run's status file on `refs/factory/live/<run-id>` (step, gate, attempt, cost so far); the Live view polls it. The ref is deleted at run end.
2. **At run end:** the runner writes the run file and updates the work item on `factory-data`, and pushes media to `factory-media`. A push that loses a race simply rebases and retries, since every run writes new files only.
3. **At the end of every factory workflow:** a final rollup step recomputes `index.json` and `ledger.json` (single concurrency, so they're never written twice at once); a daily sweep catches anything a cancelled workflow missed.
4. **Long artifacts:** full verification videos, logs and raw runtime traces upload as workflow artifacts; the run file stores their artifact IDs and expiry date, and nothing depends on them after they expire.
5. **Local sessions:** for a developer who opted in on their machine, each harness's end-of-session hook redacts secrets from the transcript and pushes it to `sessions/` with the branch name, so it links to the PR it produced. The hook checks where the data lives first and never pushes a transcript to a public branch.

**Redaction** runs before anything is stored: known secret formats, values of repo secrets and `.env` entries, and long high-entropy strings are replaced with `[REDACTED]`.

## Enforcement and security model

The factory enforces its rules with its own gates, and uses GitHub's branch protection on top wherever the user's plan allows it.

1. **Trust at intake.** Only events from trusted people start agent work: authors whose association is owner, member or collaborator with write access. Trust belongs to people, never integrations: issues created by an integration's bot account (Linear, Sentry) wait for a one-click accept like any outside issue. Anything untrusted waits until a trusted person adds the `factory:accept` label, and comments from untrusted authors are stripped from prompts. Untrusted events never reach a job that holds secrets.
2. **Policy from main.** On a PR, GitHub runs the workflow files from the PR itself, so a PR (a fork's above all) could rewrite `factory-gates.yml` to always pass. The `factory/policy` check closes this: it runs on `pull_request_target`, which always uses main's copy of the workflow, loads `policy.yaml` from main, and fails any PR that touches workflow or definition files until a trusted human approves. It is a required check. GitHub's own fix, required workflows through rulesets, is only on Enterprise Cloud, so the factory doesn't rely on it. Its rules use Palantir policy-bot's YAML vocabulary, so teams that know policy-bot can read them; policy-bot itself isn't used because it needs a hosted server.
3. **Path policy per pipeline.** Product work and gardening may change code and tests; hardening may also change guardrail paths; only a PR approved by a trusted human may change `.factory/definition/`. Any pipeline may lower baseline counts and raise the coverage floor. A factory PR may modify or delete existing test files only if its spec declared them.
4. **Weakening check.** Removing or loosening a rule, raising a baseline, lowering the coverage floor or adding a skip without a reason fails the gate unless a trusted human approves.
5. **The App can't touch workflows, and the agent can't write to GitHub.** No `workflows` permission, so gate files can only change through a human's own push; each job's token is down-scoped, and agents write only through gh-aw safe outputs after threat detection.
6. **The factory merges only through a queue.** GitHub's native merge queue where the repo qualifies, the factory's fallback queue elsewhere; it is the only path factory PRs take into main, and it merges only after the gates pass on the final commit.
7. **Branch protection where available.** On public repos and paid plans, `factory-sync` adds the factory's checks as required, requires branches to be up to date with main before merging, and blocks direct pushes to main. It only adds: existing rules, required reviews and required checks are kept. "Up to date before merging" means a human PR is re-checked against the latest main too, so a human PR and a factory PR can't each pass alone and break main together.
8. **Human PRs keep their normal flow.** They run the deterministic gates (static rules, tests, coverage) and merge however the team already merges, through those checks. Agent runtime verification runs on a human PR only when someone adds `factory:verify`. Where the repo already has a CI test check that runs on the factory's branches, Gate 2 reads its result instead of re-running the tests; if that result hasn't arrived within 15 minutes, the gate runs the tests itself.
9. **Audit where it isn't.** On free private repos, `factory-audit` re-runs the gates on every push to main and flags any bypass on the dashboard, with an optional revert PR.
10. **Fork PRs.** PRs from forks run only the gates that need no secrets; agent work never starts from a fork.
11. **A budget that cannot be passed.** Every agent step reserves its worst case before it starts and is charged what it measured afterwards; gardening and review stay within their shares and product work may use the rest, never past the total (§Budget).

## What a person sees on a PR

Every factory PR, setup PR and escalation is rendered by the runner from the
roles' reports (`schema/pr-report.json`), never from text an agent wrote into
the PR. One layout everywhere:

1. **Summary** — at most three lines: what changed, why, what someone would notice.
2. **Proof** — an ordered mix of files (screenshots, GIFs, recordings, logs,
   API responses) and Mermaid diagrams, as many as the change needs: the
   builder's, then the verifier's under "Checked independently by the
   verifier". Images show inline; a video shows its poster linking to the
   file, since GitHub plays only its own uploads; text proof shows inline.
   When the body cannot hold it all, the rest continues in one PR comment.
3. **Key things to focus on** — the biggest changes to be aware of.
4. **Read more** — the full spec, a technical and a conceptual breakdown.

Files are stored on `refs/factory/media` under `reports/<work item>/`, and each
has a URL there. `bsf report store` stores a role's report in its post-step;
`bsf report publish` renders the PR in `factory-run` (once with the builder's
report, again when the verifier's is in) and reports `factory/pr-report`,
which fails and names the part that is missing. Setup PRs are rendered with
`bsf report setup`, the trial's screenshot of the app first.

## Merge queue and conflict mechanics

Every factory PR reaches main through a merge queue that re-checks it against the latest main.

- **Native first.** GitHub's merge queue is available in public repos owned by an organization and in private repos of organizations on Enterprise Cloud. There, `factory-sync` turns it on in the ruleset, `factory-gates` runs on `merge_group`, and `factory-merge` only enables auto-merge on eligible PRs; GitHub does the queueing, batching and merging.
- **Fallback elsewhere** (personal-account repos, private repos without Enterprise Cloud): the factory's own one-at-a-time queue below. Existing open-source alternatives were evaluated: Bors-NG is archived, Kodiak and Mergify need a hosted service, and merge-queue-action is too young to depend on.

**Entering the queue** — a PR is queued when its gates pass and either a trusted human approved it or its pipeline's auto-merge toggle is on. Queue order is the time it became eligible; the queue lives in `ledger.json`. `factory-merge` starts on the events that can change eligibility (an approval, a check finishing, a toggle), works through the queue in one job, and exits when it's empty.

**Fallback queue: processing one PR** (`factory-merge`, single concurrency):

1. **Fast path:** if the PR's branch already contains the current main and its gates passed on that exact commit, mark it ready for review and squash-merge it now.
2. Otherwise update the branch from main through GitHub's update-branch API.
3. Re-run the gates on the new commit (timeout 60 minutes): static rules and tests always; agent runtime verification only if the changes that came in from main touch the PR's feature folders.
4. Gates pass → mark ready for review, squash-merge. Gates fail → remove from the queue and send it back to its pipeline as a gate failure (counts toward the retry cap).
5. Update fails with a conflict → remove from the queue and dispatch a conflict resolution run.

**Conflict rebuild** (started by `factory-conflicts` whenever a push to main makes an open factory PR conflict, by the merge queue when updating a PR from main conflicts, and by the check's button):

1. The builder makes the same change again on the current main, from the old PR's diff and what main has since done to the same files (`bsf conflicts context`). It opens as a new PR; the old one is closed with a pointer to it and kept on the work item as `previous_prs`.
2. Rebuilding, rather than merging main into the branch, means the App never pushes main's workflow changes, so it never needs the `workflows` permission.
3. The new PR goes through the gates like any change.
4. A person's approval on the old PR carries to the new one when the rebuilt change touches the same files, adds exactly the lines the approved change added, and removes only lines it removed. Anything else — an extra line, a dropped change from main, a file GitHub will not diff — asks for approval again.
5. A rebuild that cannot finish escalates like any run, and the button on the PR's `factory/conflicts` check starts it again.
