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

## Monorepo layout

Everything lives in one public repo, `build-software-factory`, MIT licensed. Each top-level folder ships something different:

| Folder | What it is | Ships as |
| --- | --- | --- |
| `/skill` | The setup skill: `SKILL.md`, phase scripts (`assess`, `mine-corrections`, `install`, `baseline`, `switch-on`), reference notes | A skill folder the user adds to their agent CLI |
| `/runner` | The factory runtime, a TypeScript CLI (`bsf`) that every workflow calls: intake, routing, pipeline steps, gates, merge queue, rollup, audit, settings sync | A versioned GitHub Action, pinned by commit SHA in each user's workflows (`build-software-factory/runner@<sha>`) |
| `/adapters` | One adapter per agent CLI: `claude-code`, `cursor-cli`, `kilo-code`, `pi`, `hermes-agent` | Bundled into `/runner` |
| `/rules` | Language rule packs (static rules, coverage config, ratchet support) for TypeScript, JavaScript, Python, Go, Java, Rust, C#, Ruby | Bundled into `/runner`; copied into user repos at setup |
| `/templates` | Everything setup installs into a user repo: workflows, default config, roles, rubrics, hooks | Copied by the skill |
| `/schema` | JSON Schemas for every file format (Schemas & Contracts doc) | Bundled into `/runner` and `/dashboard` |
| `/dashboard` | The Next.js static-export dashboard | Deployed to Cloudflare Pages |
| `/worker` | The optional Cloudflare Worker for GitHub sign-in | Deployed by users who pick it, or by the maintainer for the hosted dashboard |
| `/fixtures` | Small test repos used in CI and acceptance tests | Not shipped |
| `/docs` | These docs plus the public README and guides | Published with the dashboard |

