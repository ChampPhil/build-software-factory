# Build Software Factory — Build Plan & Acceptance Criteria

Nov 18, 2026 · @Philip

Build Software Factory ships in three releases; each ships only when its acceptance criteria pass on the fixture repos and on Philip's old repo. All three are built and tested in a single day with Claude: Claude writes the code, runs the tests and judges the evidence; Philip does only the steps that need him (creating the App, adding the API key, running setup on his machine).

## Milestones at a glance

| Release | What it adds | Ships when |
| --- | --- | --- |
| **v0.1: the working loop** | Issues become verified, merged PRs; Claude Code; TypeScript, JavaScript, Python; revert rate tracked | v0.1 acceptance criteria pass |
| **v0.2: the garden keeps itself** | Gardening, hardening, conflict resolution, four more harnesses, Go and Java, private data repo | v0.2 acceptance criteria pass on fixtures and Philip's old repo |
| **v1.0: the factory improves itself** | Scheduled review, benchmarks, all eight languages, frozen schema 1.0 | v1.0 acceptance criteria pass |

Each release is usable on its own: v0.1 already turns issues into verified, merged PRs; v0.2 keeps the codebase clean without help; v1.0 makes the factory better over time.

## v0.1: the working loop

The smallest version where a real repo gets a factory that turns issues into verified, merged PRs.

**First: a gh-aw spike.** Before the rest of v0.1, port the product pipeline's builder and verifier to gh-aw workflows on a fixture and settle what the design depends on:
- a custom engine runs Cursor CLI, Kilo Code and Hermes Agent headlessly;
- safe outputs (`create-pull-request`, `push-to-pull-request-branch`) can use the factory App's token, so their pushes trigger the gates;
- `factory-run` can dispatch a role workflow and read its results, and the verifier's job never sees the builder's transcript;
- pre-agent steps can start the repo's devcontainer and sidecar services, and a post-step can run memex;
- how a gh-aw upgrade reaches a user's compiled `.lock.yml` files without a local recompile.

Any item that fails falls back to the earlier design for that part only (the runner runs the agent in its own sandbox with no write token and pushes on its behalf), and the docs are updated to say so.

**Scope**

- **Skill:** all seven phases for one harness (Claude Code, run as a gh-aw engine with usage read by memex, so the other four drop into the same path) and three languages (TypeScript, JavaScript, Python). Correction mining from Claude Code sessions, PR review comments, reverts and prose rules.
- **Runner:** `intake` (issues and comments, work-item files, duplicate shortlist), `run` (product work: dispatching the gh-aw role workflows, live status refs, next-item dispatch), `policy` (the `factory/policy` check from main's workflow: path rules, test-edit check, approvals), `gates` (static rules, per-file ratchet, weakening check, tests or the repo's own test check, diff and total coverage, runtime verification; deterministic gates only on human PRs), `merge-queue` (native merge queue where the repo qualifies, event-driven fallback queue elsewhere), `rollup` (end-of-workflow step plus daily sweep), `sync-settings` (adds checks, never removes rules). Workflows pinned to a runner commit SHA, with Dependabot configured to open upgrade PRs.
- **Rule packs:** text and regex, structured-data schema, syntax tree, canonical form, types and dependency graph, configured on existing tools (each linter with its native baseline, Semgrep, dependency-cruiser, diff-cover, gitleaks).
- **Security:** per-job down-scoped App tokens (`actions/create-github-app-token`); agents in gh-aw's read-only sandbox, writing only through safe outputs after threat detection, behind gh-aw's firewall (model API and package registries only); untrusted text stripped from prompts.
- **GitHub App** creation through the manifest flow (Create, then Install); trust check at intake, with integration-bot issues treated as outside requests.
- **Dashboard:** Home, Dashboard (autonomy, cycle time, cost per PR, spend per share, revert rate), Live (from live status refs), Runs and run detail, Factory (toggles, models, budget shares). Fine-grained-token sign-in.

**Acceptance criteria**

