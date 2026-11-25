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
- run pages showing timeline and cost, with actions to stop a run or give it guidance;
- a separate Improvement area for the scheduled reviews and scorer cards.

What Build Software Factory adds: guardrail health (rules, baselines, coverage), the merge queue, and "human interactions per PR", which Warp's team tracks as a proxy for how much steering the agents need.

Sources: [Warp factory dashboard docs](https://docs.warp.dev/factories/factory-dashboard/) · [Warp measure & improve docs](https://docs.warp.dev/factories/measure-and-improve/) · [How I AI: Inside Warp's software factory](https://www.chatprd.ai/how-i-ai/inside-warps-software-factory)

## Page map

Six pages in a top bar, with the repository at the left and search on `/` or Ctrl-K; every page works for one repo at a time.

| Page | Route | Answers |
| --- | --- | --- |
| **Briefing** | `/` | What needs me, what is happening, and what landed while I was away? Everything that needs a person can be dealt with here: answer a question, merge a change with its proof, retry or drop a stuck request, let a stranger's request start, adopt a practice, add a rule. |
| **Requests** | `/requests`, `/request?id=` | Where is each request? One request has its conversation (the whole page while it runs), its pull request (summary, proof, checks, diff with line comments, merge bar), its runs and its activity. |
| **Runs** | `/runs`, `/runs?id=` | What exactly did a run do, and what did it cost? Also the factory's workflow runs on GitHub Actions, with cancel and re-run. |
| **Guardrails** | `/guardrails` | Which rules could it add, which are installed, what did its self-review find, and which corrections did it learn from? |
| **Spend** | `/spend` | What does it spend against the budget and each share, and how often does its work merge without edits? |
| **Factory** | `/factory` | Settings, standing goals, workflows (run now, re-run, cancel), people, health and installation. |

The old addresses (`/dashboard`, `/live`, `/work`, `/improvement`, `/sessions`) move to the page that now holds what they showed.

A **New request** button sits at the top of every page; it opens a short form (kind, title, what you want, and the goal: what should be true when it is done) that creates a GitHub issue shaped like the repo's issue forms, labelled for hardening or tidying where that is the kind, which the factory picks up like any other request and acknowledges with a comment. On a factory that has done nothing yet, Home offers one suggested first request, written by setup from the repo into `.factory/first-request.json`.

## Dashboard page (metrics)

The metrics landing page for a chosen date range (7, 30 or 90 days), comparing each number with the previous period.

**Headline row** (one tile each, with the change vs. the previous period):

| Tile | Definition |
| --- | --- |
| Autonomy | Merged factory PRs that needed no human code push ÷ all merged PRs |
| Human interactions per PR | Comments, change requests and human commits on merged factory PRs ÷ those PRs. An approving review is the gate working as designed, so it is not counted. Counted when the PR merges and stored on the run, so the dashboard needs no extra API calls; absent means not measured, which is shown as such rather than as zero |
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
- **Stale lock files get their own state, not a run failure.** gh-aw's `check-for-updates` fails a role workflow's activation job when its compiled `.lock.yml` is below the minimum supported version or is blocked. That is a maintenance state, not a broken run: the bar shows "lock files need recompiling" with a button that starts the recompiler workflow (or, where the user declined the recompiler App, the command to run the skill's repair mode).
- Clicking a card opens its run detail.

## Runs and run detail

**Runs list:** every run, newest first, with pipeline, work item, actor (agent harness or human), outcome, duration and cost; filters for pipeline, outcome, actor, model and date. Runs for the same work item (retries, conflict resolution) group under it.

**Run detail** (`/run?id=`), top to bottom:

1. **Header:** work item title and source link, pipeline, outcome, PR link, total duration and cost.
2. **Timeline:** one row per step (triage, spec, builder attempts, gate attempts, verifier) on a time axis, colored by pass/fail, with duration and cost on each.
3. **Gate results:** each attempt with its failures (rule, file, line) and the fix that followed; coverage numbers; ratchet change.
4. **Evidence:** the verifier's screen recording plays in place (loaded from the media ref only when you press Play), with screenshots beneath it (kept 12 months by default); full videos and logs as links with their expiry date ("expired" once gone).
5. **Transcript:** the normalized transcript of each step, collapsible tool calls, searchable.
6. **Cost breakdown:** tokens in/out/cached and cost per step and model.
7. **Scores:** the scheduled review's scores for this run, once reviewed.
8. **Actions:** cancel (while running), re-run, give guidance (restarts with a comment).

## Home: waiting on you

Home is the review queue: everything that needs this user, oldest first, grouped by kind.

| Group | Item | Actions |
| --- | --- | --- |
| **PRs to approve** | Draft PRs in pipelines with auto-merge off, any PR the weakening check flagged, and runner upgrade PRs (with the release notes) | Open review · Approve · Request changes |
| **Hardened from corrections / Guardrail candidates** | Guardrails lists each hardening change with the correction that created it; Home shows pending candidates with Accept/Reject (sent through the intake workflow, since the browser can't write the data ref) | Accept · Reject |
| **Practices to approve** | Definition PRs from `/practice` comments: the practice a person declared, and the comment it came from | Approve · Reject |
| **Escalations** | Work the factory couldn't finish, with its best guess at the blocker | Give guidance · Take over · Close |
| **Questions** | The one question triage asked before starting, quoted from the issue, with how long it has waited. Questions never time out | Answer box (posts the comment as the signed-in person, which restarts the item) |
| **Guardrail candidates** | New candidates from local sessions or `bsf contribute-corrections` | Accept · Reject |
| **Outside requests** | Issues from untrusted authors, and issues created by an integration's bot (Linear, Sentry), waiting for `factory:accept` | Accept · Ignore |

**PR review view** (opened from Home or a run): the PR body's evidence first (screenshots, clips, before/after), then gate results, the spec, and only then a collapsed diff. Approve and Request changes sit at the top and bottom.

**Work items** (`/work`): every work item with source, pipeline, status, cost and links to its runs and PR; for each open item the chief of staff's decision and reason (or "moved by a person"), its goal and what it will be checked against, and a one-click **Change pipeline** while work has not started; a line showing how many routed requests a person moved; filters by status and source; duplicates shown linked to their original.

**Factory** (`/factory`) also has **Standing goals**: what to lean toward for a while, added with an optional lane and removed with one click. Both this and Change pipeline go through the factory's intake workflow, like candidate decisions, so only people with write access can use them.

**Sessions** (`/sessions`): captured local agent sessions with harness, author, branch, linked PR, and the corrections extracted from each. When capture is off (a public repo without the private data repo), the page says why and links to the setting.

## Guardrails

One page showing how strict the codebase is and how cleanup is going.

- **Summary row:** number of rules by base kind, rules still baselined, coverage floor, skips used vs. cap, candidates pending.
- **Rules table:** rule name, plain-language description, base kind, source (universal, codebase pattern, mined correction, hardening), date added, current violations, and the PR that added it. Clicking a rule shows its proof (bad example caught, good example passed) and the corrections it came from.
- **Cleanup progress:** for each baselined rule, a bar from the count at setup to zero, with the gardening PRs that brought it down.
- **Coverage:** total coverage over time against the floor, and coverage per feature folder (lowest first).
- **Candidates:** pending candidates with occurrences, sources, an example quote and the proposed fix; accept or reject in place.
- **Hardening history:** every hardening PR, newest first, with the problem class it eliminated.

## Improvement: scheduled reviews

Where the factory engineer sees what the scheduled review found.

- List of scheduled reviews: date, runs reviewed, pass rate per rubric, problems found and where each went (hardening).
- **Review page:** scores per criterion across runs; failure tags ranked by count; each problem with its example runs and the work item it filed.
- **Hardening runs that scored badly:** failures found in hardening runs are shown here for a person to look at. They never become new hardening work, so hardening cannot feed itself.
- **Scorer cards:** pass rate per rubric over time, so a drop is visible at a glance.

Benchmarks, the cost vs. quality chart and automatic definition changes are planned for v1.1.

## Factory settings and toggles

**A user never opens a definition file.** The Factory page has a control for every setting a person may change, and an **Ask the factory** box for anything else. Saving a setting is one step: the dashboard opens a pull request with the change and merges it with the signed-in person's own token, so every change is still a commit with their name on it, never a hidden setting.

The settings a person may change are a fixed list (`bsf` keeps it in `lib/settings.ts`; the dashboard carries a copy that a test keeps equal): the monthly budget, the three budget shares (which must add to 100), merge-by-itself for each of the three pipelines, cleanup PRs per night, and the hour the nightly cleanup starts. Everything else in the definition is not a setting a person changes here: models are the factory's own choice in v1.0, and limits, enforcement, the trusted list and the sandbox are changed only through a pull request a second trusted person approves.

| Section | Shows | Can change |
| --- | --- | --- |
| **Settings** | The nine settings above, grouped as Budget, Merge by itself and Nightly cleanup; each shows its help text and what it was | Change any of them, then Save; shows "waiting for the factory's check", then saved, or why it is still open as a pull request |
| **Autonomy** | Each pipeline's revert rate and scorer pass rate, as context for the merge-by-itself switches | Read-only; the switches are under Settings |
| **Who can start work** | Everyone with write access, and their role; outside requests wait for an accept on Home | Add or remove a person on GitHub's own access page (linked) |
| **Standing goals** | What the factory leans toward for a while | Add (with an optional lane) or remove |
| **Ask the factory** | A box for a change no control covers, in the person's own words | Files an issue labelled `factory:ask` |
| **Models** | The model for each role, with cost per run | Not user-facing in v1.0 (the factory's own choice) |
| **Roles and context** | Each role's prompt and the four context files, rendered, with the source id on each factory-added line | View only |
| **Enforcement** | Plan detected, branch protection on/off, audit mode, private data storage, session capture on/off and why | Turn on audit revert PRs |
| **Health** | Pinned runner version and latest release, any open upgrade PR, Dependabot entry present, both App installations (factory and recompiler), secrets present, schedules active, private data repo collaborators in sync, **lock files current** | Open the upgrade PR for review; start a recompile |

## Data access and auth

The browser talks to GitHub directly with the user's own access; no data passes through any maintainer server.

**Sign-in**

1. **Sign in with GitHub (the main way).** One button. The sign-in page asks for the repository (a link from setup already fills it in), sends the person to GitHub to approve the Software Factory app, and they land back signed in. It is a GitHub App, not an OAuth app: its token has no scopes, only what the app was given (the list in `lib/permissions.ts`) and only on repositories the app is installed on, and only what the person themselves can do there. If the app is not installed on the repository yet, the page says so, links to the install page and checks again without a second sign-in. The token lasts 8 hours and is renewed in the background with a refresh token (six months), kept for the tab or, if "remember on this device" is ticked, on the device. The flow uses `state` and PKCE, so a planted `?code=` is ignored and a leaked code is useless to anyone else.
2. **A token made from a link (the other way).** Shown under "Use a token instead", and the only way on a copy of the site that has no sign-in function (for example a static preview). It opens GitHub's own token form with the name, the 90-day lifetime and every permission already chosen; the person picks the repository, presses Generate token and pastes it back. One list in `lib/permissions.ts` drives this link, the GitHub App's registration link, the checks below and the error messages. Either way the session is checked before it is stored: each read permission is probed and any missing one is named ("missing permissions: Pull requests, Actions") instead of surfacing later as a 404. Write permissions cannot be probed without changing something, so a refused write names the permission it needed.

**The sign-in function.** GitHub's token exchange needs the app's client secret and GitHub does not answer cross-origin requests to it, so a static page cannot do it alone. A Cloudflare Pages Function on the dashboard's own address does (`functions/api/auth/[[route]].ts`, logic and tests in `worker/src/index.ts`). It stores nothing. Because it is the same origin as the page, there is no cross-origin access to allow and no list of origins to keep right, and the callback address is computed from the request, never taken from the caller. `GET /api/auth/config` says whether the button should exist, `/start` builds GitHub's address, `/exchange` and `/refresh` trade a code or a refresh token for a token, and the last two refuse any request whose `Origin` is not the site itself. GitHub's error descriptions are not relayed (they can echo the code) and every response is `no-store`.

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
| Change a setting (budget, shares, merge by itself, cleanup PRs and time) | Opens a pull request labelled `factory:settings` with the change (and, for the cleanup time, the one cron line of the cleanup workflow), waits for the `factory/policy` check, merges it as the user, and deletes the branch |
| Ask the factory | Creates an issue labelled `factory:ask` |
| Add or remove a standing goal, change a request's pipeline | Dispatches the intake workflow with a `kind` |
| Run gardening now, run a review | Dispatches the workflow (`workflow_dispatch`) |
| Cancel a run | Cancels the workflow run |

**Settings PRs from the dashboard:** GitHub does not let a person approve their own pull request, and the dashboard opens and merges the change as the signed-in person, so for this narrow case the author is the approver. The path policy counts a PR as the author's approval only when all of these hold: it is labelled `factory:settings`; it comes from this repository, from no pipeline; its author is a person (never a bot or an App) who actually holds write access; it changes nothing but the settings file and, at most, the one cron line of the cleanup workflow; and every key it moved is on the list above, set to a value the list accepts (shares adding to 100, a daily hour). Anything else a person changes in the definition, a second trusted person still approves. Agents cannot open such a PR: they never hold a person's token, and their pipelines may not change the definition.

The dashboard waits for the `factory/policy` check that ran after the label was added (a result from before the label is ignored), merges when it passes, and otherwise leaves the PR open and says why: the check failed, it has not finished, or GitHub wants a review or the merge queue. The token needs write access to contents and pull requests, and to workflows when the cleanup time changes; a missing permission is reported in words, not as a status code.

## Design direction

The Briefing, chosen from three sketches in `design/sketch/`. The page is written, not tiled: it answers its questions in sentences.

- **Two voices.** Schibsted Grotesk for the interface; Newsreader for everything the factory itself says (its questions, summaries, playbacks), so a person can tell the two apart at a glance. Both are bundled from npm.
- **One dark, wide thing.** Finished work waiting to merge is the only dark card on the page, in both themes, because it is the thing a person came to do.
- **Status carries the color.** One blue for what is yours to do, green for done, red for stuck; everything else is ink on paper.
- **The conversation is the page.** While a request is being talked through, the chat takes the page's full width, the factory on the left and the person on the right, with details in a drawer.
- **The frame is taught, not filed.** When the conversation works out the words for a request (`brainstorm.frame`), it appears as its own turn in the thread: what the request is, the top terms with where each came from and what it lets you ask for, neighbouring fields with where each stops applying, and what was not mentioned, ending on the next ordinary question. Nothing in it was looked up, and it says so; a credit is marked not yet checked. `frame.named` also shows beside the request's title. It is lighter than the playback, which is where the person agrees to the job.
- **Everything in place.** Merge, request changes, answer, retry, drop, accept, adopt, add a rule, change a setting: each is a button where the thing is, says what it did, and never sends the person to GitHub to press it.
- **Light, dark and phone,** following the system or the person's choice in the account menu. No inline styles: every look is a class in `styles/globals.css`.

## One shared site

The dashboard is published once, not per repository. It is a static export served from Cloudflare Pages on one domain; every person opens that address, signs in and picks their repository. Nothing is hosted in a user's repository, so a private repository on a free plan works, and a dashboard fix reaches everyone on the next push to the default branch.

**Cloudflare Pages settings** (Git integration with this repository, so Cloudflare builds it and no Cloudflare token is stored in a repository):

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | the repository root (leave blank) |
| Build command | `npm ci && npm -w @bsf/dashboard run build` |
| Build output directory | `dashboard/out` |
| Node version | 22 (the `.node-version` file at the root sets it) |

**Setting up "Sign in with GitHub".** Once per deployment, by the person who runs the site:

1. Open the registration link for your address: `cd dashboard && npx tsx scripts/app-link.ts https://your-domain` (add an organization name as a second argument to register it under an organization). GitHub's form opens with the name, callback address, permissions (the same list as the token form), no webhook and "public" already filled in; check them and press Create GitHub App.
2. On the app's page, generate a client secret, and note the **Client ID** and the app's **slug** (the last part of `github.com/apps/<slug>`). "Expire user authorization tokens" must stay on.
3. In the Pages project, under Settings → Variables and secrets (Production), add `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_SLUG` as plain values and `GITHUB_APP_CLIENT_SECRET` as a secret, then redeploy. Until all three are set the button does not appear and the token form is the only way in.

It costs nothing beyond the domain: static pages are free and unlimited, and the function runs only for a sign-in or a renewal, well inside the free plan's 100,000 requests a day (Pages Function requests share that quota).

**Links.** `?repo=owner/name` pre-fills the repository at sign-in; if a person is already signed in to another repository, the page offers to switch to it with the token they hold. `bsf dashboard-link --repo owner/name` prints that link for setup to hand over, using the published address `https://buildsoftwarefactory.com` in `runner/src/lib/dashboard-link.ts` (or `BSF_DASHBOARD_URL` for a copy someone hosts themselves), and says so plainly if no address is set. It refuses an address that is not `https://`, because a token is typed into the page.

**Headers.** `dashboard/public/_headers` sets a content security policy that lets the page connect only to itself and `api.github.com`, forbids framing, and sends no referrer. The browser then enforces what the code already does (the client refuses to send the token to any other host, and a test checks both). The page loads one web font from Google; the policy allows exactly that and nothing else.

**Demo mode.** The sign-in page has "Look around with a demo", and `?demo` opens it directly. It runs the same pages on a made-up factory through a stand-in for GitHub's API (`lib/demo.ts`): nothing is requested from GitHub, every write is refused with a sentence saying so, and the stored sign-in is a sentinel, not a credential.

**Empty states.** A repository with no factory is told how to get one (setup is done by Claude Code; the README has the steps). One with a factory and no runs is told what starts the first. Every page explains what it will show, and the unit tests plus `npm run e2e` (a real browser against a mocked GitHub API, which needs Playwright and Chromium) check that no page shows `undefined`, `NaN` or a raw status code on an empty factory.

## Static-export constraints

The dashboard is a Next.js app built with `output: 'export'` and served as static files from Cloudflare Pages, so it costs nothing to run at any number of users.

- **No server code:** no server components that fetch data, no API routes, no middleware, no server actions. All data fetching happens in the browser.
- **Routes known at build time only.** Pages for a specific item read the ID from the query string: `/run?id=`, `/review?pr=`, `/rule?id=`. The repository comes from `?repo=owner/name` at sign-in and is remembered per browser.
- **Client data layer:** one fetch wrapper that adds auth, ETags and rate-limit handling; a cache keyed by URL; polling hooks that stop when the tab is hidden.
- **Schema validation in the browser:** every file read from `factory-data` is validated against `/schema`; unknown major versions show an "upgrade your runner" notice instead of breaking the page.
- **Self-hostable:** the same build deploys to any static host, or runs locally with `bsf dashboard`. It serves the static export on the loopback interface only — the page holds a GitHub token in browser storage, and a dashboard reachable from the network would hand anyone on that network a page that acts as the person running it.
- **The only optional server piece** is the sign-in Worker, which is not wired into the sign-in page (see Sign-in).
