# Build Software Factory — Pipelines & Agents Spec

Nov 18, 2026 · @Philip

The factory runs three fixed pipelines (product work, gardening, hardening) plus two support flows (conflict resolution and factory-definition changes), all built from seven roles and the same factory-clear loop.

## Roles and shared context

| Role | Does | Used by |
| --- | --- | --- |
| **Triage** | Understands the work item, reproduces bugs in the sandbox, checks it's in scope, rejects or escalates unclear items | Product work |
| **Spec** | Writes a short, precise plan: what changes, where, acceptance checks, tests to add, and which existing tests will change | Product work, hardening |
| **Builder** | Implements the plan with the smallest correct change, plus tests for new behavior | All pipelines, conflict resolution |
| **Verifier** | Runs the app and checks the result independently; produces the verification artifacts | All pipelines |
| **Gardener** | Finds drift and picks the night's cleanup items | Gardening |
| **Hardener** | Generalizes a correction or failure into a problem class and picks the strongest fix | Hardening |
| **Scorer** | Grades recent work against rubrics in the scheduled review | Self-improvement |

- Every role reads the same four context files: feature map, runbook, fundamentals, history.
- **The verifier never sees the builder's transcript,** only the spec and the result, so no agent grades its own work.
- Each role's model comes from `factory.yaml`; prompts come from `roles/<role>.yaml`.
- **No role sees untrusted text.** Issue bodies and comments from untrusted authors are stripped before a prompt is built; an accepted outside issue is passed in clearly marked as user-supplied.
- **Each role is a gh-aw workflow.** Every role runs in its own GitHub Agentic Workflows (gh-aw) job: a read-only sandbox behind gh-aw's network firewall, inside the repo's devcontainer. No role holds a write token; its only way to change anything (push code, open a PR, comment, label) is gh-aw safe outputs, checked by gh-aw's threat detection before a separate job applies them. `factory-run` (deterministic) dispatches the role workflows in order and collects their results.

## Intake: trust, work items, routing, the ledger

`bsf intake` turns every trigger into one work item, after checking who sent it and whether the work already exists.

1. **Trust check.** The event's author must be an owner, member or collaborator with write access. Trust belongs to people, never integrations: an issue authored by an integration's bot account (Linear, Sentry) waits like an outside issue, and shows on Home for a one-click accept. Otherwise the item waits, untouched, until a trusted person adds `factory:accept`. Fork events never start agent work.
2. **Normalize** the event into a work item (Schemas & Contracts) and write it as its own file, `work-items/<id>.json`: source, trigger class, title, body, fingerprint. Intake runs in a single concurrency group with `queue: max`, so events are handled one after the other, and each intake run processes every event not yet processed, so none is lost even if a pending run is dropped.
3. **Shortlist duplicates.** The fingerprint finds open items that might be the same request; they're passed to triage, which decides (step 1 of product work). An item that matches work merged recently is never dropped: it becomes a high-priority follow-up linked to the earlier PR (`related`), which triage gets as context.
4. **Route** by trigger to one pipeline:

| Trigger | Pipeline |
| --- | --- |
| Issue, comment asking for work, Slack/Linear/Sentry issue, dashboard request | Product work |
| CI failure on main | Product work (high priority) |
| Review comment on a factory PR | Back to that PR's run as a revision (not a new item) |
| Human correction on a factory PR (a requested change the factory then made) | Recorded as a correction candidate, in addition to the revision; hardening starts at 3 of a kind within 14 days, or at once if labeled `factory:harden` |
| Nightly schedule | Gardening |
| Same failure 3 times within 14 days; problem routed by the scheduled review | Hardening |
| Review result needing context or model change | Definition change (benchmark-gated) |
| Correction whose fix is a context line | Definition change (direct, no benchmark; a trusted human approves) |
| Conflict on an open factory PR | Conflict resolution |

5. **Dispatch** `factory-run` if a concurrency slot is free (default 5); otherwise the item stays `queued`, high priority first, then oldest first. Every `factory-run` ends by dispatching the next queued item, and every rollup (including the daily sweep) dispatches queued items when slots are free, so the queue drains without a timer even if a run crashes.
6. **Budget shares:** each pipeline has a share of both monthly limits, model spend and Actions minutes (default product work 60%, gardening 25%, review and benchmarks 15%). When either of a pipeline's shares is used, its items stay queued; product work may also use unspent shares, up to 110% of either limit.

