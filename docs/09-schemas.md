# Build Software Factory — Schemas & Contracts

Nov 18, 2026 · @Philip

Every file the skill, the runner and the dashboard share is defined here; each has a JSON Schema in `/schema` and is validated on every read and write.

## Conventions

- **Formats:** human-edited files are YAML (`factory.yaml`, `policy.yaml`, roles, rubrics); machine-written files are JSON or JSONL.
- **Every file carries `schema: <name>/<major>`**, for example `schema: run/1`. Readers reject a major version they don't know.
- **IDs:** work items `wi_<ulid>`, runs `run_<ulid>`, reviews `rev_<yyyymmdd>`, benchmark tasks `bt_<ulid>`, candidates `cand_<ulid>`. ULIDs sort by time.
- **Times:** ISO 8601 in UTC. **Money:** USD as a decimal number. **Durations:** seconds.
- **Locations:** definition files in `.factory/definition/`, guardrail files in `.factory/guardrails/`, data files on `factory-data` (`refs/factory/data`), media on `factory-media` (`refs/factory/media`), live status on `refs/factory/live/<run-id>` refs (see the Architecture doc for the full tree).

## Factory config (`factory.yaml`)

The single file that defines how the factory runs; part of the factory definition, so changes need a trusted human's approval.

```yaml
schema: factory/1
harness: claude-code              # hermes-agent | claude-code | kilo-code | pi | cursor-cli
models:                           # model per step (self-improvement may change these)
  triage: <model-id>
  spec: <model-id>
  builder: <model-id>
  verifier: <model-id>
  gardener: <model-id>
  hardener: <model-id>
  scorer: <model-id>
pipelines:
  product_work: { auto_merge: false }
  gardening:    { auto_merge: false, schedule: "0 6 * * *", max_prs_per_run: 5 }
  hardening:    { auto_merge: false }
review:
  every_days: 3
  run_early_at_runs: 50
  skip_below_runs: 10
limits:
  retry_cap: 3                    # attempts per gate per work item
  step_time_budget_sec: 2700
  concurrency: { max_runs: 5 }
budget:
  monthly_usd: 200
  monthly_actions_minutes: 2000   # default: the plan's included minutes; null on public repos
  shares:                         # % of each limit each pipeline may use
    product_work: 60
    gardening: 25
    review_and_benchmarks: 15     # scheduled review, scorers, benchmark runs
  product_work_hard_stop_pct: 110 # product work may use unspent shares, up to 110% of either limit
triggers:
  issues: true
  comments: true
  ci_failure_on_main: true
  dashboard_dispatch: true
data:
  location: same_repo             # same_repo | repo
  repo: null                      # owner/name when location is repo
  sessions: auto                  # auto = capture only when the data store is private; off
  media_retention_months: 12      # media older than this is dropped at the monthly squash
enforcement:
  merge_queue: auto               # auto = GitHub's native merge queue when the repo qualifies, else the factory's fallback queue
  branch_protection: auto         # auto = add the factory's required checks when the plan allows it; never removes existing rules
  audit_revert_pr: false
human_prs:
  gates: deterministic            # static rules, tests, coverage; no agent verification
  verify_label: "factory:verify"  # adding this label runs agent runtime verification on a human PR
existing_ci:
  test_check: null                # the repo's own test check, only if it runs on factory/* pushes; Gate 2 reads its result
  wait_minutes: 15                # if the check hasn't reported by then, the gate runs the tests itself
```

## Policy (`policy.yaml`)

The policy says who can start work and which paths each pipeline may change; `factory-gates` always reads it from main.

