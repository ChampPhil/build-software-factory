# Build Software Factory — Setup Skill Spec

Nov 18, 2026 · @Philip

The setup skill (`build-software-factory`) turns an existing repo into a running factory in one session, asking the user for as little as possible.

## Overview

| The user does | The skill does |
| --- | --- |
| Runs the skill in their agent CLI from the repo folder | Everything in phases 1–7 |
| Approves reading past agent sessions (and can exclude any) | Mines every past correction it can find |
| Clicks **Create**, then **Install**, on GitHub's App pages (two clicks) | Creates the factory GitHub App from a manifest and stores its credentials as repo secrets |
| Pastes a model API key once (or confirms an existing one) | Stores it as a repo secret |
| Accepts or rejects guardrail candidates in one list | Turns accepted candidates into rules, tests or context |
| Sets a monthly budget (default suggested) | Estimates spend from recent repo activity plus nightly gardening and reviews, and splits it into pipeline shares |
| Merges the setup PR | Switches the factory on |

- **Runs locally, in the user's own agent CLI**, with the user's own git and `gh` credentials. That's what lets it read local agent sessions and push the workflow files the factory's App is not allowed to touch.
- **Everything it installs arrives as one setup PR** (plus cleanup PRs later), so the user can review exactly what changed.
- **Plain-language progress** at every phase: what it found, what it's doing, what it needs.

## Preconditions and inputs

The skill checks these before starting and tells the user exactly what's missing.

1. **A git repo hosted on GitHub**, with the user's `gh` CLI signed in and admin rights on the repo.
2. **One supported agent CLI** (Hermes Agent, Claude Code, Kilo Code, pi or Cursor CLI) running the skill.
3. **A supported language** among TypeScript, JavaScript, Python, Go, Java, Rust, C# and Ruby. Repos mixing several are fine.
4. **A clean working tree on main.** If there are uncommitted changes, the skill stops and asks the user to commit or stash them.
5. Nothing else on their machine: phase 2 builds and checks the sandbox on GitHub's runners, so no Docker and no language toolchain.

The skill detects the GitHub plan and repo visibility up front, because they decide enforcement: public repos and paid plans get branch protection, free private repos get the audit fallback. It tells the user which one applies and that GitHub Pro unlocks hard enforcement. On a public repo it also explains that local session transcripts will only be captured if they choose the private data repo in phase 6.

## Phase 1: Assess

The skill builds a full picture of the codebase and its tooling, keeping what's good and listing what's missing.

**Inventory what exists**

