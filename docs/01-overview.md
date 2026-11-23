# Software Factory — Overview

Nov 18, 2026 · @Philip

## 1. What a software factory is

A software factory is a governed, automated loop around software development: work comes in, agents triage, plan, build and verify it, and humans approve the result.

- Software development is moving along a curve: **chat → autocomplete → interactive prompting → automated development**.
  - Interactive prompting = developers talking to several agents at once, on their own laptops.
- Interactive prompting runs into two problems:
  1. **Local agents are insecure** → an agent runs with the permissions of whoever is signed in, so a compromised agent can take over the laptop.
  2. **Local agents are unmeasurable** → each has its own custom setup, so nobody can see what's going on, edit it, or improve it.
- The solution: **local agents → cloud agents**, organized into a factory.
- A factory is:
  - **Measurable** → every agent and human action is recorded.
  - **Improvable** → the factory gets better from its own data.
  - **Defined in code** → the whole factory can be read, versioned and changed like any other code.
- Two kinds of engineers work with a factory:
  - **Product engineer** → puts work into the factory.
  - **Factory engineer** → improves the factory itself.

## 2. Principles the factory enshrines

Every part of the factory exists to enforce these principles.

- **The codebase is the largest input coding agents get.**
  - Agents copy the patterns they see → the code must be kept pristine, so they copy good patterns and don't carry tech debt.
  - Large refactors to make code pristine are now cheap with agents.
- **Nuance breeds slop.**
  - Avoid APIs and code patterns that need nuance to use correctly.
  - Design APIs and interfaces that remove nuance, and ban the specific patterns that introduce it.
- **Treat the code as a well-maintained garden.**
  - The continuous stream of code coming in must be good code.
  - The deterministic checks are the guardrails of the garden: the concrete foundation the code grows on.
- **Categorically eliminate problems.**
  - When correcting agent work, prefer a code-based check over updating prose: a small refactor, or a static rule like a linter or dependency graph analyzer.
  - Always ask: *"How can I eliminate this problem for the entire codebase?"*
- **No unrequested markdown from agents.**
  - Stray docs lead agents to justify wrong patterns to other agents.
- **The directory tree is context.**
  - How the filesystem is structured shapes how agents interact with the codebase.
  - One folder per feature, plus deterministic checks that block bad imports between folders.
- **Verification is what builds trust.**
  - Human "code review" shifts to reviewing verification artifacts: screenshots, diagrams, videos.
  - Runtime verification is required; formal verification is used where it's needed.
- **Open, adaptable and defined in code.**
  - *Open* → built from open tools (gh-aw, memex, Semgrep, Playwright), with no hosted service. Its agents run on Claude Code, the one harness whose spend its budget is proven to stop.
  - *Adaptable* → works with the infrastructure, tools and conventions the team already has.
  - *Defined in code* → a strict, version-controlled definition of the factory, including its skills and workflows.
- **Every agent and human trace is recorded and used for improvement.**

## 3. The core idea

**Existing code → build a collection of guardrails → fit the existing code to the guardrails → a pristine garden, where all future code is guaranteed to add to the garden.**

- Guardrails come from three sources:
  - The codebase's own best existing patterns.
  - Past corrections: the developers' past chats with AI coding agents (every time someone corrected an agent), review comments, reverts, fix commits, bug history, prose rules (AGENTS.md, contributing guides). The goal is to catch all of them.
  - Universal rules every codebase should have.
- Fitting the code happens *under* the guardrails → the garden never gets worse while it's being cleaned.
- Once the garden is pristine, the guardrails make sure every future change keeps it that way.
- The garden keeps getting stricter: every correction is recorded, and a correction that recurs (or that a human flags) becomes a new guardrail (hardening).

## 4. Kinds of static rules

Static rules check code without running it. There are 12 base kinds, from shallowest to deepest; every higher-level rule is built from them.

1. **Text and regex** → patterns in raw text, no understanding of the code.
2. **Structured-data schema** → config files (JSON, YAML, TOML) checked against a schema.
3. **Syntax tree (AST)** → patterns in the parsed structure of the code.
4. **Canonical form** → does the code match its formatted version?
5. **Type analysis** → what every symbol and expression actually is.
6. **Dependency graph** → which modules import which: cycles, layers, forbidden edges.
7. **Call graph** → which functions call which: dead code, reachability.
8. **Control flow** → the possible execution paths inside a function.
9. **Data flow and taint** → where values travel, from where they come in to where they're used.
10. **Clone detection** → duplicated code.
11. **Cross-artifact consistency** → two artifacts that must agree (API spec vs handlers, migrations vs models).
12. **Formal verification** → properties proven mathematically.

