# Build Software Factory — Dashboard Spec

Nov 18, 2026 · @Philip

The dashboard is the one place to see everything the factory is doing, act on what needs a human, and change how the factory runs; it is a static web app that reads and writes the user's own GitHub repo.

## Users and goals

| User | Comes to the dashboard to | Most-used pages |
| --- | --- | --- |
| **Product engineer** | Request work, see where it is, review and approve PRs by looking at evidence | Home, Live, Run detail |
| **Factory engineer** | Watch automation rate, cycle time and spend; find failure patterns; approve guardrail and definition changes; flip auto-merge toggles | Dashboard, Guardrails, Improvement, Factory |

**Reference: Warp Factories.** The page structure follows the shape of Warp's factory dashboard, adapted to a static app with no backend:

- a metrics landing page over a chosen date range, built around autonomy (merged PRs that needed no human code push), PR cycle time with a median per stage, and cost per PR;
- a personal page that defaults to work waiting on you: questions, spec approvals, PR reviews;
- run pages showing timeline and cost, with actions to stop a run, score it, or turn it into a benchmark task;
- separate areas for scorers, self-improvement PRs and benchmarks.

What Build Software Factory adds: guardrail health (rules, baselines, coverage), the merge queue, and "human interactions per PR", which Warp's team tracks as a proxy for how much steering the agents need.