- Languages, frameworks, package managers, monorepo structure (one factory per repo, a section per app). Languages are detected with go-enry (GitHub Linguist's data); frameworks and package managers from their manifest files.
- Existing CI workflows, linters, formatters, type-checkers, test frameworks and their configs, including the name of the repo's own test check and its triggers. If that check runs on pushes to `factory/*` branches, Gate 2 can read its result instead of re-running tests; if it doesn't, the skill records no test check and the factory runs the tests itself, without editing the team's CI.
- Existing branch protection rules and required checks, which the factory keeps.
- How the app builds and runs: Dockerfiles, devcontainers, `Makefile`/`package.json` scripts, setup docs.
- The tracker and chat tools in use (GitHub Issues labels, Linear or Slack integrations already installed).
- Folder structure: whether code is organized one folder per feature, and the import edges between folders.
- Dominant patterns worth keeping: for each recurring concern (API calls, errors, logging, data access), the pattern most of the codebase uses.

**Find the gaps**

- Missing guardrails per base kind (no formatter, no dependency rules, no type strictness, …).
- Test coverage per area, and areas with no tests at all.
- Duplicate patterns for the same concern (two ways of calling the API = nuance); copy-pasted code is found with jscpd.

**Mine past corrections** (detail in the next section), then group and sort them into candidates.

**Output:** `assessment.md` in the setup branch (shown in the setup PR, then deleted after merge so it isn't unrequested markdown) and the first version of `candidates.json`.

## Correction mining in detail

The goal is to catch every past correction and turn the recurring ones into guardrails on day one.

| Source | How it's found | What counts as a correction |
| --- | --- | --- |
| **Past chats with AI coding agents** | memex (the open-source session reader the runner bundles) lists and reads local transcripts for this repo across all five supported harnesses | A user turn that rejects or redirects the agent's work ("no", "don't", "instead", "that's wrong"), or an undo of an agent edit |
| PR review comments | GitHub API, all merged and closed PRs | A comment that requested a change which the author then made |
| Reverts | `git log` | Any revert commit, plus the commit it reverted |
| Fix commits | `git log` | Commits whose message says fix/hotfix that touch code changed in the previous 14 days |
| Bug history | Issues labeled bug (or the tracker's equivalent) with a linked fix PR | The bug plus its fix |
| Prose rules | `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, style guides, harness rule files | Every rule-like sentence ("always…", "never…", "use X instead of Y") |

**Process**

1. **Consent first.** The skill lists the agent sessions it found for this repo (date, harness, first message) and the user can exclude any before anything is read.
2. **Redact** secrets from every transcript before analysis.
3. **Extract** each correction with its source and a short quote.
4. **Group** corrections into problem classes; 15 instances of the same correction become one candidate with 15 occurrences.
5. **Sort** each candidate by the ordered check: API change → static rule → verification → context.
6. **Rank** by occurrences and recency, and show the user one list: problem class, occurrences, proposed fix, one example. The user accepts or rejects each in a single pass (accept-all is the default).

Teammates can later run `bsf contribute-corrections` on their own machines to add their sessions; after setup, the session hooks capture new corrections automatically for developers who opted in, wherever transcripts can be stored privately.

`bsf contribute-corrections` is deliberately two steps, because a candidate carries the teammate's own words — `problem_class` is a sentence they typed at an agent. The first command mines and writes a file on their disk, prints exactly what would be shared, and submits nothing; they delete anything they would rather not share, then run it again with `--submit`, which opens a PR adding what is left. Consent to read a session is not consent to publish from it.

The submitted PR merges rather than replaces. A problem already pending becomes more evidence for that one candidate instead of a second entry for the same thing; one that is already accepted, rejected or installed is left alone and reported as skipped, so nobody is asked to judge the same thing twice and a rejection is never quietly reopened. Each added candidate records `contributed_by`, because the quote came from someone's private session and they are the person to ask about it.

## Phase 2: Make it runnable

The skill produces a reproducible, isolated sandbox where an agent can build the app, run its tests and verify it at runtime with real dev tools.

1. **Reuse first:** an existing devcontainer, Dockerfile or setup script becomes the base of the sandbox, which is always described as a standard `devcontainer.json` so any devcontainer tool can open it.
2. **Otherwise generate** a `devcontainer.json` (with a Dockerfile if needed) from the assessment: language runtimes, package install, services the app needs (databases, caches) as sidecar containers, a headless browser for runtime verification.
3. **Write the runbook** (`context/runbook.md`): build, run, test, verify and seed-data commands, each tested.
4. **Prove it works:** `factory-setup` brings the sandbox up on a runner, runs the test suite, starts the app and screenshots it with Playwright; the measured tier is what the setup PR records.
5. **Secrets the app needs to run** (for example a test database URL) are listed for the user; the skill stores them as repo secrets and the sandbox reads them as environment variables.

**Done when** the app starts in the sandbox and the screenshot shows it working. If it can't get there, the skill stops and shows the user the failing step instead of continuing with a factory that can't verify anything.

## Phase 3: Install guardrails

The skill builds static rules and verification from the assessment, extending what the repo already has instead of replacing it.

1. **Universal rules** from the language rule pack, each configured on an existing tool: formatter, type strictness, secrets scanning (gitleaks), dependency cycles (for example dependency-cruiser), suppression control (reason required, counted, capped).
2. **Codebase rules** from the dominant patterns: for each recurring concern, ban the minority patterns and enforce the dominant one (for example "network calls only through `apiClient`").
3. **Structure rules:** one folder per feature with dependency-graph checks between feature folders, where the codebase already leans that way.
4. **Accepted correction candidates**, each turned into what the ordered check chose: an API change (queued as a cleanup PR), a static rule, a verification scenario added to the runbook and test suite, or a context line in `fundamentals.md` or `history.md`. Critical logic (money, permissions, concurrency) flagged in candidates gets a targeted formal check.
5. **Coverage:** record the current total as the high mark and set the floor one point below it, set the diff-coverage minimum to 80% (the main check), and count existing skips.
6. **Baselines:** apply only mechanical fixes now. The formatter runs over the whole repo as one separate commit in the setup PR (exempt from the 20-file cap, and listed in `.git-blame-ignore-revs` so blame stays useful); linters' own autofixes run too. Every rule that still has violations gets a per-file baseline: in the linter's own baseline file where it has one (for example `eslint --suppress-all` writes `eslint-suppressions.json`), otherwise in `baselines.json`. Gardening clears them in small verified PRs.
7. **Verify every rule:** each rule must fail on a known-bad example and pass on the dominant pattern before it's installed.

**Output:** `.factory/guardrails/` plus any edits to existing tool configs, all inside the setup PR.

## Phase 4: Clean the codebase

Phases run in order, with one exception: cleanup can finish after switch-on, as the factory's first gardening runs.

- **Mechanical fixes** (formatting, linter autofixes) were already applied in phase 3, inside the setup PR. Nothing that needs judgment is fixed there, so the setup PR stays reviewable.
- **Everything else** is baselined, and the skill seeds gardening work items for it: one item per rule (or per feature folder for large rules), ordered by most violations first.
- After switch-on, nightly gardening opens up to 5 cleanup PRs a night. Each must lower its rule's count and raise no count in any file; at zero, a rule's baseline is retired.
- **Pristine target:** zero guardrail violations, one pattern per concern, every feature folder covered by tests above the floor.
- The dashboard shows cleanup progress per rule (count now vs. at setup) until every baseline is retired.

## Phase 5: Define the factory

The skill writes the factory definition and installs the workflows.

1. **`factory.yaml`** with defaults: the user's harness, a model per step, all auto-merge toggles off, nightly gardening, review every 3 days, retry cap 3, concurrency 5, the budget and its shares from phase 6, and the repo's own test check (if any).
2. **`policy.yaml`** with trust settings, guardrail paths (including existing tool configs found in phase 1) and per-pipeline path rules.
3. **Seven role files** from templates, with the repo name, languages and conventions filled in.
4. **Context files:** `feature-map.md` generated from the folder structure, `runbook.md` from phase 2, `fundamentals.md` from the dominant patterns and accepted context candidates, `history.md` seeded from mined corrections.
5. **Rubrics** from templates (one per pipeline plus shared).
6. **The workflows:** one gh-aw workflow per role (`factory-role-<role>.md`), compiled with `gh aw compile` into `.lock.yml` files (the skill installs the `gh aw` CLI extension locally if it's missing), and the eleven trigger workflows under `.github/workflows/factory-*.yml`, pinned to the runner's commit SHA with the version in a trailing comment (`runner@<sha> # v0.1.0`). None of them runs on a polling timer except nightly gardening, the daily review check and the daily rollup sweep.
7. **Runner upgrades:** a `.github/dependabot.yml` entry for the `github-actions` ecosystem, limited to `build-software-factory/runner` and with a 3-day cooldown after each release. From then on GitHub's Dependabot opens an upgrade PR whenever a new runner is released; the user approves it with one click. If the repo already has a `dependabot.yml`, the skill adds its entry without touching the others.
8. **Local session hooks** for the user's harness (and any others detected in the repo). Each hook asks its developer once, on first run on their machine, whether to capture their sessions, and stores the answer locally; no answer means no capture. The setup user answers for themselves during setup. On a public repo without the private data repo, the hooks are installed but capture stays off.
9. **Trigger sources:** if the GitHub app for Slack or Linear's GitHub integration is already installed, the skill notes it; otherwise it prints the two-minute steps to connect them (both free).

## Phase 6: Instrument

The skill sets up everything the factory needs to record itself and measure its work from the first run.

1. **Create the `factory-data` and `factory-media` refs** (`refs/factory/data`, `refs/factory/media`; or, if the user chose private data storage, a private repo with the same refs) with an empty `index.json` and `ledger.json`. On a public repo, the skill offers the private data repo here, as the only way to keep session transcripts. If the user picks it, the skill installs the App on it too and adds every collaborator with write access on the main repo as a collaborator on the data repo, so their session hooks can push.
2. **Create the factory GitHub App** through GitHub's manifest flow: the skill opens GitHub's App creation page pre-filled with the name, permissions (no `workflows`) and events; the user clicks **Create**; a short-lived local server receives the confirmation; the skill opens the install page for this repo and the user clicks **Install**; the skill stores the App's ID and private key as repo secrets.
3. **Store model API keys** as repo secrets (`gh secret set`), one per harness the user enabled.
4. **Estimate spend:** from the last 90 days of PRs and issues, estimate monthly product runs; add nightly gardening (up to 5 runs a night while baselines remain), scheduled reviews and benchmark runs; estimate Actions minutes and model cost for each, and compare the minutes with the plan's included minutes (a private Free-plan repo gets 2,000 a month; public repos have no limit on standard runners). If gardening would exceed its minutes share, the skill lowers the default PRs per night. The user confirms or changes the suggested model budget, minutes limit and shares (default product work 60%, gardening 25%, review and benchmarks 15%).
5. **Scorers** are installed with their rubrics; they first run at the first scheduled review.
6. **Record the starting point:** current guardrail counts, coverage floor and open issue count go into `index.json`, so the dashboard can show progress from day one.

## Phase 7: Switch it on

The factory goes live when the user merges the setup PR.

1. **Open the setup PR** from the `factory/setup` branch, pushed with the user's own credentials (the App can't push workflow files). It contains the guardrails, the mechanical fixes (the formatter as its own commit), the factory definition, workflows, hooks and `assessment.md`.
2. **Run the gates on the setup PR itself,** so the user sees every gate pass before merging.
3. **The user merges it.** On merge, `factory-sync` adds the factory's required checks where the plan allows it, keeping every existing protection rule, and `factory-garden` picks up the seeded cleanup work that night.
4. **Smoke test:** the skill opens a small issue ("Add a factory badge to the README"), waits for the factory to produce a draft PR, and shows the user the dashboard link.
5. **Hand-off message:** what's running, where to watch it (the dashboard), how to request work (issues, Slack, Linear), that all auto-merge toggles start off, and the enforcement level for their plan.

The newly set-up factory starts with a human approving draft PRs in all three pipelines; the user turns on auto-merge per pipeline from the dashboard when ready.

## Re-running the skill and failure handling

The skill is safe to run again: it detects an existing factory and switches to update mode.

**Re-run on a repo that already has a factory**

- Reads `.factory/definition/factory.yaml` and the runner version, and offers two things: re-mine corrections (new candidates only), or repair (re-check the sandbox, App, secrets, workflows, the Dependabot entry and, with a private data repo, its collaborator list, and fix what's broken). Runner upgrades don't need the skill: Dependabot opens them.
- Never overwrites edited context, roles or rubrics; changes arrive as a PR with a diff.

**Failure handling during setup**

| Failure | What the skill does |
| --- | --- |
| Sandbox won't build or app won't start | Stops at phase 2, shows the failing command and its output, suggests the fix, resumes from phase 2 when re-run |
| No tests exist | Continues, sets the coverage floor at 0%, and seeds gardening work to add tests per feature folder, most-changed first |
| App creation abandoned | Waits up to 10 minutes, then pauses with a resume command; nothing half-created is left behind |
| Unsupported language in part of the repo | Installs guardrails for supported parts, lists the rest as unguarded in the hand-off |
| Setup PR fails a gate | Fixes it in the same branch (up to 3 attempts), otherwise shows the failure to the user |
| User stops mid-way | Progress is saved in `.factory/.setup-state.json` (git-ignored); re-running resumes from the last completed phase |
