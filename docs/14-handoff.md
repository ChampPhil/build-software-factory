# Handoff: Build Software Factory, v1.0 to distribution

Nov 22, 2026. Written by the agent that ran the v1.0 push, for a new agent
starting clean with GitHub and repo access.

## 1. The goal

Philip Valcin (a high-school student, sole developer) is building **Build
Software Factory**: an agent skill that other people install to turn their
existing codebase into an automated "software factory". The factory takes
issues, specs and builds them, verifies the result in a sandbox that mirrors
the app, and opens PRs, all inside the user's own GitHub repo with a hard
spending cap.

**The goal now: get it in front of as many people as possible.** The remaining
work is the website, getting the repo public, and distribution. The factory
itself is judged ready (section 4). Do not start new factory features unless a
distribution blocker demands it.

Philip built this for *anyone* to apply to *their own* system. He is not
building it for personal use. When something fails on his test app, the fix
goes in the factory, never in the test app. He has been burned by "almost done"
repeatedly: report what you actually saw, plainly, and do not call things done
that have not run.

## 2. Standing rules (from Philip, all still in force)

- The factory runs on **Claude Code only**, with a **hard budget cap that can
  never be exceeded** (gh-aw `max-ai-credits`, enforced by the AWF proxy, is
  only proven for Claude Code).
- The repo `ChampPhil/build-software-factory` **stays private** until Philip
  decides otherwise. Going public is a decision for him.
- There is **no from-scratch-docs-only install**.
- Fixtures live in `bsf-fixtures/*` (nine repos). `ChampPhil/trinsports` is the
  real sign-in test app (a Next.js school-sports site, Auth.js + Google, Neon
  Postgres, Google Sheets, Resend).
- **Merging or approving protected-path PRs is Philip's action.** Upgrades to a
  repo's `.factory/` and the workflows need his merge. Never route around that.
- Never ask Philip for a password or credential in chat. No owner credentials
  in the sandbox. Secrets live only in env vars.
- Do **not** push to `refs/factory/data` by hand. The session proxy blocks it
  and you must not work around it. Use workflows.
- Philip is on **Windows PowerShell**. Give PowerShell-compatible commands.
- He is blunt and swears when frustrated. Answer directly, lead with the
  answer, no padding, no recaps of effort.
- Commit messages end with the attribution lines your session gives you. PR
  bodies end with "Generated with Claude Code" and the session URL.

## 3. Repos and where things are

| Repo | What it is |
| --- | --- |
| `ChampPhil/build-software-factory` | The skill, runner, templates, schemas, docs. HEAD at handoff: the latest commit on `main` (code state `d03cd55` plus this doc). |
| `ChampPhil/trinsports` | The real test app with the factory installed. |
| `bsf-fixtures/{ts-webapp,py-api,js-legacy,java-service,csharp-api,go-cli,rust-lib,ruby-app,polyglot-monorepo}` | Nine fixture repos for setup tests. |

Inside `build-software-factory`:

- `runner/` TypeScript runner (`bsf` CLI). `runner/src/cli.ts`, `runner/src/commands/*`. Tests in `runner/test` (1,238 pass).
- `skill/` the installable skill. `skill/runner` is the **vendored bundle** and must match source (CI checks). After changing runner source: `cd runner && npm run bundle && node scripts/host-variants.mjs`, then commit the result.
- `skill/scripts/install-factory.mjs` copies the factory into a repo (`--into PATH`). This is how an **upgrade PR** to a target repo is made: branch from its main, run the installer, commit, push, open a PR, Philip merges.
- `skill/references/phase-2-sandbox.md` the sandbox reference (up to date).
- `templates/workflows/*.yml|*.md` the factory's workflows and role prompts (gh-aw agentic `.md` compile to `.lock.yml`).
- `schema/` JSON schemas. `schema/SURFACE.json` is the freeze file: accepts additive changes only. Refreeze with the `schema-surface --freeze` script after an intended change.
- `docs/` 01-14. Start with `01-overview.md`, `07-architecture.md`, `12-acceptance-v1.0.md`, `13-security-review.md`.
- The claude.ai Project "Software Factory" holds Philip's original idea documents (PDFs) and two reference transcripts.

Pinned: gh-aw **v1.3.1**. Playwright CLI is `@playwright/cli`. Data lives on the
git ref `refs/factory/data` in each target repo (budget, ledger, runs, work
items, sandbox reports).

## 4. State at handoff

**Judged ready for distribution** on the bar Philip and I agreed: one app with
sign-in gets a PR the factory itself verified, with nobody stepping in.

Evidence (all in `docs/12-acceptance-v1.0.md`):