- [ ] On each of the three v0.1 fixture repos, the skill completes setup with only the user actions listed in the Setup Skill Spec.
- [ ] A trusted user's issue produces a draft PR with screenshots from runtime verification, without human help, on all three fixtures.
- [ ] An issue from an untrusted account starts nothing until `factory:accept` is added.
- [ ] A PR that edits `.factory/definition/` from the product pipeline fails the `factory/policy` check.
- [ ] A fork PR that edits `factory-gates.yml` to always pass still fails `factory/policy` and can't merge without a trusted human's approval.
- [ ] Ten issues opened within one minute each become a work item; none is lost.
- [ ] On a fixture whose own CI runs `on: push`, a full factory run (data, media and live-status writes) starts none of that CI's runs.
- [ ] A human PR that's behind main can't merge until it's updated and re-checked.
- [ ] A cancelled run doesn't stall the queue: the next rollup dispatches the next queued item.
- [ ] A PR that raises a baseline or lowers the coverage floor fails the weakening check.
- [ ] While baselines remain, a product PR that adds no violations passes the ratchet; one that fixes a violation in one file and adds one in another fails.
- [ ] A factory PR that edits an existing test not listed in its spec fails the `factory/policy` check.
- [ ] A human PR runs only the deterministic gates and spends nothing on models; adding `factory:verify` runs agent verification on it.
- [ ] A draft PR's gates run once per commit: opening the PR re-runs nothing, and an approval registers without re-running the gates.
- [ ] Inside the sandbox, the agent has no write token, can't reach any host outside gh-aw's firewall allowlist, and a safe output carrying a planted secret or prompt injection is blocked by threat detection.
- [ ] An idle factory with no work uses under 15 Actions minutes a day.
- [ ] A new runner release produces an upgrade PR on each fixture without anyone acting; it changes only the runner pin, runs the deterministic gates, shows on Home, and never merges without a trusted human's approval.
- [ ] The Live view shows the current step, gate attempt and cost so far of a running work item, refreshed within 10 seconds of each step change.
- [ ] Two approved PRs that each pass alone but break the build together never both land: the queue catches the second, on a fixture using GitHub's native merge queue and on one using the fallback queue.
- [ ] Every run produces a valid run file; the dashboard shows it within 60 seconds of the run ending.
- [ ] Cost per run is reported to within 5% of the provider's billed usage on a 10-run sample.
- [ ] Turning on product-work auto-merge in the dashboard opens a definition PR that merges through the queue.
- [ ] The factory is set up on Philip's old repo with the skill, and a real issue there becomes a verified draft PR without help.

## v0.2: the garden keeps itself

Adds the two codebase pipelines, conflict handling, the free-private fallback and four more harnesses.

**Scope**

- **Pipelines:** gardening (nightly, up to 5 PRs) and hardening (from recurring or flagged corrections, repeated failures and gardening hand-offs), plus conflict resolution.
- **Definition flow, minimal:** a context line from a human correction opens a definition PR directly (no benchmark).
- **Tests:** mutation testing on changed lines with each language's existing tool (StrykerJS, Stryker.NET, cargo-mutants, Infection and the equivalents for the rest).
- **Rule packs:** call graph, control flow and clone detection added.
- **Harnesses:** Cursor CLI, Kilo Code, pi and Hermes Agent adapters (each a gh-aw engine, built-in or custom, plus a memex source), with local session hooks and correction mining for all five. Hooks ask each developer once before capturing anything.
- **Data:** private data repo option, so public repos can store session transcripts somewhere non-public.
- **Languages:** Go and Java rule packs.
- **Runner:** `garden`, `conflicts`, `audit`, triage-based duplicate handling and follow-ups, budget shares, CI-failure-on-main trigger, monthly media squash.
- **Dashboard:** Guardrails, Work items, Sessions; Live gains the merge queue strip and escalations lane; worker-based GitHub sign-in.
- **Trigger sources:** documented Slack (GitHub app) and Linear (Issues sync) setup, verified end to end, including the one-click accept for integration-bot issues.

**Acceptance criteria**

- [ ] On the messy-legacy fixture, nightly gardening brings every baseline to zero without any human code changes, and each PR lowers its rule's count and raises no count in any file.
- [ ] A correction a human makes on a factory PR three times becomes a hardening PR whose rule catches the original example.
- [ ] Gardening never opens a PR for a violation an open PR already fixes.
- [ ] A conflict between two factory PRs is resolved and re-cleared without human help when the intents don't contradict, and escalated with both specs when they do.
- [ ] On a free private repo, a direct push to main that skips the gates appears on the dashboard within 5 minutes.
- [ ] A reworded duplicate of an open issue is linked to the original by triage and produces no PR; a "still broken" report about merged work becomes a linked high-priority follow-up.
- [ ] When gardening's budget share is used, gardening pauses while product work continues, up to 110% of the total budget.
- [ ] On a private Free-plan fixture, gardening pauses before the month's included Actions minutes run out.
- [ ] A request posted in Slack with `/github open` produces a draft PR; an issue created by Linear's bot produces one after a one-click accept on Home.
- [ ] A correction whose fix is a context line arrives as a definition PR without a benchmark run.
- [ ] Mutation testing fails a PR whose new tests make no meaningful assertions.
- [ ] The `factory-media` ref stays under its size budget after a monthly squash.
- [ ] Each of the five adapters passes the conformance suite, including cost reporting.
- [ ] On a public repo with its data in the same repo, no session transcript is ever pushed; with the private data repo, sessions from a developer who hasn't opted in are never captured, and a teammate who has opted in can push to it without manual setup.

