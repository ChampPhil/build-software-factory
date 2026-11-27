# Self-Improvement

The factory records everything it does, and every few days it grades the recent work. A failure becomes hardening. A failure found while hardening is shown to a person and is not hardened again, so hardening cannot feed itself. The definition changes only when a person says so, with `/practice`.

Self-improvement has two parts: instrumentation that records everything continuously, and a scheduled review that grades recent work and routes each failure.

**Part 1 — Instrumentation (always on).** Every run file, step report, gate attempt, artifact, human correction, escalation and local session transcript is stored on `factory-data` (Trace capture, below).

**Part 2 — The scheduled review** (`factory-review`): every 3 days, early once 50 runs pile up, skipped when fewer than 5 runs happened since the last one. The first review is never skipped for too few runs: it is due 3 days after the first graded run.

1. **Grade:** scorers, run on promptfoo's LLM-rubric graders, evaluate every run since the last review against its pipeline's rubric plus the shared rubric (1–5 per criterion, with failure tags).
2. **Collect failures:** scores of 1–2, escalations, reverts of factory PRs, and human corrections.
3. **Group** failures into problems (same tag + same area or same role).
4. **Route each problem by where its fix belongs:**
   - every problem goes to **hardening** (a work item). A problem found in a hardening run is the exception: it is recorded as `unrouted` and shown on the Improvement page, and no new work item is filed, so hardening cannot feed itself.
5. **Report:** `reviews/<date>.json` and the Improvement page on the dashboard: scores, problems, where each went, and any `unrouted` ones.

`/practice` runs (the `definition` pipeline) are not scored: the review skips them.

**One definition path in v1.0:** changes to the factory definition come only from `/practice` comments (a person declaring a practice to enforce), which go to the definition pipeline for human approval. The review has no definition route; automatic, benchmark-tested definition changes are planned for v1.1.

## Trace capture

Every agent and human action that reaches the repo is recorded, from three sources.

| Source | Captured how | Lands as |
| --- | --- | --- |
| **Factory runs** | The runner writes step reports, gate attempts and artifacts during the run | `runs/…json`, `media/`, workflow artifacts |
| **Human PRs** | `factory-gates` runs the deterministic gates on every human PR, and `factory-rollup` records it with `actor.kind: human` (commits, diff size, review comments, gate results) | `runs/…json` |
| **Local agent sessions** | Each harness's end-of-session hook (installed at setup, committed to the repo) redacts the transcript and pushes it with the branch name, only for developers who opted in and only to a private data store | `sessions/…jsonl`, linked to the PR built on that branch |

- **Human corrections** are extracted from all three: review comments on factory PRs, pushes by humans onto factory branches, and pushback in local sessions.
- Each correction starts hardening immediately (no threshold, no label), is recorded on the corrected run as `human_corrections`, and is linked from the guardrail or change it produces.
- Local capture is a Claude Code `UserPromptSubmit` hook, installed on request with `bsf local-hook --install` into the developer's own `.claude/settings.local.json` (not shared). It refuses public repos unless `--allow-public`, redacts secrets, and sends only prompts that read as corrections.
- Local human IDE activity outside agent sessions is not captured; the PR is the human trace.
- **Session transcripts never land on a public branch.** On a public repo without the private data repo, local sessions aren't captured; corrections still come from review comments and pushes on factory PRs.

Hardening comes first. When a fix can be a code check, it goes to hardening and stays out of the prose the agents read. Instrumentation starts when the factory is switched on. The first review runs three days after the first graded run, then every three days.