- Setup completed on all nine fixtures; setup PRs merged.
- Product PRs from the factory merged on six fixtures; one issue-to-PR run
  with every gate green on go-cli.
- The hard budget cap held throughout.
- **Sign-in app, live on trinsports:** the sandbox repaired itself, the factory
  auto-merged its own sandbox fix (#41), the stuck streak PR (#40) was updated
  and verified in the repaired sandbox, and `factory/gates` passed ("Every
  planned gate passed"; static and policy green; coverage and tests neutral).

Acceptance table: criteria 1, 2, 3, 4, 5 are partly or logic-proven; 6 and 7
met; 8 deferred until the repo is public; 9 partly (see below). Details and
honest verdict wording are in the doc.

## 5. What this last stretch changed (live sign-in work)

A sandbox that renders the app is not enough for apps with sign-in, databases
and outside services. Built:

- Sandbox manifest `sandbox/1` gained `dependencies[]` (each with a stand-in
  tier `test_mode|session|service|stub|inert` and a **probe**: a request to the
  running app that only works if the stand-in works) and `sign_in` (a command
  that mints a session for a throwaway test user; agents' browsers can reach
  only the app, never an identity provider, so the session is handed over as
  `session.json`).
- A trial round counts as met only if the tier is reached and every probe
  passes (`trialMet`).
- **Self-repair loop.** A role that cannot do its job files a sandbox report.
  The factory starts an amendment (one at a time, up to 2 attempts per need,
  then one escalation issue). `bsf sandbox land` auto-merges an amendment that
  changes only `.factory/sandbox/`, adds no host or secret, does not lower the
  tier, and proves at least what main did, with policy `sandbox_repairs:
  automatic`. Then stuck PRs are verified again.
- **Budget fixes.** Concurrent writers on `refs/factory/data` dropped settle
  records (GitHub's non-forced PATCH let a diverged update through). Each write
  is now verified after landing and redone if lost; ended steps settle at their
  measured cost; a repair waits for room in the budget.

Bugs the live runs found and the fixes (all in the factory, none in trinsports):

1. Trial copied a repair's new stubs *into* the existing folder
   (`stubs/stubs/`). Now replaced. (`factory-setup-trial.yml`)
2. An over-long line in the setup agent's PR write-up (limit 200 chars) killed
   a working repair. Now cut; an unusable write-up no longer blocks. (`readReportFile`)
3. Re-verifying a stuck PR by adding a label as the factory's App is refused at
   the verifier's PR checkout (gh-aw trusts a bot on opened/synchronize/
   ready_for_review/reopened, not labeled). Now land updates the branch from
   main (`PUT pulls/N/update-branch`), falling back to the label.
4. A change the sandbox could not judge was rebuilt up to three times on the
   same broken sandbox. Now `finishRun` returns `wait_sandbox`, keeps it in
   review, no spend, until the repair lands.

## 6. What is NOT done, or not proven

Be straight with Philip about these.

1. ~~Trinsports PR #40 stays a draft with stale labels~~ **Fixed; no work
   needed.** A held or escalated change whose `factory/gates` verdict passes
   is now cleared automatically (`clearHeldChange` in
   `runner/src/commands/run-lifecycle.ts`, called from `bsf gates record`):
   marked ready, `factory:escalated` and `factory:in-progress` removed,
   `factory:cleared` added, ledger back to in review. It never fails the
   gates, and the `record` job in `factory-gates.yml` now has
   `pull-requests: write` and `contents: write` for it. Unit tests cover it.
   Trinsports #40 itself was merged by Philip.
2. **Resend has no probe** in trinsports' sandbox (email only sends from the
   ping endpoint), so that dependency shows as not proven. Acceptable, but a
   real sandbox gap.
3. ~~`factory-audit` fails on every push to main~~ **Fixed; no work
   needed.** Cause: the audit looked for `factory/gates` and `factory/policy`
   on the merge commit, but they report on the pull request's head. `bsf audit`
   now finds the merged PR through `commits/{sha}/pulls` and checks the gates
   on its head; a push with no merged PR and no merge commit is still a
   `direct_push`. Five tests in `runner/test/audit.test.ts`. A repo gets the
   fix through the factory's normal upgrade PR (`install-factory.mjs --into`),
   which Philip merges. Trinsports' upgrade PR #43 carrying both fixes was
   merged by Philip, so trinsports has them; neither has yet run live there
   (the first push to main and the first held PR after #43 are the live test).
4. **Criterion 8** (schema-major upgrade arrives as a Dependabot PR, then
   migrates): deferred, Dependabot cannot watch a private repo's releases. Set
   up when the repo goes public. Machinery is built (`schema/SURFACE.json`,
   `bsf migrate`).
5. **Criteria 2 and 5** (a degraded context file is fixed and shown to improve;
   the cost-vs-quality chart shows three configurations) are logic-proven only.
   No benchmark was paid for. Criterion 1 as written needs 50 runs; there are
   a few dozen across fixtures.
6. **First-attempt counting:** eight older trinsports sandbox reports have
   `attempts: 2` and will not be retried (they were consumed by failures that
   are now fixed). New reports start fresh. Not harmful, but do not be
   surprised by them.
7. **Cleanup:** trinsports PR #26 (superseded upgrade) is open; trinsports #29
   and #30 and several `[aw]` failure issues (#10, #14, #19, #25, #28, #32) are
   open leftovers from the failed runs. On `bsf-fixtures/ts-webapp`, PRs #53
   and #55 are duplicates from the hardening bug (since fixed); one should be
   closed.
8. **Cost reality.** Measured on `ChampPhil/bakesale-test` (Nov 25, private
   Free repo, seven hours): setup $4.58 over four rounds and 158 Actions
   minutes, not the ~$12 once estimated; about $1-2 a draft PR; 1,292 Actions
   minutes in all, which is the limit that binds on Free. The README's "What
   it costs" now carries these numbers. The dashboard's Spend page and the run
   files under-report against `budget.json` (see the live-test findings).
9. **Not done at all:** the website, distribution, public launch, a demo/video,
   onboarding docs for strangers, a feedback channel, a security-review
   refresh for the new sign-in session minting (see `13-security-review.md`).
   The sign-in minting path writes sessions into a throwaway test database
   only; re-read it with a security eye before telling the world.

## 7. Suggested order of work

1. Read `docs/01-overview.md`, `07-architecture.md`, `12-acceptance-v1.0.md`,
   `13-security-review.md`.
2. Run the test suite and confirm CI is green (`cd runner && npm test`;
   needs Actions billing for CI). Confirm GitHub Actions billing is active; an
   account-wide billing block earlier made every job fail to start with "recent
   account payments have failed or your spending limit needs to be increased".
3. (Items 1 and 3 of section 6, the auto-clear and the audit failure, are
   fixed; do not reopen them unless a run shows otherwise.)
4. Cleanup list (item 7): Philip does not care about it; skip unless asked.
5. Do a **cold-start install test**: follow the README quickstart exactly as a
   stranger would, on a fresh repo that is not one of the nine fixtures, and
   record every point of confusion. This is the most valuable pre-launch test
   and has not been done.
6. Security re-read of the sign-in minting and the public attack surface (issue
   intake from untrusted users, prompt injection, secrets) before going public.
7. With Philip: decide when the repo goes public; then set up Dependabot
   (criterion 8), a licence check, issue templates, a short demo, and the
   site.
8. Site, then distribution. Philip wants maximum reach. Ask him which
   audiences first (solo developers, small teams, students), what the pitch is,
   and what he is willing to spend time on.

## 8. Environment notes for the agent

- GitHub **GraphQL is not available** from Claude Code sessions. Use REST
  (`gh api repos/...`). `gh pr view` fails for that reason; use
  `gh api repos/OWNER/REPO/pulls/N`.
- Writing git refs through the API is blocked by the session proxy.
- A permission classifier previously denied disabling workflows, cancelling
  runs on trinsports (Philip does those) and force-pushing a PR branch. Open a
  new PR instead of force-pushing.
- Actions job logs: `gh api repos/OWNER/REPO/actions/jobs/ID/logs`. Artifact
  zip downloads are blocked by the proxy. A job that "was not started" shows
  its reason in `check-runs/ID/annotations`.
- Triggering: `gh api -X POST repos/OWNER/REPO/actions/workflows/factory-rollup.yml/dispatches -f ref=main` runs the rollup, which starts queued work and any waiting sandbox repair (it reports "no report waiting" when nothing is eligible).
- Handing an escalated PR back: comment `/retry` on it.
- Budget gate: `bsf` refuses a step whose maximum cost does not fit the
  remaining monthly budget; the message names the largest step and what is
  left.
- Tests are slow (~3.5 min full suite). Run the file you changed first.

## 9. People and communication

Philip Valcin, rising junior at Trinity School NYC, solo founder of EjentoAI
LLC (AgentHub, being retired). TrinSports is a separate personal project. Keep
updates short, put the answer first, say plainly what ran live and what only
passed tests, and do not describe effort. If something is blocked on him
(a merge, a billing setting), say exactly what and where.