```yaml
schema: policy/1
trust:
  associations: [OWNER, MEMBER, COLLABORATOR]   # write access required
  accept_label: "factory:accept"                 # lets a trusted person admit outside work
paths:
  definition: [".factory/definition/**"]
  guardrails:
    - ".factory/guardrails/**"
    - ".eslintrc*"                # existing tool configs, found at setup
    - "pyproject.toml#tool.ruff"
  tests: ["**/*.test.*", "**/test_*.py", "tests/**"]
  protected: [".github/workflows/**", ".github/dependabot.yml"]   # never changed by the factory
pipelines:                        # every pipeline may also lower counts in baselines.json and raise the floor in coverage.json
  product_work: { may_change: [code, tests] }
  gardening:    { may_change: [code, tests] }
  hardening:    { may_change: [code, tests, guardrails:tighten] }
  definition:   { may_change: [definition], requires: trusted_human_approval }
tests:
  declared_edits: required        # edits to existing test files must be listed in the spec
runner_upgrades:
  author: "dependabot[bot]"
  may_change: runner_pin          # only the `uses: build-software-factory/runner@<sha> # vX` lines
  requires: trusted_human_approval  # never auto-merged
weakening:
  requires: trusted_human_approval
  detects: [rule_removed, rule_loosened, baseline_raised, native_suppressions_added, unpruned_suppressions_allowed, coverage_floor_lowered, skip_without_reason]
protected_files:                  # passed to each role workflow's gh-aw safe outputs by factory-run
  policy: request-review          # gh-aw default; request-review | blocked | fallback-to-issue | allowed
  exclude:                        # per pipeline; everything not listed stays protected
    product_work: []
    gardening: []
    hardening: [".factory/guardrails/", "/pyproject.toml"]   # rooted paths found at setup
    definition: [".factory/definition/"]
```

- `guardrails:tighten` means the PR may add rules or tighten them; any change detected under `weakening.detects` still needs a trusted human.
- A PR touching a path its pipeline may not change fails the `factory/policy` check with the list of offending files. That check runs from main's copy of its workflow (`pull_request_target`) and reads only file lists, reviews and labels, so a PR can't change what judges it; any PR touching `protected` or `definition` paths fails it until a trusted human approves.
- **Baselines and coverage are one-way for everyone:** any pipeline may lower a count in `baselines.json` or raise `floor_pct` in `coverage.json`; the opposite direction is a weakening.
- **Declared test edits:** a factory PR that modifies or deletes an existing test file not listed in its spec's `tests_changed` fails the `factory/policy` check. New test files are always allowed.
- **Rule packs** (`rulepack/1`, `/rules/<language>.yaml`) are the one format setup reads rather than writes. Each rule names the tool it configures, the config fragment that turns it on, and **two examples: one the rule must reject and one it must accept.** Phase 3 installs a rule only after running the tool against both, because a rule that fires on both blocks correct code, a rule that fires on neither is decoration, and neither is visible from reading the config. A tool also carries a `base_config` — parser, source type, declared globals — without which a rule like `no-undef` fires on `module` in a CommonJS repo and would block every correct file.
- **Untrusted text:** comments and issue bodies from untrusted authors are removed before anything is put into a prompt.
- **`protected_files` is gh-aw's check, not the factory's.** gh-aw protects dependency manifests (by basename, anywhere), `.github/`, engine instruction files and every top-level dot-folder — `.factory/` included — and by default has the App submit an automatic `REQUEST_CHANGES` review on a PR that touches one. `exclude` entries match by basename or path prefix; a leading `/` makes it an exact repo-root path, so `/pyproject.toml` opts in the root file while `lib/foo/pyproject.toml` stays protected. Because the role workflows are `workflow_call` workflows and gh-aw accepts an expression for `protected-files`, `factory-run` passes the calling pipeline's policy. `.github/` is never excluded, in any pipeline. This is deliberately redundant with the `paths` rules above: two layers, different code.

## Role definitions (`roles/<role>.yaml`)

Each of the seven roles is one file; the pipelines are fixed, but a role's prompt is part of the factory definition.

```yaml
schema: role/1
id: builder                       # triage | spec | builder | verifier | gardener | hardener | scorer
purpose: Implement the spec with the smallest correct change, plus tests for new behavior.
reads_context: [feature-map, runbook, fundamentals, history]
tools: [read, edit, shell, git]   # verifier adds: browser, devtools
prompt: |
  You are the builder for <repo>. Follow the spec exactly ...
