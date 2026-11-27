# Architecture

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
| Scorers | **promptfoo** (MIT): LLM-rubric graders | Role steps that grade a run against a rubric |
| Runner upgrades | **Dependabot** | Nothing |
| Settings as code (org-wide) | **github/safe-settings** is the recommendation for organizations that want org-wide settings | A thin single-repo sync (safe-settings needs its own App and a central admin repo) |
| Path-policy vocabulary | **Palantir policy-bot**'s YAML vocabulary (`changed_files`, approval rules) | A thin `pull_request_target` check, since policy-bot needs a hosted server |

**Built custom because nothing fits:** correction mining into guardrail candidates; the hardening pipeline; the cross-tool weakening check; the path-policy check and single-repo settings sync; the merge-queue fallback; the git-ref data store, live status and static dashboard; budget shares; and the setup skill.

**Prior art.** Other software factories exist (for example addyosmani/factory, claude-software-factory, agent-factory, Elastic's AI software factory). None examined combines turning human corrections into static rules, a review that feeds hardening, a merge queue on free plans, and a dashboard with no backend. That combination is why this factory exists.

## Monorepo layout

Everything lives in one public repo, `build-software-factory`, Apache 2.0 licensed. Each top-level folder ships something different:

| Folder | What it is | Ships as |
| --- | --- | --- |
| `/skill` | The setup skill: `SKILL.md`, phase scripts (`assess`, `mine-corrections`, `install`, `baseline`, `switch-on`), reference notes | A skill folder the user adds to their agent CLI |
| `/runner` | The factory's deterministic runtime, a TypeScript CLI (`bsf`): intake, ledger, pipeline orchestration (dispatching the role workflows and collecting their results), gates orchestration, policy, merge-queue fallback, rollup, audit, settings sync, budget. It never runs an agent itself | A versioned GitHub Action, pinned by commit SHA in each user's workflows (`build-software-factory/runner@<sha>`) |
| `/adapters` | One entry per agent CLI (`claude-code`, `cursor-cli`, `kilo-code`, `pi`, `hermes-agent`): its gh-aw engine (or custom engine definition) and memex source | Bundled into `/runner` and `/templates` |
| `/rules` | Language rule packs for TypeScript, JavaScript, Python, Go, Java, Rust, C#, Ruby: configuration for existing tools (linters and their native baselines, Semgrep rules, dependency-graph and clone checkers, mutation testers, coverage reporters, gitleaks) | Bundled into `/runner`; copied into user repos at setup |
| `/templates` | Everything setup installs into a user repo: thin trigger workflows, one gh-aw workflow source per role (`.md`), default config, roles, rubrics, hooks | Copied by the skill |
| `/schema` | JSON Schemas for every file format ([Schemas](Schemas.md)) | Bundled into `/runner` and `/dashboard` |
| `/dashboard` | The Next.js static-export dashboard | Deployed to Cloudflare Pages |
| `/worker`, `/functions` | The sign-in function (`worker/src/index.ts` holds the logic and tests; `functions/api/auth/` connects it to Cloudflare Pages) | Deployed with the dashboard, on its own address |
| `/fixtures` | Small test repos used in CI and acceptance tests | Not shipped |
| `/docs` | These docs plus the public README and guides | Published with the dashboard |

- **One version number for everything.** A runner release, its adapters, rule packs and schemas are versioned together; the dashboard reads the schema version from each repo's data.
- **Workflows stay thin.** Installed trigger workflows only set triggers and call `bsf <command>`; all deterministic logic lives in `/runner`. Agent work lives in the gh-aw role workflows, whose prompts come from `.factory/definition/roles/`.
- **gh-aw upgrades.** gh-aw's compiled `.lock.yml` files must be regenerated by `gh aw compile` when gh-aw changes, which Dependabot can't do. Each runner release pins a gh-aw version. The recompiler App, under The factory's GitHub App below, carries a gh-aw upgrade into a user's repo. The skill's repair mode is the fallback: it recompiles with the user's own credentials and opens the pull request.
- **Upgrades open themselves; a human merges them.** One workflow, `factory-runner-pin.yml`, pins the runner release by SHA with the version in a comment (`runner@<sha> # v0.2.1`), as a `uses:` of `runner/action.yml`, which is deliberately inert: it reports the release's version and the checksum of its packed runner, with no network, no secrets and no writes. The runner the other workflows execute is still the vendored copy in `.factory/bin`, taken from the default branch, so a pull request can never grade itself with a modified runner; moving execution onto the pin would have meant re-deriving how install and upgrade are told apart in every gate, and the pin does not need to execute anything to be upgradeable. Setup configures GitHub's Dependabot for the `github-actions` ecosystem, limited to the runner, with a 3-day cooldown after each release so a bad or compromised release has time to be caught and pulled. When a release ships, Dependabot opens a PR that bumps the SHA and comment, with the release notes; merging it is the approval. On the merge, the pin workflow's `sync` job copies that release's `skill/runner` over `.factory/bin` and opens a second PR through the recompiler App, which a person merges too because the runner is a protected path. Nothing from the new release runs until then. Without the recompiler App the workflow says so and the copy is done by the setup skill's upgrade. Dependabot may edit workflow files, so the App still can't.
- **What an upgrade PR gets:** policy allows it to change only the runner pin; it runs the deterministic gates (Dependabot-triggered workflows don't receive the repo's Actions secrets, so no agent step runs); it shows on Home; and a trusted human must approve it, whatever the auto-merge toggles say. If the new runner needs config changes, it opens a migration definition PR on its first run after merge.

## What gets installed into a user's repo

Setup adds four things to the user's repo: a `.factory/` folder, factory workflows, a sandbox definition, and the `factory-data` ref.

```
.factory/
  definition/                 ← factory definition: changes need a trusted human's approval
    factory.yaml              ← pipelines, triggers, schedules, toggles, models, budget (changed from the dashboard, never by hand)
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
- **`factory-data` ref** (orphan, never merged): work items, run files, the rollup index, the ledger, review reports and session transcripts.
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
| `factory-review` | Daily schedule; runs only when its thresholds say so | `bsf review` | The scheduled self-improvement review (every 3 days, early at 50 runs, skipped under 5; the first review waits only for day 3) |
| `factory-rollup` | Called as the last step of every factory workflow; a daily sweep as backstop | `bsf rollup` | Updates `index.json` and `ledger.json` on `factory-data`; dispatches queued work items when concurrency slots are free (so a crashed run can't stall the queue); monthly, squashes `factory-media` |
| `factory-budget-settle` | Called right after every agent step, before the next one starts | `bsf budget settle` | Replaces the step's budget hold with what it measured: the agent's cost and its threat detection's, each the larger of the session's figure and the tokens at list price; anything unmeasured is charged at the ceiling ([Budget](Budget.md)) |
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
- **gh-aw's protected-file check is a second, independent layer.** `create-pull-request`, `push-to-pull-request-branch` and `merge-pull-request` protect dependency manifests, `.github/`, engine instruction files and **every top-level dot-folder, `.factory/` included**, defaulting to an automatic `REQUEST_CHANGES` review. Each role workflow is therefore passed a per-pipeline `protected-files` policy by its caller (`policy.yaml`, [Schemas](Schemas.md)): only hardening excludes `.factory/guardrails/` and the rooted manifest paths found at setup, only definition PRs exclude `.factory/definition/`, and nothing excludes `.github/` in any role. The overlap with the factory's own `factory/policy` path check is deliberate: two different layers, enforced by different code.

### The recompiler App

gh-aw's compiled `.lock.yml` files live in `.github/workflows/`, which the factory App must never be able to write. So a second, deliberately minimal App does the recompiling:

| App | Permissions | Used by |
| --- | --- | --- |
| Factory App | the table above, no `workflows` | every factory workflow |
| Recompiler App | `contents: write`, `workflows: write`, nothing else | one workflow: install the pinned gh-aw CLI with `github/gh-aw/actions/setup-cli`, run `gh aw compile`, open a PR |

The recompiler can change files and nothing else — it cannot approve, merge, label or administer — and its PRs hit `factory/policy`, which fails any PR touching `.github/workflows/` until a trusted human approves. The invariant holds: neither App can both rewrite a gate and clear it.

Setup offers this App as two more clicks. A user who declines gets the skill's repair mode instead, recompiling locally with their own credentials. Either way, gh-aw's `check-for-updates` fails the activation job of a lock file that has gone too stale, which the dashboard shows as its own health state rather than a generic run failure.

## Agent CLI adapters

**The factory runs its agents on Claude Code only.** Every harness would run as a gh-aw engine, so the runner never launches agents itself; what decides support is whether gh-aw's per-step credit cap stops the harness, because the budget ([Budget](Budget.md)) is built on that cap. Each was tested live with a 2-credit cap:

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
- **Adapters are engine definitions, not `engine.command`** gh-aw accepts a complete engine definition whose `engine.behaviors` carries `installation`, `execution`, `capabilities`, `network.provider-domains` and a `log-parser`. gh-aw then installs the CLI, runs it, and parses its log into the unified session artifact, keeping its own retry, timeout and tool-policy behaviour. `engine.command` would run the binary but leave the factory owning install steps and log parsing; `engine.harness` would replace prompt delivery and its retry behaviour with ours. The definition is the middle option and the one gh-aw's own third-party samples use.
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
- **`StepReport` is mandatory and identical for every harness:** exit status, normalized transcript path, files changed, tokens in/out/cached, cost in USD, duration (format in [Schemas](Schemas.md)). A harness whose step yields no token data fails conformance and isn't shippable.
- **One key.** The factory needs one Anthropic API key, `ANTHROPIC_API_KEY`, for every agent step and threat-detection check.
- **Dependencies are pinned.** gh-aw, memex and each harness CLI are pinned to exact versions in the runner release, and the adapter conformance suite runs a real step per harness on every release, so a change in any of them shows up as a failing test, not wrong numbers.
- **Adding a harness** = one adapter entry (its gh-aw engine and memex source) plus a conformance run — *when gh-aw already has an engine for it.* That covers more than the five this spec names: gh-aw has built-in engines for Codex, Copilot, Gemini and Antigravity, and maintained definitions for OpenCode, goose, Kiro, aider, crush, Factory, LangGraph, mini-swe-agent and DeepSeek. `adapters.ts` lists them, with whether memex also reads each one's local sessions. When gh-aw has no engine, adding a harness is an integration of unknown size instead, and the two in that position are recorded as such.

## Limits of the runtime

- Artifacts expire: at most 90 days in public repos, up to 400 days in private ones. Workflow run records are cleaned up on the same schedule → the factory copies the media humans review to long-lived storage (its own git ref, kept 12 months by default), and a run file never depends on a workflow run still existing.
- Minutes are billed per job and rounded up to a whole minute, and private repos only get a small monthly allowance → the factory runs on events, never on a polling timer, so an idle factory costs close to nothing.
- In public repos, scheduled workflows are disabled after 60 days with no repo activity → the dashboard flags it if gardening stops running.

## Data flow

All factory data lands on the `factory-data` ref (or the private data repo), written append-only so parallel runs never conflict.

```
factory-data/
  index.json                  ← rollup: metrics, recent runs, open work (one file the dashboard reads first)
  ledger.json                 ← derived from work items and open PRs, plus the merge queue order
  work-items/<id>.json        ← one file per work item, including its spec
  runs/2026/11/<run-id>.json  ← one file per run, written once at run end
  reviews/<date>.json         ← scheduled review reports
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