The twelve kinds are a taxonomy, not a launch list: the rule packs ship text and regex, structured-data schema, syntax tree, canonical form, types and dependency graph in v0.1; call graph, control flow and clone detection in v0.2; data flow and cross-artifact consistency in v1.0. Formal verification is only ever targeted (section 5).

The last two arrived in v1.0 and are worth distinguishing, because they are the two a conventional linter cannot do.

**Data flow** asks where a value came from, not what a line says. `execSync(command)` is not a problem; `execSync(command)` where `command` was built from `req.query` is. The rule packs carry these as Semgrep taint rules — sources and sinks — and each one's good example *still calls the sink*, so the rule is demonstrably about the path and not a ban on a useful function. A ban would be easier to write and worse: it would forbid the safe call too.

**Cross-artifact consistency** compares two artifacts that are supposed to agree, where each is individually fine. `bsf consistency` checks environment variables the code reads against `.env.example` in both directions, commands the README tells people to run against the manifest's scripts, and declared dependencies against the lockfile — plus the commonest case of all, a repo that reads a dozen variables and has no example file at all, reported once rather than once per variable. It also checks the runbook against what the runbook's own commands do: if the runbook tells the factory to run a script whose chain applies migrations, deploys, publishes or changes infrastructure, and the runbook does not say so, that is a finding. Phase 2 promises the runbook classifies commands by whether they touch persistent state; this is what holds it to the promise, because a build command that migrates a database is safe for the developer who wrote it and not safe for an agent running it unattended a few hundred times. Every finding names both files, because a mismatch is never a fault in one of them alone and the fix depends on which one is right. It reports and does not fail: deciding which artifact is wrong is a person's job.

Higher-level rules are combinations of the base kinds:

| Higher-level rule | Built from |
| --- | --- |
| Filesystem layout | File paths + dependency graph |
| Banned APIs | AST (+ types) |
| Dead code | Dependency graph + call graph |
| Complexity limits | Control flow |
| Secrets | Text and regex |
| Dependency allowlist | Structured-data schema |
| Contract drift | Cross-artifact consistency |

Two rules about the rules:

- **Suppression control** → every disable comment needs a written reason; suppressions are counted and capped.
- **Ratchets** → a rule's count of existing violations can only go down, never up, counted per file so a fix in one place can't pay for a new violation in another.

## 5. Kinds of verification

Verification is either runtime (run the code and watch it) or formal (prove it without running it).

- **Runtime verification** → run the code and check what it actually does. It shows the code works for the cases tried.
  - **Tests** → written in advance and scripted; same result every run.
    - **Unit** → one function, with everything around it faked.
    - **Integration** → a few real pieces working together (code + a real database).
    - **End-to-end (E2E)** → the whole app, used the way a user would.
  - **Agent runtime verification** → an agent uses the running app the way a developer would, with real dev tools. It explores, and it produces the screenshots and videos humans review.
- **Formal verification** → prove a property holds for *every* possible input. Strongest and most expensive; reserved for critical logic.

## 6. How code becomes factory-clear

<div class="diagram">
<div class="box">Agent writes code<small>Runs checks locally as it goes</small></div>
<div class="arrow">↓</div>
<div class="box">Gate 1: static rule checks<small>Run by the factory, deterministic</small></div>
<div class="arrow">↓ pass &nbsp;&nbsp; (fail → fix and retry)</div>
<div class="box">Gate 2: verification in sandbox<small>Tests: unit, integration, E2E + agent runtime verification</small></div>
<div class="arrow">↓ pass &nbsp;&nbsp; (fail → fix and retry · N failed retries → escalate to a human · each failure is traced)</div>
<div class="box clear">Code cleared</div>
<p class="caption">factory-clear loop · 2 gates, 1 retry loop</p>
</div>

The factory runs both gates itself, so an agent's own "tests pass" never counts; only code that passes both is cleared.

