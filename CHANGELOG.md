# Changelog

Dates are the day the work landed on `main`. Each release lists the schema
versions the runner reads and writes, because that changelog is what a user
sees in their upgrade pull request.

## Unreleased

Schemas: reads `*/1`, writes `*/1`.

### Added

- **A shared dashboard.** One static site on one domain instead of a copy per repository: sign-in with a link that opens GitHub's token form already filled in, `?repo=owner/name` links, a demo mode on a made-up factory, a note on empty pages that says whether the repository has no factory or has one that has not run yet, and a content security policy so the page can only talk to itself and `api.github.com`. `bsf dashboard-link` prints the link for a repository.
- **Sign in with GitHub.** One button instead of making a token: the person approves the Software Factory GitHub App at GitHub and lands back signed in (state and PKCE, tokens renewed in the background, no scopes beyond what the app was given). If the app is not installed on the repository the page says so, links to the install page and checks again. It runs through a Pages Function on the dashboard's own address (`functions/api/auth`, logic in `worker/src`), so there is no separate Worker to deploy and no cross-origin access; the standalone Worker and its OAuth-app flow are gone. The token form stays under "Use a token instead" and is the only way on a copy of the site without the function. `dashboard/scripts/app-link.ts` prints the GitHub App's registration link, filled in from the same permission list.
- A token with a missing permission is named at sign-in, and a refused action says which permission it needed.
- `npm run e2e` in the dashboard runs the built site in a real browser against a mocked GitHub API.

### Removed

- **The half-built self-improvement machinery.** `bsf benchmark`, the benchmark task and result schemas, the benchmark provider, the review's route to a definition change and its benchmark gate, the cost-vs-quality chart and the benchmark parts of the dashboard are gone, and `rubrics/definition.yaml` with them: `/practice` runs are no longer scored, and the review skips them. Automatic, measured changes to the factory's own definition are planned for v1.1 and will be redesigned. Kept: `/practice` (manual improvement through the `definition` pipeline), the scorers, the review and its record, and the `review_and_benchmarks` budget key (now labelled "Reviews and practices"). No installed factory exists yet, so nothing needs migrating.

### Changed

- **The review's timing.** The first review is never skipped for too few runs: it is due 3 days after the factory's first graded run, if at least one run exists. Later reviews are skipped under 5 runs (was 10). The 50-run early trigger applies to both.
- **Hardening cannot feed itself.** Every review problem routes to hardening, except failures found in hardening runs: those are recorded as `unrouted` in the review record (additive, optional), shown on the Improvement page, and file no new work.

### Fixed

- The dashboard's GitHub client called the browser's `fetch` as a method of itself, which browsers reject with "Illegal invocation", so a real sign-in could not have worked. The unit tests used a stand-in fetch and never saw it.

