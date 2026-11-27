# Pipelines

Three pipelines produce code: product work, gardening, and hardening. Each ends in a draft pull request that has passed the [clear loop](Verification.md). Two other paths start work and do not follow that shape. A change to the factory's own definition waits for a person. A merge conflict is rebuilt on the latest code; that path is [The Merge Queue](<The Merge Queue.md>).

## The three code pipelines

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
- A merge conflict on a factory pull request is rebuilt on the latest main as a fresh pull request, cleared again, and approved again. Contradicting intents escalate to a person. The mechanics are in [The Merge Queue](<The Merge Queue.md>).
- **Pipelines know what each other are doing** → before starting, every pipeline checks a shared work ledger: open PRs, in-flight runs and recent work. The goal is to avoid duplicate work, not to avoid touching the same files: a new work item that matches an existing one attaches to it instead of starting a duplicate; gardening doesn't re-fix a violation an open PR already fixes; hardening checks for an existing rule or candidate first. Nothing is locked: overlapping changes are expected and handled by conflict resolution and the merge queue.

## Product work

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

## Gardening

**Scheduled scan → find drift → fix (factory clear) → draft PR**, nightly, at most 5 PRs a night.

1. **Scan** (gardener role, once a night in `factory-garden`; it does not run again in each item's run) for three kinds of drift:
   - **Baselined violations:** rules with counts above zero in `baselines.json`.
   - **Principle drift no rule catches:** duplicate patterns for one concern, nuance-heavy APIs, dead code, folders breaking one-folder-per-feature.
   - **Untested recent behavior:** code merged in the last 14 days that lacks tests or guardrails.
2. **Pick up to 5 items**, skipping anything an open PR already fixes (the ledger's `fixes` list). Picks may not overlap: no two picks, and no pick and an open gardening item, change the same files (a pick naming no files is repo-wide), and several picks that need one missing prerequisite (a test runner) are one pick, the prerequisite. Order: baselines with the most violations, then untested behavior, then principle drift.
3. **One problem class per PR,** each kept small: at most 20 files.
4. **Build and verify** through factory-clear. Gardening must not change behavior: the verifier compares before and after on the affected flows. A PR for a baselined rule must lower that rule's count, and no rule's count may rise in any file.
5. **Draft PR** with the before/after evidence and a summary of what was cleaned.

**Hand-off to hardening:** when the same principle drift is found in 3 gardening runs, the gardener files a hardening work item for it, so it becomes a rule and gardening stops having to fix it.

## Hardening

**Correction or repeated failure → generalize to the problem class → write the check or codebase change → fix existing violations (factory clear) → draft PR**

**Inputs:** every human correction (PR review comment, change request, pushed fix, or a correction in a local Claude Code session), a gardening hand-off, or a problem the scheduled review routed here. There is no threshold and no label: one correction is enough.

1. **Generalize** (hardener role): turn the specific instance into a problem class ("network calls bypass `apiClient`"), and check the ledger and `candidates.json` for an existing rule or candidate first.
2. **Choose how the codebase changes.** Three options, equal in standing; the hardener picks whichever fits the problem and says in the PR why it beat the other two:
   1. A **new static rule** a script can check without running the code.
   2. A **stronger verification requirement**: a test, scenario or acceptance check that fails on the mistake.
   3. A **refactor** that eliminates the problem class (for example, one API that makes the mistake impossible). This is a first-class choice, not a fallback.

   Product intent is encoded as tests, types or rules, never as prose in `.factory/definition/`. The hardener may not edit the definition, and hardening never hardens on itself.
3. **Verify the check itself:** the new rule or test must fail on the original bad example and pass on the correct pattern.
4. **Fix existing violations** in the same PR if they fit (25 or fewer across 20 or fewer files); otherwise add a baseline and seed gardening items.
5. **Factory-clear,** then a **draft PR** with the rule in plain language, why it exists, proof it works, and its impact.

Hardening may add or tighten guardrails only; anything the weakening check flags still needs a trusted human.

## Definition changes

A `/practice` comment declares a practice. It becomes a definition change, and a person approves the pull request. The scheduled review does not change the definition. That path is [Self-Improvement](Self-Improvement.md).

## What the reviewer is checking

Every factory pull request is rendered by the runner from the roles' reports, so the reviewer judges it from the proof. The layout of that proof is in [Verification](Verification.md).

| Pipeline | Reviewer is checking | Evidence |
| --- | --- | --- |
| Product work | The requested behavior now works | Before/after screenshots and one screen recording of the acceptance checks. A change the spec marks `ui_change: true` cannot pass the pull-request report check without a video |
| Gardening | Behavior is unchanged and the code is cleaner | Before/after evidence on affected flows; rule counts before and after; list of what was cleaned |
| Hardening | This is a rule we want | The rule in plain language; why it exists, linked to the corrections; proof it catches the bad example and passes the good one; violations fixed or baselined |
| Definition | The context or model change is an improvement | The change in plain words; the practice it adds and where it came from |
| Conflict resolution | Both intents are preserved | Both specs side by side; how each conflict was resolved; fresh verification evidence |

## Escalation

When the factory can't finish work on its own, it stops and hands a human everything needed to decide.

**Escalates when:**

- a gate fails 3 times for the same work item;
- triage can't reproduce a bug, which it reports as an escalation;
- a conflict's two intents contradict;
- a run hits its time budget 3 times;
- the budget stop pauses product work.

**What happens:**

1. The work item becomes `escalated`; the PR (if any) gets the `factory:escalated` label and a comment.
2. The comment and the dashboard's review queue show: what was attempted, every gate failure with its output, the last diff, and the factory's best guess at what's blocking.
3. A human can **give guidance** (a comment that restarts the run with it as input, with a fresh retry count), **take over** (push to the branch themselves), or **close** it.
4. Every escalation is recorded and reviewed at the next scheduled review; repeated escalations of one kind become a hardening or definition problem.