- **Tests are protected** → tests can be rewritten or deleted in any pipeline, but only the existing tests the spec declared; new behavior must come with tests (diff coverage); total coverage can't fall more than a point below its highest; skips count as suppressions. Removing or loosening a rule needs a human.
- **The gates run apart from the builder** → in their own job, on every commit the factory pushes, and each commit is checked once.
- **Factory-clear is the shared unit** → every pipeline that produces code goes through it, and a resolved merge conflict goes through it again.

## 7. Triggers

Five kinds of triggers start factory work; the first three make it reactive, the last two make it proactive and self-improving.

1. **Request triggers** → a human explicitly asks for work.
2. **Development-event triggers** → something changes in the development process: a review comment on a factory PR, CI broken on main, a merge conflict.
3. **Signal triggers** → the outside world reports a problem: production errors and user reports, arriving as GitHub issues.
4. **Scheduled triggers** → time-based upkeep that keeps the garden pristine without anyone asking.
5. **Self triggers** → the factory's own data creates work: human corrections, repeated failures, failures found in the scheduled review.

- Every trigger becomes **one standard work item** before routing → routing only sees what the work is, not where it came from.
- **The factory is also a trigger source** → anything it sets off goes back through routing, never straight into a workflow.
- **Only trusted people can start work** → agent work starts only from repo collaborators; outside issues, and issues an integration's bot creates, wait until a trusted person accepts them.
- **Later:** releases and security advisories as triggers.
- **Requests arrive as GitHub issues** → Slack (free GitHub app for Slack), Linear (GitHub Issues sync) and Sentry (GitHub integration) all create issues, so nothing extra has to be hosted.

## 8. Core workflows

The factory runs three fixed pipelines; each ends in a draft PR that has passed factory-clear.

| Pipeline | Flow | Started by | Reviewer sees |
| --- | --- | --- | --- |
| **Product work** | Incoming work → triage → spec → build (factory clear) → draft PR | Requests, events, signals | The new behavior works: screenshots, videos |
| **Gardening** | Scheduled scan → find drift → fix (factory clear) → draft PR | Schedule | Behavior unchanged (before/after) + what was cleaned |
| **Hardening** | Correction or repeated failure → generalize to the problem class → write the check or codebase change → fix existing violations (factory clear) → draft PR | Recurring or flagged corrections, repeated failures | The rule in plain language, why it exists, proof it works, its impact |

- **Drift** (gardening) = violations of static rules (old code still under a baseline) + violations of principles no rule catches yet + recently merged behavior that lacks tests or guardrails.
- **Gardening is proactive; hardening is reactive.**
- When gardening keeps finding the same violation → that starts hardening. Over time work moves from gardening to hardening, and gardening gets cheaper.
- **Hardening verifies the rule itself** → it must catch the original bad example and pass the correct pattern. The human judges *"is this a rule we want?"*, never the rule's code.
- A merge conflict on any PR → rebase, resolve using both sides' intent, re-run factory-clear, re-approve. Contradicting intents → escalate to a human.
- **Pipelines know what each other are doing** → before starting, every pipeline checks a shared work ledger: open PRs, in-flight runs and recent work. The goal is to avoid duplicate work, not to avoid touching the same files: a new work item that matches an existing one attaches to it instead of starting a duplicate; gardening doesn't re-fix a violation an open PR already fixes; hardening checks for an existing rule or candidate first. Nothing is locked: overlapping changes are expected and handled by conflict resolution and the merge queue.

## 9. Phases of one-time factory setup

Setup runs once, in seven phases, and ends with a newly set-up factory; phases run in order, except that the cleanup (phase 4) may finish after switch-on, as the factory's first gardening runs.