## The factory-clear loop

Every pipeline that produces code ends in the same loop: the builder writes, the factory runs two gates, and only code that passes both is cleared.

1. **Builder writes code** in the sandbox, running the fast local checks as it goes. Each attempt reaches the work item's `factory/*` branch through gh-aw safe outputs: the first as a draft PR (`create-pull-request`, labelled `factory:in-progress`), later ones with `push-to-pull-request-branch`.
2. **The push starts `factory-gates`**, a separate job with no builder in it. Results are recorded against the commit, so nothing re-runs for the same commit. The path and test-edit rules are checked by `factory/policy`, which runs from main's copy of its workflow so a PR can't change it.
3. **Gate 1 — static:**
   - path and test-edit rules: `factory/policy` runs on the draft PR from main's copy of its workflow; a factory attempt that breaks them counts as a failed Gate 1 attempt
   - all static rules (repo tools + `.factory/guardrails/rules`)
   - ratchet: no rule's count may rise in any file, read from each linter's native baseline (for example ESLint's `eslint-suppressions.json`) or, for tools without one, from `baselines.json`
   - weakening check
   - suppression control
4. **Gate 2 — verification** (in a fresh sandbox):
   - full test suite (or, where the repo already has a CI test check that runs on factory branches, that check's result on the same commit; if it hasn't reported within 15 minutes, the gate runs the tests itself)
   - coverage: diff coverage ≥ 80% (the main check), total ≥ floor (one point below the highest total reached), skips within cap
   - formal checks where installed
   - mutation testing on changed lines (from v0.2), with each language's existing tool (StrykerJS, Stryker.NET, cargo-mutants, Infection and the rule pack's equivalents)
   - **agent runtime verification**: the verifier starts the app per the runbook, exercises the change with real dev tools (a browser through Playwright MCP, console, network, database), and Playwright records the screenshots, video and traces
5. **Fail** at either gate → the failure output goes back to the builder, which fixes and resubmits. Each gate allows **3 attempts per work item**; the third failure escalates.
6. **Pass both** → code cleared: the draft PR's label changes from `factory:in-progress` to `factory:cleared`, and its body is filled in with the evidence.

Every attempt, pass or fail, is recorded in the run file's `gates` list.

## Product work pipeline

**Incoming work → triage → spec → build (factory clear) → draft PR**

1. **Triage** (triage role)
   - Reads the work item and the context; for bugs, reproduces in the sandbox and captures a "before" screenshot.
   - Checks the duplicate shortlist from intake: marks the item *duplicate* only if it asks for the same thing as an open item; a follow-up to merged work proceeds with the earlier PR as context.
   - Outcomes: *proceed*, *needs info* (comments a specific question on the source and waits), *out of scope* (comments why and closes the item), *duplicate*.
2. **Spec** (spec role)
   - Writes the plan into the work item: files and feature folders to change, behavior before and after, acceptance checks, tests to add, and existing tests that will change (`tests_changed`).
   - The spec is posted as a comment on the source issue so the requester can see what will be built. No human approval step.
3. **Build** (builder role, factory-clear loop) — implements the spec plus tests.
4. **Verify** (verifier role, inside Gate 2) — checks every acceptance check from the spec and records evidence.
5. **Draft PR** — opened with the first build attempt and, once cleared, filled in with the spec, artifacts and run link (next sections).

**Revisions:** a review comment on the PR sends the run back to step 3 with the comment as input; the new attempt goes through factory-clear again.

## Gardening pipeline

**Scheduled scan → find drift → fix (factory clear) → draft PR**, nightly, at most 5 PRs a night.

1. **Scan** (gardener role) for three kinds of drift:
   - **Baselined violations:** rules with counts above zero in `baselines.json`.
   - **Principle drift no rule catches:** duplicate patterns for one concern, nuance-heavy APIs, dead code, folders breaking one-folder-per-feature.
   - **Untested recent behavior:** code merged in the last 14 days that lacks tests or guardrails.