- **One version number for everything.** A runner release, its adapters, rule packs and schemas are versioned together; the dashboard reads the schema version from each repo's data.
- **Workflows stay thin.** Installed workflow files only set triggers and call `bsf <command>`; all logic lives in `/runner`.
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
<harness hook configs>        ← e.g. .claude/settings.json, for local session capture
```

- **Existing tool configs stay where they are.** The repo's own linter, type-checker and test configs are guardrails too; `policy.yaml` lists their paths so the gates treat them the same way.
- **Data lives in refs, not branches.** `factory-data` is stored at `refs/factory/data`, `factory-media` at `refs/factory/media`, and live status at `refs/factory/live/<run-id>`. They work like orphan branches (git history, pushes, rebases) but sit outside `refs/heads/`, so they don't show in the branch list and pushing to them doesn't fire `push` workflows. Without this, a team CI that runs `on: push` would run on every factory write and burn its minutes. Readers resolve the ref to a commit, then read files at that commit. In a separate private data repo, the same refs are used.
- **`factory-data` ref** (orphan, never merged): work items, run files, the rollup index, the ledger, review reports, benchmark tasks and session transcripts.
- **`factory-media` ref** (orphan, never merged): screenshots and short clips, kept for `data.media_retention_months` (default 12). Once a month rollup rewrites it as a single commit without expired media, so repo size stays bounded. If the user chose private data storage, the same layout lives in a separate private repo instead. Session transcripts are stored only when the data store is private; on a public repo with its data in the same repo, `sessions/` stays empty.
- **Repo secrets:** the factory GitHub App's ID and private key, plus one model API key per harness the user enabled.

## Runtime model

Eleven workflows run the factory; each is a thin trigger file that calls one `bsf` command.

| Workflow | Triggered by | Calls | What it does |
| --- | --- | --- | --- |
| `factory-intake` | Issue opened or labeled, issue/PR comment, review comment on a factory PR, CI failure on main, dashboard "run" button (`workflow_dispatch`) | `bsf intake` | Checks trust, normalizes events into work item files, shortlists possible duplicates, dispatches `factory-run` or leaves items queued. Single concurrency group with `queue: max`, and each run processes every event not yet processed (by cursor), not only the one that started it, so no request is lost if a pending run is dropped |
| `factory-run` | `workflow_dispatch` from intake, gardening, the review, or a finishing run | `bsf run <work-item>` | Runs one pipeline in the sandbox; pushes each attempt to its `factory/*` branch; opens a draft PR once gates pass; at the end dispatches the next queued item |
| `factory-policy` | `pull_request_target` (PR opened, pushed, labeled), review submitted | `bsf policy` | The `factory/policy` check. Because it runs on `pull_request_target`, GitHub always uses main's copy of this workflow, so a PR can't edit it. It never checks out or runs the PR's code: it reads only the list of changed files, reviews and labels, and fails any PR that touches `.github/workflows/`, `.github/dependabot.yml` or `.factory/definition/` without a trusted human's approval, plus the per-pipeline path and test-edit rules |
| `factory-gates` | Push to a `factory/*` branch; every human PR and push to it | `bsf gates` | Agent branches: static rules, ratchets, weakening check, coverage, tests, runtime verification. A commit that only merges main into the branch (the queue's update) re-runs static rules and tests, and agent verification only if main's incoming changes touch the PR's feature folders. Human PRs: the deterministic gates only (agent verification when labeled `factory:verify`). Results are keyed by commit, so they're never repeated for the same commit |
| `factory-merge` | PR approved, a factory check completed, a PR becoming eligible for auto-merge | `bsf merge-queue` | The factory's own merge queue; one job works through the whole queue, then exits |
| `factory-conflicts` | Push to main | `bsf conflicts` | Finds open factory PRs that became conflicting and dispatches a resolution run |
| `factory-garden` | Nightly schedule | `bsf garden` | Scans for drift and dispatches up to 5 gardening runs |
| `factory-review` | Daily schedule; runs only when its thresholds say so | `bsf review` | The scheduled self-improvement review (every 3 days, early at 50 runs, skipped under 10) |
| `factory-rollup` | Called as the last step of every factory workflow; a daily sweep as backstop | `bsf rollup` | Updates `index.json` and `ledger.json` on `factory-data`; dispatches queued work items when concurrency slots are free (so a crashed run can't stall the queue); monthly, squashes `factory-media` |
| `factory-audit` | Push to main | `bsf audit` | Re-runs gates on the pushed commit; flags anything that bypassed them |
| `factory-sync` | Push to main that changes `factory.yaml` | `bsf sync-settings` | Applies branch protection, rulesets and repo settings from config |

**Concurrency and limits**

- `factory-run` is capped by `factory.yaml` (`concurrency.max_runs`, default 5), well under GitHub Free's 20 concurrent jobs.
- `factory-intake`, `factory-merge`, `factory-rollup` and `factory-sync` each use a single concurrency group, so they never run twice at once. By default a group keeps only one pending run and cancels older pending ones; that's harmless for merge, rollup and sync, which redo all their work each time, and intake uses `queue: max` and drains every unprocessed event.
- **No polling schedules.** Apart from nightly gardening, the daily review check and the daily rollup sweep, nothing runs on a timer: an idle factory uses almost no Actions minutes.
- Each agent step has a time budget (default 45 minutes) far below GitHub-hosted runners' 6-hour job limit.
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

- **Tokens are short-lived and down-scoped.** Each job mints its own installation token with only the permissions that job needs; only `factory-sync` gets Administration. Nothing long-lived is stored except the App's private key in repo secrets.
- **The agent never holds a GitHub token.** Agents run in the sandbox with no GitHub credentials; the runner, outside the sandbox, pushes their commits and opens PRs. The sandbox's network reaches only the model API and package registries, plus the app's own sidecar services.
- **The App's actions trigger workflows.** Unlike the built-in `GITHUB_TOKEN`, PRs and pushes made with the App token start `factory-gates` normally.
- **Approvals never come from the App.** The path policy and merge queue ignore any approval whose author is the App; only trusted humans approve.

## Agent CLI adapters

Every supported harness (Hermes Agent, Claude Code, Kilo Code, pi, Cursor CLI) sits behind one interface, so the runner never depends on a specific harness. The factory doesn't hand-write five wrappers: it builds on two existing open-source pieces.

| Job | Built on | Why |
| --- | --- | --- |
| Run one agent step | **Agent Client Protocol (ACP)**, through its official TypeScript SDK | One protocol for all five: Cursor and Hermes speak it natively (`hermes acp`); Claude Code, pi and Kilo through their ACP adapters. Session updates (messages, tool calls, plans) arrive in one shared format, which becomes the normalized transcript |
| Tokens and cost of a step | **memex** (MIT), reading the harness's own session log in the sandbox after the step | ACP's `usage_update` is stable but its cost field is optional, per-turn token counts aren't in the stable protocol yet, and agents' support has been uneven, so ACP can't be the source of truth for cost. Each harness's own log holds the real token counts, and memex reads token usage for all five |
| Read past local sessions (setup's correction mining, `bsf contribute-corrections`) | **memex** | It already knows where every harness stores sessions (for example `~/.local/share/kilo/kilo.db`, Hermes's `state.db`) and returns their history as JSONL |
| Price tokens | A bundled **LiteLLM** price table | A cost the harness logs is kept; a price is estimated from tokens only when the log has none |

```ts
interface HarnessAdapter {
  id: "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";
  install(env: SandboxEnv): Promise<void>;   // install the CLI and its ACP entry point in the sandbox
  acpCommand(req: StepRequest): string[];    // how to start the agent as an ACP server
  memexSource: string;                       // memex source name for this harness's sessions
  localHook(): HookInstall;                  // config that captures local sessions
}

interface StepRequest {
  role: RoleId;            // triage | spec | builder | verifier | gardener | hardener | scorer
  model: string;           // from factory.yaml, per step
  prompt: string;          // role prompt + shared context + task
  workdir: string;
  allowedTools: string[];
  timeBudgetSec: number;   // default 2700
}
```

The runner does the rest the same way for every harness: it starts the agent with `acpCommand`, sends the prompt over ACP, records the session updates as the transcript, and when the step ends reads tokens and cost with memex (`memexSource`), prices them, and writes the `StepReport`.

- **`StepReport` is mandatory and identical for every harness:** exit status, normalized transcript path, files changed, tokens in/out/cached, cost in USD, duration (format in Schemas & Contracts). A harness whose step yields no token data fails conformance and isn't shippable.
- **Headless only in CI.** Each agent runs non-interactively inside the sandbox with the model API key from secrets. Claude Code, Kilo Code, pi and Hermes Agent all accept an Anthropic API key directly, so one key covers four of the five; Cursor CLI needs a Cursor account and its own key.
- **Dependencies are pinned.** The ACP SDK, each harness's ACP adapter and memex are pinned to exact versions in the runner release, and the adapter conformance suite runs a real step per harness on every release, so a change in any of them shows up as a failing test, not wrong numbers.
- **Adding a harness** = one adapter entry (its ACP command and memex source) plus a fixture test, as long as ACP and memex support it.

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
2. **Policy from main.** On a PR, GitHub runs the workflow files from the PR itself, so a PR (a fork's above all) could rewrite `factory-gates.yml` to always pass. The `factory/policy` check closes this: it runs on `pull_request_target`, which always uses main's copy of the workflow, loads `policy.yaml` from main, and fails any PR that touches workflow or definition files until a trusted human approves. It is a required check. GitHub's own fix, required workflows through rulesets, is only on Enterprise Cloud, so the factory doesn't rely on it.
3. **Path policy per pipeline.** Product work and gardening may change code and tests; hardening may also change guardrail paths; only a PR approved by a trusted human may change `.factory/definition/`. Any pipeline may lower baseline counts and raise the coverage floor. A factory PR may modify or delete existing test files only if its spec declared them.
4. **Weakening check.** Removing or loosening a rule, raising a baseline, lowering the coverage floor or adding a skip without a reason fails the gate unless a trusted human approves.
5. **The App can't touch workflows, and the agent can't touch GitHub.** No `workflows` permission, so gate files can only change through a human's own push; each job's token is down-scoped, and agents get no GitHub token at all.
6. **The factory merges only through its queue.** The merge queue is the only path factory PRs take into main, and it merges only after the gates pass on the final commit.
7. **Branch protection where available.** On public repos and paid plans, `factory-sync` adds the factory's checks as required, requires branches to be up to date with main before merging, and blocks direct pushes to main. It only adds: existing rules, required reviews and required checks are kept. "Up to date before merging" means a human PR is re-checked against the latest main too, so a human PR and a factory PR can't each pass alone and break main together.
8. **Human PRs keep their normal flow.** They run the deterministic gates (static rules, tests, coverage) and merge however the team already merges, through those checks. Agent runtime verification runs on a human PR only when someone adds `factory:verify`. Where the repo already has a CI test check that runs on the factory's branches, Gate 2 reads its result instead of re-running the tests; if that result hasn't arrived within 15 minutes, the gate runs the tests itself.
9. **Audit where it isn't.** On free private repos, `factory-audit` re-runs the gates on every push to main and flags any bypass on the dashboard, with an optional revert PR.
10. **Fork PRs.** PRs from forks run only the gates that need no secrets; agent work never starts from a fork.
11. **Budget shares.** The budget has two limits: model spend in USD and Actions minutes. Each pipeline has a share of both (default product work 60%, gardening 25%, review and benchmarks 15%) and pauses when either share is used. Product work may also use what the others left unspent, up to 110% of either limit, then pauses too. The minutes limit defaults to the plan's included minutes (2,000 a month on Free private repos; standard runners are free on public repos, so no minutes limit there).

## Merge queue and conflict mechanics

The factory runs its own merge queue on every plan, merging one approved PR at a time after re-checking it against the latest main.

**Entering the queue** — a PR is queued when its gates pass and either a trusted human approved it or its pipeline's auto-merge toggle is on. Queue order is the time it became eligible; the queue lives in `ledger.json`. `factory-merge` starts on the events that can change eligibility (an approval, a check finishing, a toggle), works through the queue in one job, and exits when it's empty.

**Processing one PR** (`factory-merge`, single concurrency):

1. **Fast path:** if the PR's branch already contains the current main and its gates passed on that exact commit, mark it ready for review and squash-merge it now.
2. Otherwise update the branch from main through GitHub's update-branch API.
3. Re-run the gates on the new commit (timeout 60 minutes): static rules and tests always; agent runtime verification only if the changes that came in from main touch the PR's feature folders.
4. Gates pass → mark ready for review, squash-merge. Gates fail → remove from the queue and send it back to its pipeline as a gate failure (counts toward the retry cap).
5. Update fails with a conflict → remove from the queue and dispatch a conflict resolution run.

**Conflict resolution run** (also started by `factory-conflicts` whenever a push to main makes an open factory PR conflict):

1. Rebase the PR branch onto main.
2. The builder resolves each conflict using both sides' intent: the PR's spec and the description of the change that landed on main.
3. The result goes through the full factory-clear loop again.
4. Approval resets: back to a human, or automatic if auto-merge is on.
5. If the two intents contradict, escalate to a human with both specs side by side.