1. **Assess** → understand the codebase and the tooling around it. Inventory what exists (tools, conventions, dominant patterns worth keeping) and find the gaps. Mine every past correction and mark each as a guardrail candidate. Sources: the developers' past chats with AI coding agents (local session transcripts for this repo, read with permission and redacted), review comments, reverts, fix commits, bug history and prose rules. Repeated corrections are grouped into one problem class.
2. **Make it runnable** → set up a reproducible, isolated sandbox where agents do all their work: building the app, running tests, and runtime verification with real dev tools. Reuse the existing dev environment setup where possible.
3. **Install guardrails** → build static rules and verification from the assessment. Extend the existing linters and tests, turn the codebase's best patterns into rules, and turn each correction candidate into a static rule, a runtime verification scenario or a formal verification check. Only mechanical fixes (the formatter, linters' autofixes) go into the setup PR; every rule's remaining violations are recorded as its baseline count.
4. **Clean the codebase** → refactor toward pristine code quality, based on this codebase's best patterns, with zero guardrail violations. Each cleanup PR is small and verified on its own; the gate checks that it lowers its rule's count and raises no count in any file.
5. **Define the factory** → agents, the three pipelines (product work, gardening, hardening) and triggers, all in code. Triggers connect to the team's existing tools.
6. **Instrument** → traces, metrics and scorers, plugged into existing observability where it exists.
7. **Switch it on** → turn on triggers and schedules. A human approves draft PRs for merge in all three pipelines, inside the team's existing review flow.

**→ Newly set-up factory**

- **Baselines are temporary scaffolding** → they let rules go in *before* the cleanup, so cleanup PRs pass the gate and new violations can't sneak in. At zero, the ratchet goes away and the rule is plain pass/fail.
- **The cleanup can be handed to the factory itself** → install guardrails with baselines, switch it on, and let the first gardening runs bring the counts to zero.

## 10. How the factory runs after setup

After setup, three loops run at once, each slower and each improving something deeper; humans control autonomy with three toggles.

1. **The work loop (hours) → ships the product.**
   - Trigger → work item → pipeline → factory clear → draft PR → approved → merge queue → merged.
   - Monitoring after release produces new signals → new work.
2. **The codebase loop (days to weeks) → keeps the code pristine.**
   - Gardening cleans up drift on a schedule; hardening turns corrections into guardrails.
   - The codebase gets stricter over time.
3. **The factory loop (scheduled, every few days) → improves the factory itself.**
   - Instrumentation traces everything continuously; every few days a scheduled review grades recent work and routes each failure to hardening or to a factory-definition change (section 11).

**Autonomy toggles** (each on or off):

- ☐ Auto-merge product work PRs
- ☐ Auto-merge gardening PRs
- ☐ Auto-merge hardening PRs (safe to turn on: hardening only adds or tightens guardrails; any weakening is blocked by a gate and needs a human)

Off → a human approves by looking at the verification artifacts. On → PRs that pass factory-clear merge on their own.

**What humans do:**

- **Product engineers** → put work into the factory and approve its PRs where auto-merge is off.
- **Factory engineers** → watch the dashboard (automation rate, cycle time, spend, failures), approve changes to the factory, and decide when to flip the toggles.

**Where humans see everything** → the dashboard: what every agent and human is doing, every run's transcript and artifacts, and the factory's metrics.

**Everything reaches main through the gates** → the factory merges its own PRs, and only after its gates pass; human PRs pass the deterministic gates (static rules, tests, coverage) and merge through the team's normal flow. Branch protection blocks bypasses where the GitHub plan allows; on free private repos a post-push audit flags them. Local agent sessions are captured by hooks, only for developers who opt in and only when the factory's data is stored privately; local human work is captured at the PR level.

## 11. Self-improvement

Self-improvement has two parts: instrumentation traces everything continuously, and a scheduled review every few days grades the recent work and routes each failure to the right fix. Pipelines and steps never change.

- **Every failure found by a scorer is an opportunity to improve.**
- **Part 1: instrumentation (always on)** → every agent and human trace, artifact, correction, cost and timing is recorded to the factory's data.
- **Part 2: the scheduled review (every few days)**
  1. **Scorers** (agents acting as LLM-as-a-judge) evaluate all factory work since the last review.
  2. They find failures and group them into problems.
  3. Each problem is routed by where its fix belongs:
     - **Fix belongs in the codebase, static rules or verification** → sent to **hardening**.
     - In v1.0 every failure goes to hardening. A failure found in a hardening run is recorded and shown to a person, never hardened again, so hardening cannot feed itself.
- **Changing the factory definition is manual in v1.0** → `/practice` declares a practice, and a definition PR a human approves adds it. Automatic, measured definition changes (benchmarks) are planned for v1.1.
- **Hardening comes first** → if a fix can be a code check, it goes to hardening and stays out of the context.
- **Order after setup** → instrumentation starts at switch-on → the scheduled review turns on. The first review runs three days after the first graded run, then every 3 days.