2. **Pick up to 5 items**, skipping anything an open PR already fixes (the ledger's `fixes` list). Order: baselines with the most violations, then untested behavior, then principle drift.
3. **One problem class per PR,** each kept small: at most 20 files.
4. **Build and verify** through factory-clear. Gardening must not change behavior: the verifier compares before and after on the affected flows. A PR for a baselined rule must lower that rule's count, and no rule's count may rise in any file.
5. **Draft PR** with the before/after evidence and a summary of what was cleaned.

**Hand-off to hardening:** when the same principle drift is found in 3 gardening runs, the gardener files a hardening work item for it, so it becomes a rule and gardening stops having to fix it.

## Hardening pipeline

**Correction or repeated failure → generalize to the problem class → write the check or codebase change → fix existing violations (factory clear) → draft PR**

**Inputs:** a human correction on a factory PR, the same gate failure 3 times in 14 days, a gardening hand-off, or a problem the scheduled review routed here.

1. **Generalize** (hardener role): turn the specific instance into a problem class ("network calls bypass `apiClient`"), and check the ledger and `candidates.json` for an existing rule or candidate first.
2. **Pick the strongest fix** by the ordered check:
   1. Can the code change so the mistake is impossible? → **API change**
   2. Can a script tell right from wrong without running the code? → **static rule**
   3. Can running the code check it? → **test or verification scenario**
   4. None of these → **context line**, opened straight away as a minimal definition PR (no benchmark run, since a human already stated the intent; a trusted human approves) instead of this PR. If the mistake recurs after the line is added, it comes back through hardening.
3. **Verify the check itself:** the new rule or test must fail on the original bad example and pass on the correct pattern.
4. **Fix existing violations** in the same PR if they fit (25 or fewer across 20 or fewer files); otherwise add a baseline and seed gardening items.
5. **Factory-clear,** then a **draft PR** with the rule in plain language, why it exists, proof it works, and its impact.

Hardening may add or tighten guardrails only; anything the weakening check flags still needs a trusted human.

## Draft PRs and artifacts per pipeline

Every factory PR has the same layout, so a reviewer can judge it from the top without reading code.

**PR body, in order**

1. **One-line summary** and the pipeline label (`factory:product`, `factory:gardening`, `factory:hardening`, `factory:definition`).
2. **What the reviewer is checking** (from the table below).
3. **Evidence:** stored screenshots and clips inline (kept 12 months by default); links to the full video and logs (workflow artifacts, with expiry date).
4. **Gate results:** each gate and its attempts, coverage numbers, ratchet change.
5. **Links:** source work item, spec, run on the dashboard.

| Pipeline | Reviewer is checking | Evidence |
| --- | --- | --- |
| Product work | The requested behavior now works | Before/after screenshots or a short clip of the acceptance checks; full verification video |
| Gardening | Behavior is unchanged and the code is cleaner | Before/after evidence on affected flows; rule counts before → after; list of what was cleaned |
| Hardening | This is a rule we want | The rule in plain language; why it exists (linked corrections); proof it catches the bad example and passes the good one; violations fixed or baselined |
| Definition | The context or model change is an improvement | The change in plain words; the review problems it addresses; benchmark scores before and after |
| Conflict resolution | Both intents are preserved | Both specs side by side; how each conflict was resolved; fresh verification evidence |

## Approval, merge queue and conflicts

A cleared PR reaches main only through approval (human or toggle) and the factory's merge queue.

1. **Approval**
   - Auto-merge **off** for the pipeline → a trusted human approves the PR on GitHub or from the dashboard's review queue. Approvals from the factory App never count. Submitting a review re-runs only the `factory/policy` check, so the approval registers without re-running the gates.
   - Auto-merge **on** → the PR is eligible as soon as its gates pass.
   - Definition PRs and anything the weakening check flags always need a trusted human, whatever the toggles say.
2. **Merge queue** (`factory-merge`, one PR at a time, started by approvals and check results, working through the queue in one job): fast-path merge if already up to date with gates passed on that commit; otherwise update from main and re-run the gates (static rules and tests always; agent verification only if the incoming changes touch the PR's feature folders; the gates recognize this update commit and apply the rule themselves). On pass, the queue marks the draft PR ready for review and squash-merges it.
3. **Gate failure in the queue** → back to the PR's run as a failed attempt (counts toward the retry cap of 3).
4. **Conflict** (in the queue, or detected by `factory-conflicts` after a push to main) → a conflict-resolution work item:
   - rebase onto main;
   - the builder resolves using both intents (this PR's spec and the merged change's description);
   - full factory-clear again;
   - approval resets (human, or automatic per the toggle);
   - contradicting intents → escalate with both specs side by side.

Nothing is locked while work is in flight; overlapping changes are expected and resolved here.

## Escalation

When the factory can't finish work on its own, it stops and hands a human everything needed to decide.

**Escalates when:**

- a gate fails 3 times for the same work item;
- triage can't reproduce a bug or the request is ambiguous after one clarifying question went unanswered for 7 days;
- a conflict's two intents contradict;
- a run hits its time budget 3 times;
- the budget stop pauses product work.

**What happens:**

1. The work item becomes `escalated`; the PR (if any) gets the `factory:escalated` label and a comment.
2. The comment and the dashboard's review queue show: what was attempted, every gate failure with its output, the last diff, and the factory's best guess at what's blocking.
3. A human can **give guidance** (a comment that restarts the run with it as input, with a fresh retry count), **take over** (push to the branch themselves), or **close** it.
4. Every escalation is recorded and reviewed at the next scheduled review; repeated escalations of one kind become a hardening or definition problem.

## Self-improvement: instrumentation and the scheduled review

Self-improvement has two parts: instrumentation that records everything continuously, and a scheduled review that grades recent work and routes each failure.

**Part 1 — Instrumentation (always on).** Every run file, step report, gate attempt, artifact, human correction, escalation and local session transcript is stored on `factory-data` (Trace capture, below).

**Part 2 — The scheduled review** (`factory-review`): every 3 days, early once 50 runs pile up, skipped when fewer than 10 runs happened since the last one.

1. **Grade:** scorers, run on promptfoo's LLM-rubric graders, evaluate every run since the last review against its pipeline's rubric plus the shared rubric (1–5 per criterion, with failure tags).
2. **Collect failures:** scores of 1–2, escalations, reverts of factory PRs, and human corrections.
3. **Group** failures into problems (same tag + same area or same role).
4. **Route each problem by where its fix belongs:**
   - codebase, static rules or verification → a **hardening** work item;
   - context or a step's model → a **definition change**.
5. **Definition changes:** the review drafts the change (a context edit, or a different model for a step) and benchmarks it against the current definition:
   - each side runs **3 times on at least 10 tasks**, including the failure tasks tied to this problem;
   - a context change is tested on tasks from the last 60 days with the new context applied; a model change uses each task's own context at its base commit;
   - it opens a definition PR only if the failure tasks improve, no other task regresses, the overall gain is larger than the run-to-run spread, and cost rises by no more than 20%. A trusted human approves it.
6. **Report:** `reviews/<date>.json` and a review page on the dashboard: scores, problems, where each went, and benchmark results.

**Benchmarks** run on promptfoo, which handles repeated runs and side-by-side configurations; the factory adds a custom promptfoo provider that runs a pipeline on a frozen task. They build up automatically from every merged factory run: runs that needed no human changes, and runs a human corrected or finished, with the human-fixed merge as the known-good result. Users can also mark any run "representative." Including corrected and escalated work means the set contains the factory's failures, so a definition change can show it fixes them. The review also re-benchmarks when a new model is added to the price table, producing the cost vs. quality graph per pipeline.

**Two definition paths:** changes the review proposes are benchmark-gated as above; a context line that comes from a human correction (hardening's fourth outcome) goes straight to a definition PR, because the human already stated the intent.

## Trace capture

Every agent and human action that reaches the repo is recorded, from three sources.

| Source | Captured how | Lands as |
| --- | --- | --- |
| **Factory runs** | The runner writes step reports, gate attempts and artifacts during the run | `runs/…json`, `media/`, workflow artifacts |
| **Human PRs** | `factory-gates` runs the deterministic gates on every human PR, and `factory-rollup` records it with `actor.kind: human` (commits, diff size, review comments, gate results) | `runs/…json` |
| **Local agent sessions** | Each harness's end-of-session hook (installed at setup, committed to the repo) redacts the transcript and pushes it with the branch name, only for developers who opted in and only to a private data store | `sessions/…jsonl`, linked to the PR built on that branch |

- **Human corrections** are extracted from all three: review comments on factory PRs, pushes by humans onto factory branches, and pushback in local sessions.
- Each correction becomes a candidate (or adds an occurrence to one), is tagged and counted, starts hardening at 3 of the same kind within 14 days or as soon as a human labels it `factory:harden`, and appears in the next review.
- Local human IDE activity outside agent sessions is not captured; the PR is the human trace.
- **Session transcripts never land on a public branch.** On a public repo without the private data repo, local sessions aren't captured; corrections still come from review comments and pushes on factory PRs.