- No YAML for users. The Factory page now has a control for every setting a person may change (monthly budget, the three shares, merge-by-itself for each pipeline, cleanup PRs per night, cleanup hour), a list of who can start work, and an Ask the factory box. Saving a setting is one step: the dashboard opens a pull request labelled `factory:settings`, waits for `factory/policy`, and merges it as the signed-in person. The policy check counts that author as the approver only when they hold write access, the PR touches nothing but the settings file and the cleanup workflow's cron line, and every key it moved is on the list with a value the list accepts; anything else still needs a second approval. `bsf settings` shows and changes the same settings for the setup skill, keeping the file's comments. An issue labelled `factory:ask` is kept for the setup skill, with no work item or run. User-facing messages no longer name a file to edit, and a test fails if one does. Also fixed: the dashboard's polling hook re-requested on every render.
- Chief of staff. Each accepted request from a person is routed by one tool-less model call (`models.chief_of_staff`, default `claude-haiku-5-5`, charged to the budget) to product work, hardening or gardening, with a specific goal and a success check the verifier can test; one question at most when it is genuinely unclear. Trust stays deterministic, the request is treated as data, and a failure, a missing `ANTHROPIC_API_KEY` or a paused budget falls back to the old table. The decision and reason are on the work item (`success_check`, `routing`, additive and optional) and in the acknowledgement. People can move a request in one click on the dashboard (recorded, with a mis-route tile), and set standing goals on the Factory page or with `/focus` in a comment (`standing-goals.json`); the spec, gardener and hardener read them as tie-breakers. Role prompts are not rewritten and no role's frontmatter changed.
- Easier kickoff. Four issue forms (Feature, Bug, Harden this, Tidy this) install under `.github/ISSUE_TEMPLATE/`; the harden and tidy forms apply `factory:harden` and `factory:tidy`, and a tidy request goes to gardening. Each form and the dashboard's new **New request** button (on every page) ask for a goal, kept on the work item as `goal` (additive, optional) and used by the spec as the success check. Intake comments on an issue as soon as it has read it: the kind of work, the goal, and how an untrusted author's request gets started. Home has an answer box for the one question triage asks before a run, and shows how long it has waited; a question never times out or escalates. On an empty factory Home offers a first request from `.factory/first-request.json`, which setup writes and phase 7 smoke-tests.
- Automatic hardening from every correction. A trusted person's PR review comment, change request or push to a factory branch, or a correction in a local Claude Code session, becomes a hardening work item at once (no threshold, no label), linked to the corrected run (`human_corrections`, additive). Duplicates fold; comments on hardening or definition PRs are revisions, not corrections. The hardener now chooses among a static rule, a stronger verification requirement, and a refactor, equally, and no longer writes prose context. `bsf local-hook --install` adds the local capture hook to personal settings. Guardrails shows each change with its correction; Home shows candidates with Accept/Reject. The scheduled review's definition route is off until v1.1; `/practice` is unchanged.
- Videos on PRs by default. The verifier records one screen session with a chapter per acceptance check; the runner re-encodes it to a small MP4, makes an animated GIF preview (sped up, not cut, when long), moves the original out of the media ref, and enforces per-clip and per-PR size caps. GitHub cannot play repo-hosted video, so the PR shows the preview linking to the file and the dashboard plays the real one. The spec declares `ui_change` (additive, optional); product work that touches the UI fails the `factory/pr-report` check without a video.
- `bsf doctor` — what is wrong with an installed factory, changing nothing.
  The diagnosis the setup skill's repair mode does before it touches anything.
- `bsf contribute-corrections` — a teammate adds the corrections from their own
  machine. Two steps on purpose: the first writes a file and submits nothing,
  so they can read and prune what would be shared before it goes.
- `bsf consistency` — cross-artifact checks: environment variables against
  `.env.example` in both directions, README commands against the manifest's
  scripts, declared dependencies against the lockfile.
- `bsf migrate` and `bsf schema-surface` — the schema freeze. An additive
  change passes; a breaking one fails and asks for a major bump with a
  migration.
- `bsf dashboard` — serves the dashboard from your own machine, loopback only.
- Data-flow rules (Semgrep taint) in the TypeScript and Python packs.
- Rust, C#, Ruby and polyglot-monorepo fixtures; Rust, C# and Ruby rule packs.
- Human interactions per PR, on the dashboard and in the rollup.
- The Improvement page: review results, scorer pass rates, and cost against
  quality for every configuration benchmarked.
- The repository's own CI: typecheck, lint, tests, the schema surface, and the
  gates run for real against the fixtures.

### Fixed

- Every GitHub API request with a body was sending an empty one.
  `promisify(execFile)` ignores an `input` option, so `gh api --input -` waited
  on a stdin nobody wrote. `reportCheck`, which is how every gate tells GitHub
  its verdict, had never worked.
- A baseline entry was read as a per-file map in two places, so the gardener
  filed items asking an agent to clean files called `count` and `by_file`, and
  never skipped a retired rule.
- The merge queue had its own review mapper writing the wrong field names,
  which silently disabled the stale-approval check where merging is decided.
- Three bare `require()` calls in ESM modules, each of which threw only on the
  code path that reached it.