Sources: [Warp factory dashboard docs](https://docs.warp.dev/factories/factory-dashboard/) · [Warp measure & improve docs](https://docs.warp.dev/factories/measure-and-improve/) · [How I AI: Inside Warp's software factory](https://www.chatprd.ai/how-i-ai/inside-warps-software-factory)

## Page map

Nine pages in a left sidebar, with a repo switcher at the top; every page works for one repo at a time.

| Page | Route | Answers |
| --- | --- | --- |
| **Home** | `/` | What's waiting on me? |
| **Dashboard** | `/dashboard` | How is the factory doing? |
| **Live** | `/live` | What's running right now? |
| **Work items** | `/work` | Where is each request? |
| **Runs** | `/runs`, `/run?id=` | What exactly did a run do, and what did it cost? |
| **Guardrails** | `/guardrails` | How strict is the codebase, and how is cleanup going? |
| **Improvement** | `/improvement` | What did the last review find, and which configuration is best? |
| **Factory** | `/factory` | How is the factory configured? (toggles, models, budget, schedules) |
| **Sessions** | `/sessions` | What happened in captured local agent sessions? |

A **New request** button sits at the top of every page; it opens a short form that creates a GitHub issue, which the factory picks up like any other request.

## Dashboard page (metrics)

The metrics landing page for a chosen date range (7, 30 or 90 days), comparing each number with the previous period.

**Headline row** (one tile each, with the change vs. the previous period):

| Tile | Definition |
| --- | --- |
| Autonomy | Merged factory PRs that needed no human code push ÷ all merged PRs |
| Cycle time | Median work item created → merged, with a median per stage: triage, spec, build, gates, waiting for review, merge queue |
| Cost per PR | Median model cost per merged PR, including retries and conflict resolution |
| Spend vs. budget | Month-to-date model spend and Actions minutes against both limits and each pipeline's share, with a projection to month end |
| Human interactions per PR | Review comments, pushes and guidance comments per merged factory PR |
| Revert rate | Factory PRs reverted within 14 days ÷ factory PRs merged |

**Charts:** PRs opened vs. merged per day; spend per day stacked by pipeline; cycle time trend (p50 and p90).

**Lists:** most expensive PRs; latest scorer results (pass rate per rubric); the three newest improvement PRs; cleanup progress per baselined rule.

Each tile, chart point and list row links to the runs behind it.

## Live view

A board of everything in flight, refreshed every 5 seconds while the page is open.

- **Columns:** Queued → Triage → Spec → Build → Gates → Draft PR → Merge queue. Each card is a work item showing pipeline (colored tag), title, current step, attempt number (e.g. "Gate 1, attempt 2 of 3"), elapsed time and cost so far.
- **Filters:** pipeline, source (issue, Slack, Linear, Sentry, schedule, review), actor.
- **Merge queue strip** under the board: queued PRs in order, the one being processed, and its gate status.
- **Escalations** appear as pinned cards in a red lane at the top until a human acts.
- **Factory health bar** at the top: runs in flight vs. concurrency limit, budget used per share, gardening schedule active, last review date, runner version. A disabled gardening schedule (public repo inactivity) shows as a warning with a one-click re-enable.
- Clicking a card opens its run detail.

## Runs and run detail

**Runs list:** every run, newest first, with pipeline, work item, actor (agent harness or human), outcome, duration and cost; filters for pipeline, outcome, actor, model and date. Runs for the same work item (retries, conflict resolution) group under it.

**Run detail** (`/run?id=`), top to bottom:

1. **Header:** work item title and source link, pipeline, outcome, PR link, total duration and cost.
2. **Timeline:** one row per step (triage, spec, builder attempts, gate attempts, verifier) on a time axis, colored by pass/fail, with duration and cost on each.
3. **Gate results:** each attempt with its failures (rule, file, line) and the fix that followed; coverage numbers; ratchet change.
4. **Evidence:** stored screenshots and clips inline (kept 12 months by default); full videos and logs as links with their expiry date ("expired" once gone).
5. **Transcript:** the normalized transcript of each step, collapsible tool calls, searchable.
6. **Cost breakdown:** tokens in/out/cached and cost per step and model.
7. **Scores:** the scheduled review's scores for this run, once reviewed.
8. **Actions:** cancel (while running), re-run, mark as representative (turns it into a benchmark task), give guidance (restarts with a comment).

## Home: waiting on you

Home is the review queue: everything that needs this user, oldest first, grouped by kind.

| Group | Item | Actions |
| --- | --- | --- |
| **PRs to approve** | Draft PRs in pipelines with auto-merge off, any PR the weakening check flagged, and runner upgrade PRs (with the release notes) | Open review · Approve · Request changes |
| **Definition changes** | Context or model changes from the scheduled review, with benchmark before/after (mean and spread, failure tasks, regressions); context lines from human corrections, with the corrections they came from | Approve · Reject |
| **Escalations** | Work the factory couldn't finish, with its best guess at the blocker | Give guidance · Take over · Close |
| **Questions** | Triage's "needs info" questions on the user's requests | Answer (posts a comment on the issue) |
| **Guardrail candidates** | New candidates from local sessions or `bsf contribute-corrections` | Accept · Reject |
| **Outside requests** | Issues from untrusted authors, and issues created by an integration's bot (Linear, Sentry), waiting for `factory:accept` | Accept · Ignore |

**PR review view** (opened from Home or a run): the PR body's evidence first (screenshots, clips, before/after), then gate results, the spec, and only then a collapsed diff. Approve and Request changes sit at the top and bottom.

**Work items** (`/work`): every work item with source, pipeline, status, cost and links to its runs and PR; filters by status and source; duplicates shown linked to their original.

**Sessions** (`/sessions`): captured local agent sessions with harness, author, branch, linked PR, and the corrections extracted from each. When capture is off (a public repo without the private data repo), the page says why and links to the setting.

## Guardrails

One page showing how strict the codebase is and how cleanup is going.

- **Summary row:** number of rules by base kind, rules still baselined, coverage floor, skips used vs. cap, candidates pending.
- **Rules table:** rule name, plain-language description, base kind, source (universal, codebase pattern, mined correction, hardening), date added, current violations, and the PR that added it. Clicking a rule shows its proof (bad example caught, good example passed) and the corrections it came from.
- **Cleanup progress:** for each baselined rule, a bar from the count at setup to zero, with the gardening PRs that brought it down.
- **Coverage:** total coverage over time against the floor, and coverage per feature folder (lowest first).
- **Candidates:** pending candidates with occurrences, sources, an example quote and the proposed fix; accept or reject in place.
- **Hardening history:** every hardening PR, newest first, with the problem class it eliminated.

## Improvement: scheduled reviews and benchmarks

Where the factory engineer sees what the scheduled review found and which configuration works best.

**Reviews**

- List of scheduled reviews: date, runs reviewed, pass rate per rubric, problems found, where each went (hardening or definition).
- **Review page:** scores per criterion across runs; failure tags ranked by count; each problem with its example runs, its route, and the resulting work item or PR.
- **Scorer cards:** pass rate per rubric over time, so a drop is visible at a glance.

**Benchmarks**

- The task set: each task's source run, pipeline, origin (succeeded, corrected, escalated, representative) and tags; tasks marked representative are highlighted.
- **Cost vs. quality chart per pipeline:** each configuration tried (model per step) is a point, cost per task on one axis and benchmark score on the other, with the current configuration marked. The frontier of best score for the cost is drawn as a line.
- **Run a comparison:** pick configurations and a task set; this dispatches a benchmark run (3 repeats per side by default) and the results appear here when done, with each side's spread, so a difference inside the noise is shown as "no clear winner".

**Improvement PRs:** every definition change the review proposed, with its benchmark result and status.

## Factory settings and toggles

The Factory page shows the whole factory definition in readable form and lets a trusted human change it; every change becomes a commit through a PR, never a hidden setting.

| Section | Shows | Can change |
| --- | --- | --- |
| **Autonomy** | The three auto-merge toggles, with each pipeline's revert rate and scorer pass rate as context | Toggle on/off |
| **Models** | The model for each role, with cost per run and score from the last benchmark | Pick a model per role |
| **Schedules** | Gardening time and max PRs per night; review cadence and thresholds | Edit values |
| **Budget** | Monthly model budget and Actions minutes limit, each pipeline's share of both and its use, projection, the 110% product-work limit | Edit limits and shares |
| **Roles and context** | Each role's prompt and the four context files, rendered, with the source id on each factory-added line | View (edits go through a definition PR in GitHub) |
| **Trust and triggers** | Trusted associations, accept label, enabled trigger sources, Slack/Linear/Sentry connection status | Enable/disable triggers |
| **Enforcement** | Plan detected, branch protection on/off, audit mode, private data storage, session capture on/off and why | Turn on audit revert PRs |
| **Health** | Pinned runner version and latest release, any open upgrade PR, Dependabot entry present, App installation, secrets present, schedules active, private data repo collaborators in sync | Open the upgrade PR for review |

## Data access and auth

The browser talks to GitHub directly with the user's own access; no data passes through any maintainer server.

**Sign-in (the user picks one)**

1. **GitHub login** through the free Cloudflare Worker in `/worker`, which only performs the OAuth code-for-token exchange and stores nothing. The token lives in `sessionStorage` and is cleared when the tab closes.
2. **Fine-grained token** pasted by the user, scoped to the repo with: contents read/write, pull requests read/write, issues read/write, actions read/write, metadata read. Kept in memory, or in `localStorage` only if the user ticks "remember on this device."

**What the dashboard reads**

| Data | Source | Refresh |
| --- | --- | --- |
| Metrics, recent runs, guardrail summary | `index.json` on `factory-data` | Every 60 s |
| Open work, merge queue | `ledger.json` | Every 15 s on Live and Home |
| One run's full record | `runs/…/<id>.json` + `media/<id>/` | On open |
| In-progress runs: step, gate, attempt, cost so far | Status files on `refs/factory/live/<run-id>` refs (Git refs API, then the file at that commit) | Every 5 s on Live and an open running run |
| Step logs of a finished job | Actions API (jobs and logs) | On open |
| Work items and their specs | `work-items/<id>.json` on `factory-data` | On open |
| Screenshots and clips | `factory-media` ref | On open |
| Long artifacts | Actions artifacts API | On click |
| PRs, reviews, comments | Pulls and issues APIs | On open; every 30 s on Home |
| Definition and guardrail files | Contents API on main | On open |

**Staying under rate limits:** every read sends the previous ETag, so unchanged files return 304; polling runs only for visible pages and pauses when the tab is hidden. A full day of normal use stays well under GitHub's per-user hourly limit.

## Write actions

Every change the dashboard makes is a normal GitHub action taken as the signed-in user, so it's recorded and attributable.

| Action | What the dashboard does on GitHub |
| --- | --- |
| New request | Creates an issue |
| Approve / request changes | Submits a PR review as the user |
| Answer a triage question, give guidance | Posts a comment on the issue or PR |
| Accept an outside request | Adds the `factory:accept` label |
| Accept / reject a guardrail candidate | Opens a PR updating `candidates.json` (hardening then installs accepted ones) |
| Flip a toggle, change models, schedules, budget or triggers | Opens a definition PR editing `factory.yaml`, authored by the user |
| Mark a run representative | Commits a benchmark task file to `factory-data` |
| Run gardening now, run a review, run a benchmark comparison | Dispatches the workflow (`workflow_dispatch`) |
| Cancel a run | Cancels the workflow run |

**Definition PRs from the dashboard:** because the author is a trusted human, the path policy counts the PR as human-approved; it merges through the factory's merge queue once gates pass, usually within minutes. The protection the factory adds requires PRs and passing checks, not review approvals, so solo maintainers aren't blocked from changing their own factory (a repo's own existing approval rules still apply).

## Design direction

A calm control room: dense with information, but quiet until something needs attention.

- **Light and dark themes,** following the system setting.
- **Status carries the color, nothing else does.** Neutral grays for structure; one accent for the user's own actions; green pass, amber waiting, red fail or escalated. Pipelines get small colored tags, not colored panels.
- **Typography:** a clean sans for UI, a monospace for IDs, paths, commands and costs. Numbers use tabular figures so columns line up.
- **Evidence first.** Wherever a human judges work, screenshots and clips come before text and diffs.
- **Live without noise.** Changes animate in briefly (a card sliding to the next column, a number ticking up); nothing blinks or loops.
- **Every number is a door.** Tiles, chart points and table rows link to the runs behind them.
- **Keyboard first:** `g h` Home, `g l` Live, `g r` Runs, `/` search, `a` approve in review view.
- **Empty states teach.** A fresh factory shows what will appear and how to trigger the first work, not blank panels.
- **Responsive:** Home, Live and PR review work on a phone for quick approvals; the other pages are desktop-first.

## Static-export constraints

The dashboard is a Next.js app built with `output: 'export'` and served as static files from Cloudflare Pages, so it costs nothing to run at any number of users.

- **No server code:** no server components that fetch data, no API routes, no middleware, no server actions. All data fetching happens in the browser.
- **Routes known at build time only.** Pages for a specific item read the ID from the query string: `/run?id=`, `/review?pr=`, `/rule?id=`. The repo comes from `?repo=owner/name` and is remembered per browser.
- **Client data layer:** one fetch wrapper that adds auth, ETags and rate-limit handling; a cache keyed by URL; polling hooks that stop when the tab is hidden.
- **Schema validation in the browser:** every file read from `factory-data` is validated against `/schema`; unknown major versions show an "upgrade your runner" notice instead of breaking the page.
- **Self-hostable:** the same build deploys to any static host, or runs locally with `npx build-software-factory dashboard`.
- **The only optional server piece** is the sign-in Worker, which uses a few requests per login, well within Cloudflare's free tier.