## v1.0: the factory improves itself

The full vision: self-improvement, benchmarks, every supported language, and a stable, documented schema.

**Scope**

- **Self-improvement:** instrumentation complete; the scheduled review with scorers and rubrics, both run on promptfoo; routing to hardening or definition changes; benchmark tasks built from completed work, including corrected and escalated runs; the benchmark-gated definition PR with repeated runs and noise checks.
- **Languages:** Rust, C# and Ruby rule packs (all eight supported).
- **Rule packs:** data flow and cross-artifact consistency added.
- **Data:** `bsf migrate`; schema 1.0 frozen and published.
- **Dashboard:** Improvement page (reviews, scorer cards, cost vs. quality chart, comparisons), human interactions per PR, mobile layouts for Home, Live and PR review, self-host command.
- **Skill:** update mode (re-mine, repair) and `bsf contribute-corrections` for teammates.

**Acceptance criteria**

- [ ] A scheduled review on a factory with 50+ runs produces a report where every problem is routed to hardening or a definition change.
- [ ] A deliberately degraded context file (a wrong runbook step) is caught by the review, fixed by a definition PR, and that PR shows the failure tasks improving and an overall gain larger than the run-to-run spread over 3 repeats.
- [ ] A definition change that lowers the benchmark score or raises cost by more than 20% is not proposed.
- [ ] The benchmark set includes tasks from corrected and escalated runs, graded against the human's fix.
- [ ] The cost vs. quality chart shows at least three model configurations for product work, with the current one marked.
- [ ] Setup completes on every fixture repo, covering all eight languages and the monorepo.
- [ ] Re-running the skill on an installed factory changes nothing unless the user picks re-mine or repair.
- [ ] A runner upgrade that bumps a schema major arrives as a Dependabot PR, is followed after merge by a definition PR migrating the config, and the dashboard reads both old and new files.
- [ ] On Philip's old repo, product work, gardening and hardening have each merged at least one PR, every one passes the gates on main, and none needed reverting.

## Test repos

Small fixture repos in `/fixtures` cover every path setup can take; each is reset and set up from scratch in CI on every runner release.

| Fixture | What it tests | Milestone |
| --- | --- | --- |
| `ts-webapp` — Next.js app with tests | The happy path: clean code, good tests, runtime verification in a browser | v0.1 |
| `py-api` — FastAPI service + Postgres | Sidecar services in the sandbox, API-level runtime verification | v0.1 |
| `js-legacy` — messy JS app, no tests | No-tests path, large baselines, cleanup through gardening | v0.1 setup, v0.2 cleanup |
| `go-cli` — command-line tool | Non-web runtime verification (run the binary, check output) | v0.2 |
| `java-service` — Spring Boot app | Go/Java rule packs, slower builds within time budgets | v0.2 |
| `polyglot-monorepo` — TS frontend + Python backend | One factory, per-app sections in feature map and runbook | v1.0 |
| `rust-lib`, `csharp-api`, `ruby-app` | The remaining rule packs | v1.0 |
| `private-free` — copy of `ts-webapp` in a free private repo | Audit fallback without branch protection | v0.2 |

Beyond fixtures, each milestone is also tried on Philip's old repo before release. Scheduled steps (nightly gardening, the review) are started by hand with `workflow_dispatch` so the whole loop can be exercised the same day.

## Release checklist

Run for every milestone release.

- [ ] All acceptance criteria for the milestone pass on CI fixtures and Philip's old repo
- [ ] Runner Action published and tagged (`@v0.1`, `@v0.2`, `@v1`), with the release's commit SHA (what workflows pin) and the schema versions it reads and writes listed in the release notes, since that changelog is what users see in their upgrade PR
- [ ] Dashboard deployed to Cloudflare Pages; sign-in Worker deployed (from v0.2)
- [ ] README: what it is in two sentences, three-step quickstart, a captioned demo video (no voiceover), enforcement by GitHub plan, what it's built on (gh-aw, memex and the tools in the Architecture doc's reuse table), and how it differs from prior art (gh-aw on its own, addyosmani/factory and other software factories)
- [ ] Cost disclosure: what the factory spends from the user's model API key and Actions minutes, with typical monthly ranges from the fixtures
- [ ] Security review: trust check (including integration-bot issues), untrusted-text stripping, redaction, App permissions (no `workflows`), the `pull_request_target` policy check never running PR code, per-job token scopes, no token in the sandbox and its network allowlist, policy loaded from main, fork behavior
- [ ] `LICENSE` (MIT), `CONTRIBUTING.md` (how to add an adapter or rule pack), changelog
- [ ] Docs updated: these specs, the Technical Walkthrough and the public guides
- [ ] Launch post