outputs: [diff, tests, notes]
```

- The model for each role comes from `factory.yaml`, not the role file.
- The verifier never receives the builder's transcript, only the spec and the result, so it judges the work independently.

## Context files (`context/*.md`)

Four markdown files every role reads; each has fixed top-level headings so agents and the review can edit precise sections.

| File | Holds | Required headings |
| --- | --- | --- |
| `feature-map.md` | What exists and where: one entry per feature folder | `## <feature>` with *Path*, *Purpose*, *Entry points*, *Depends on* |
| `runbook.md` | How to build, run, test and verify the app in the sandbox | `## Build`, `## Run`, `## Test`, `## Verify`, `## Seed data` |
| `fundamentals.md` | Principles and conventions no code check can enforce | `## <principle>` with a one-line rule and a short why |
| `history.md` | Lessons from past failures and escalations | `## <date> <title>` with *What happened*, *Lesson*, *Source* (run or review id) |

- Every line added by the factory ends with its source id, for example `(rev_20261121)`, so a reviewer can trace why it exists.
- Any repo with several apps gets one `##` section per app in `feature-map.md` and `runbook.md`.

## Work item

Every trigger becomes one work item before routing; it is the unit the ledger, runs and dashboard all refer to. Each work item is its own file on `factory-data` at `work-items/<id>.json`, written by intake when created and updated by the run that works on it; new files only, so parallel writes never conflict.

```json
{
  "schema": "work-item/1",
  "id": "wi_01JD8Z…",
  "created_at": "2026-11-18T23:40:00Z",
  "source": { "kind": "issue", "ref": "#142", "actor": "philip", "via": "slack" },
  "trigger_class": "signal",          
  "pipeline": "product_work",         
  "title": "Export button downloads an empty file",
  "body": "…",
  "priority": "normal",
  "fingerprint": "sha256:…",
  "status": "queued",
  "runs": [],
  "pr": null,
  "parent": null,
  "related": [],
  "spec": null
}
```

- `trigger_class`: `request` | `dev_event` | `signal` | `scheduled` | `self`.
- `pipeline`: `product_work` | `gardening` | `hardening` | `definition` | `conflict`.
- `status`: `queued` → `running` → `in_review` → `queued_to_merge` → `merged`, or `escalated` | `duplicate` | `rejected`.
- `fingerprint` is computed from the normalized title, body and touched area; intake uses it only to shortlist possible duplicates, and triage decides.
- `parent` links a conflict-resolution or retry item to the item it came from.
- `related` links a follow-up to an earlier item whose PR already merged (for example "still broken after #311"); the earlier PR is passed to triage as context.
- `spec` holds the spec once written: the plan, the acceptance checks, `tests_added` and `tests_changed` (existing test files the build will modify or delete).

## Ledger (`ledger.json`)

The ledger is the shared view every pipeline checks before starting work, plus the merge queue's order. It is derived: `factory-rollup` rebuilds it from the work-item files and open PRs, and `factory-merge` writes the `merge_queue` part.

```json
{
  "schema": "ledger/1",
  "updated_at": "2026-11-18T23:45:00Z",
  "open": [
    { "work_item": "wi_01JD8Z…", "pipeline": "product_work", "status": "running",
      "fingerprint": "sha256:…", "pr": 311, "fixes": ["rule:no-raw-fetch@src/export"] }
  ],
  "recent": [ { "work_item": "wi_…", "status": "merged", "merged_at": "…", "fingerprint": "…" } ],
  "merge_queue": [ { "pr": 309, "eligible_at": "2026-11-18T23:30:00Z" } ]
}
```

- **Duplicate check:** fingerprints only shortlist candidates. Triage compares the new item with the shortlisted open items and marks it `duplicate` (attached to the original) only when it asks for the same thing. A match with recently merged work never makes a duplicate: it becomes a high-priority follow-up with `related` set.
- **`fixes`** lists the rule violations or problem classes a run is fixing, so gardening and hardening never re-fix what an open PR already fixes.
- `recent` keeps 30 days; older entries live only in run files.

## Run file (`runs/<yyyy>/<mm>/<run-id>.json`)

One file per run, written once when the run ends; it is the complete record of what happened and what it cost.

```json
{
  "schema": "run/1",
  "id": "run_01JD9A…",
  "work_item": "wi_01JD8Z…",
  "pipeline": "product_work",
  "actor": { "kind": "agent", "harness": "claude-code" },
  "started_at": "…", "ended_at": "…", "duration_sec": 1840,
  "outcome": "draft_pr",
  "pr": 311,
  "steps": [
    { "role": "triage",  "model": "…", "duration_sec": 120, "tokens": { "in": 41000, "out": 2100, "cached": 30000 }, "cost_usd": 0.21, "transcript": "sessions/…" },
    { "role": "builder", "attempt": 2, "…": "…" }
  ],
  "gates": [
    { "gate": "static", "attempt": 1, "result": "fail", "failures": [{ "rule": "no-raw-fetch", "file": "src/export/download.ts", "line": 42 }] },
    { "gate": "static", "attempt": 2, "result": "pass" },
    { "gate": "verification", "attempt": 1, "result": "pass", "coverage": { "diff_pct": 94, "total_pct": 81.2 } }
  ],
  "artifacts": {
    "stored":   [{ "kind": "screenshot", "path": "media/run_01JD9A/export-ok.png", "caption": "Non-empty CSV downloads", "expires_at": "2027-11-18" }],
    "expiring":  [{ "kind": "video", "artifact_id": 88213, "expires_at": "2027-02-16" }]
  },
  "cost_usd": 1.84,
  "escalated": false
}
```

- `artifacts.stored` lives on the `factory-media` ref for `data.media_retention_months`; `artifacts.expiring` are workflow artifacts. Size caps: 1 MB per screenshot, 10 MB per clip, 25 MB per run; larger files stay workflow artifacts only.
- `actor.kind` is `agent` or `human`; human runs come from PRs a person opened and from local sessions.

**Session consent** is stored on each developer's own machine (in the harness's user-level config, never committed), so it's per person and per machine; the repo holds no list of who consented. Session files exist only in private data stores (see `data.sessions`).
- `outcome`: `draft_pr` | `merged` | `escalated` | `duplicate` | `failed` | `cancelled`.

## Index rollup (`index.json`)

The one file the dashboard loads first; `factory-rollup` rebuilds it after every factory workflow.

```json
{
  "schema": "index/1",
  "updated_at": "…",
  "factory": { "runner": "v1.0.3", "harness": "claude-code", "setup_completed_at": "…" },
  "metrics": {
    "window_days": 30,
    "automation_rate": 0.62,
    "cycle_time_p50_sec": 5400, "cycle_time_p90_sec": 21600,
    "spend_usd": 141.20, "budget_usd": 200,
    "runs": 214, "merged": 131, "escalated": 9, "revert_rate": 0.008,
    "by_pipeline": { "product_work": { "runs": 120, "merged": 80, "spend_usd": 98.4 } }
  },
  "daily": [ { "date": "2026-11-18", "runs": 9, "merged": 6, "spend_usd": 5.10 } ],
  "recent_runs": [ "run_…" ],
  "guardrails": { "rules": 47, "baselined": 3, "coverage_floor_pct": 81.0, "candidates_pending": 4 },
  "health": { "gardening_schedule_active": true, "last_review": "rev_20261118" }
}
```

## Live status (`refs/factory/live/<run-id>` ref)

While a run is in progress, the runner force-updates one small file on a ref of its own at every step change; the ref is deleted when the run ends, so it leaves no history. The Live view polls it.

```json
{ "schema": "live/1", "run": "run_01JD9A…", "work_item": "wi_01JD8Z…", "pipeline": "product_work",
  "step": "gate", "gate": "static", "attempt": 2, "of": 3, "started_at": "…", "cost_usd_so_far": 0.92 }
```

- **Automation rate** = merged factory PRs that needed no human code changes ÷ all merged PRs.
- **Revert rate** = factory PRs reverted within 14 days ÷ factory PRs merged, per pipeline as well as overall (from v0.1).
- **Cycle time** = work item created → merged.
- `daily` keeps 365 days for the trend charts.

## Baselines and coverage floor (`baselines.json`, `coverage.json`)

**Native baselines first.** Where a linter has its own baseline file (ESLint's `eslint-suppressions.json` with per-file, per-rule counts; Oxlint's suppressions; Semgrep's `--baseline-commit`; the equivalents other rule packs configure), that file *is* the baseline and the ratchet reads counts from it. `baselines.json` holds counts only for checks with no native baseline (Betterer covers several of these), plus a summary of every rule for the dashboard. The weakening check diffs both: an entry added to a native suppression file, a raised count, or a setting that lets stale suppressions pass (for example ESLint's `--pass-on-unpruned-suppressions`) is a weakening.

Per-rule violation counts during cleanup, and the coverage ratchet; both are guardrails, so lowering is free and raising needs a trusted human.

```json
{
  "schema": "baselines/1",
  "rules": {
    "no-raw-fetch":           { "count": 37, "recorded_at": "…",
                                "by_file": { "src/export/download.ts": 3, "src/billing/api.ts": 2, "…": "…" } },
    "one-folder-per-feature": { "count": 0,  "retired": true }
  }
}
```

```json
{ "schema": "coverage/1", "high_pct": 82.0, "floor_pct": 81.0, "tolerance_pts": 1, "diff_min_pct": 80, "skips": { "count": 4, "cap": 10 } }
```

- **Every PR must raise no count, in any file.** Counts are kept per file, so fixing one violation in one file can't pay for a new one in another. Only gardening PRs for a baselined rule must also lower that rule's count. A rule at 0 is `retired` and becomes plain pass/fail.
- **Diff coverage is the main coverage check:** changed lines must be at least `diff_min_pct` covered.
- **Total coverage trails its high:** `floor_pct` = `high_pct` − `tolerance_pts`. When a merge raises total coverage, `high_pct` and `floor_pct` rise with it; a PR fails only if total coverage would fall below `floor_pct`. Lowering the floor any other way needs a trusted human.
- Each skip in the code must carry a reason comment; `skips.count` is the number of skips, capped at `skips.cap`.

## Guardrail candidates (`candidates.json`)

Every mined correction becomes a candidate; setup and hardening decide what each becomes.

```json
{
  "schema": "candidates/1",
  "candidates": [
    {
      "id": "cand_01JD…",
      "problem_class": "Network calls bypass apiClient",
      "occurrences": 15,
      "sources": [
        { "kind": "agent_chat", "harness": "claude-code", "session": "…", "quote": "no, use apiClient instead" },
        { "kind": "review_comment", "pr": 87 },
        { "kind": "revert", "commit": "a1b2c3d" }
      ],
      "proposed_fix": "static_rule",
      "status": "pending"
    }
  ]
}
```

- `kind` of source: `agent_chat` | `review_comment` | `revert` | `fix_commit` | `bug` | `prose_rule` | `escalation` | `review_failure`.
- `proposed_fix` follows the ordered check: `api_change` | `static_rule` | `verification` | `context` (context candidates go to the definition path).
- Every correction becomes a candidate (or adds an occurrence to one). Hardening starts for a candidate at 3 occurrences within 14 days, or as soon as a human labels a correction `factory:harden`.
- `status`: `pending` | `accepted` | `rejected` | `installed` (with the rule or PR that installed it).

## Scorer rubrics and review reports

Rubrics define how the scheduled review grades work; the review report records what it found and where each failure was routed.

```yaml
schema: rubric/1
pipeline: product_work        # one rubric per pipeline; shared.yaml applies to all
criteria:
  - id: followed_intent
    question: Does the change do what the work item asked, and nothing else?
  - id: minimal_change
  - id: matches_patterns
  - id: meaningful_tests
  - id: artifacts_prove_claim
scale: 1-5                    # 1-2 = failure, 3 = weak, 4-5 = good
failure_tags: [wrong_scope, pattern_drift, weak_tests, missing_evidence, context_gap, wrong_model_fit]
```

```json
{
  "schema": "review/1",
  "id": "rev_20261121",
  "window": { "from": "…", "to": "…", "runs": 63 },
  "scores": [ { "run": "run_…", "criterion": "meaningful_tests", "score": 2, "tags": ["weak_tests"], "note": "…" } ],
  "problems": [
    { "title": "Tests assert on mocks only in billing", "runs": ["run_…"], "route": "hardening", "work_item": "wi_…" },
    { "title": "Builder ignores the Seed data runbook step", "route": "definition", "change": "context/runbook.md",
      "benchmark": { "tasks": 12, "repeats": 3, "failure_tasks": 4,
                     "before": { "mean": 0.71, "spread": 0.04 }, "after": { "mean": 0.83, "spread": 0.03 },
                     "failure_tasks_before": 0.40, "failure_tasks_after": 0.78, "regressions": 0 },
      "pr": 330 }
  ]
}
```

## Benchmark tasks (`benchmarks/tasks/<id>.json`)

A benchmark task is a frozen copy of real past work: the repo state before, the request, and the known-good result to grade against.

```json
{
  "schema": "benchmark-task/1",
  "id": "bt_01JD…",
  "source_run": "run_…",
  "origin": "succeeded",
  "pipeline": "product_work",
  "base_commit": "9f8e7d6",
  "request": { "title": "…", "body": "…" },
  "reference": { "merged_commit": "1a2b3c4", "tests": ["src/export/download.test.ts"] },
  "grading": { "must_pass": ["src/export/download.test.ts"], "rubric": "product_work" },
  "tags": ["representative", "export"]
}
```

- `origin`: `succeeded` (merged with no human code changes) | `corrected` (a human pushed or requested changes before merge) | `escalated` (a human finished it) | `representative` (marked by a user). For `corrected` and `escalated` tasks, `reference.merged_commit` is the human-fixed result, so the set includes the work the factory got wrong.
- Tasks are created automatically from every merged factory run, plus any run a user marks representative.
- A benchmark run checks out `base_commit`, runs the pipeline with a given configuration, then grades with the reference tests and the rubric. Results record cost and quality, which feed the cost vs. quality graph.
- **Which context a task runs with:** model comparisons use the context files as they were at `base_commit`; context changes are tested only on tasks from the last 60 days, with the proposed context applied.
- **Noise:** a comparison runs each configuration 3 times on at least 10 tasks. A change counts as better only if its mean beats the other's by more than the larger of the two run-to-run spreads.

## Adapter step report

Every adapter returns this report for every agent step; cost tracking, the run file and the live view all depend on it.

```json
{
  "schema": "step-report/1",
  "harness": "kilo-code",
  "role": "builder",
  "model": "<model-id>",
  "exit": "ok",
  "duration_sec": 512,
  "tokens": { "in": 182000, "out": 9400, "cached": 120000 },
  "cost_usd": 0.94,
  "files_changed": ["src/export/download.ts", "src/export/download.test.ts"],
  "transcript": "/tmp/gh-aw/agent/bsf/run_…/builder-2.jsonl"
}
```

- `exit`: `ok` | `error` | `timeout` | `refused`.
- Tokens come from the harness's own session log, read with memex after the step; the cost the log records is kept, and only when it records none is cost computed from tokens with the bundled LiteLLM price table. A step with no token data fails adapter conformance tests.
- The normalized transcript is JSONL with one event per line: `{ "t": "…", "type": "user|assistant|tool_call|tool_result", "content": … }`.
- **Nothing passes between roles as a job output, because gh-aw does not allow it.** gh-aw's `workflow_call` accepts `inputs` and `secrets` only — there is no `outputs` — so a role workflow cannot return a value to its caller at all. Results travel as workflow artifacts under deterministic names within the run (`step-report-<role>-<attempt>`, `verification-<attempt>`), which the next role's `pre-agent-steps` downloads, and anything durable goes to `factory-data`. This is stricter than a size limit: `factory-run` cannot read a role's result in an expression, so every decision that depends on one is made by a deterministic `bsf` step that fetches the artifact itself.

## Versioning and migration

Schemas change only through versioned, additive steps, so a repo's data always stays readable by the dashboard.

1. **Additive changes** (a new optional field) keep the major version. Readers ignore fields they don't know.
2. **Breaking changes** bump the major version (`run/1` → `run/2`) and ship with a migration in `bsf migrate`.
3. **Old data is never rewritten in place.** Migrations write new files next to old ones, and the dashboard reads both majors for at least 12 months.
4. **Config migrations** (`factory.yaml`, `policy.yaml`) arrive as a definition PR opened by the factory after a runner upgrade, so a trusted human approves them. Runner upgrades themselves arrive as Dependabot PRs that change only the pinned SHA in the workflow files (see `runner_upgrades` in `policy.yaml`); the runner version a repo uses is read from those files, not from `factory.yaml`.
5. **Every runner release lists** the schema versions it reads and writes; the dashboard shows a warning when a repo's runner is older than the oldest version the dashboard supports.

### How this is enforced

The five rules above are mechanical, so the build checks them rather than trusting review.

**`schema/SURFACE.json`** records the shape of every schema at the frozen major: for each node, by JSON pointer, its type, property names, required list, `additionalProperties`, enum members, pattern, `$ref` and bounds. Schema 1.0 was frozen on 2026-11-20.

**`bsf schema-surface --check`** compares the live schemas against that file and sorts the differences into three kinds:

| | Example | Result |
|---|---|---|
| additive | a new optional property; a required field becoming optional; a bound loosening | reported, allowed |
| widening | a new enum member | reported separately, allowed |
| breaking | a property removed; an optional field becoming required; a type, pattern or `$ref` change; an enum member removed; `additionalProperties` closing; a bound tightening | **fails** |

Widening is called out on its own because rule 1 covers unknown *fields*, which a reader ignores — not unknown *values* of a field it already knows, which it rejects. Adding `unknown` to `step-report`'s `cost_source` was such a change.

A breaking change is not forbidden; it is routed. The author bumps the major, adds a migration, and re-freezes in the same commit, which is exactly rule 2. `bsf schema-surface --freeze` rewrites the file. CI runs `--check` on every push, so a re-freeze cannot be forgotten.

**`bsf migrate PATHS...`** applies the registry of migrations in `runner/src/commands/migrate.ts`. Each migration declares its schema, the major it moves from and to, a one-line summary, and a pure `up(doc)`. The command plans first — printing each file's chain and the path it would write — and writes only with `--apply`. Three details follow from rule 3:

- A migrated file is written **next to** the original, as `<name>.v<major>.json`. The original is never touched, and a run that fails halfway leaves the data ref readable.
- Writing refuses to overwrite an existing file, so a second run cannot clobber the first run's output.
- Each migrated document is validated before it is written, so a migration that produces an invalid file fails loudly instead of writing something no reader accepts.

A gap in the chain — major 1 present, no 1→2 migration, but a 2→3 — is reported rather than guessed across, because a skipped migration means the author, not the tool, has to decide what the data means.

**`bsf migrate --support`** prints what the running runner reads and writes, one line per schema, which is rule 5. At 1.0 every line reads `writes 1, reads 1`, and the migration registry is empty — that is the freeze, not an unfinished feature.
