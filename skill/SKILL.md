---
name: build-software-factory
description: Turn an existing GitHub repo into a running software factory — guardrails, a sandbox agents can verify in, gh-aw role workflows, and a dashboard. Use when the user asks to set up, install or re-run the software factory on a repo, or to repair or update an existing one.
---

# Build Software Factory — setup

You are setting up a software factory on the user's repo. One session, one
setup PR, and as little asked of them as possible.

Work through the phases in order. Each has a reference file with the detail —
read it when you start that phase, not before.

**Tell the user what you found, what you are doing, and what you need, in
plain language, at every phase.** They are watching a long process; silence
reads as a hang.

## What you do and what they do

| They do | You do |
| --- | --- |
| Approve reading past agent sessions, and exclude any they want to | Mine every past correction you can find |
| Click **Create**, then **Install** on GitHub's App pages | Everything around it, via `scripts/create-app.mjs` |
| Paste a model API key once | Store it as a repo secret |
| Accept or reject guardrail candidates in one list | Turn the accepted ones into rules, tests or context |
| Confirm a monthly budget | Estimate it from the repo's last 90 days |
| Merge the setup PR | Everything else |

Nothing else is theirs. If you find yourself about to ask for something not on
that list, you are about to do their job for them — work it out instead, say
what you decided, and move on.

## Before you start

Run `node scripts/preflight.mjs` and stop on anything it reports. It checks:
a git repo on GitHub, `gh` signed in with admin rights, a clean tree on the
default branch, a supported language, Docker for phase 2, and the repo's plan
and visibility.

Plan and visibility decide enforcement, so say which applies up front:

- **Public repo, or any paid plan** → branch protection, hard enforcement.
- **Private repo on Free** → the audit fallback. Mention that GitHub Pro
  unlocks hard enforcement; do not push it.
- **Public repo** → say now that local session transcripts will only be
  captured if they choose the private data repo in phase 6, because a public
  repo cannot hold them.

If an existing factory is detected, switch to update mode: see
`references/re-running.md`.

## Phase 1 — Assess

`references/phase-1-assess.md`

Build a picture of the codebase and its tooling. Keep what is good; list what
is missing. Then mine past corrections — **ask consent before reading any
agent session**, list what you found, and let them exclude any.

Output: `assessment.md` on the setup branch, and the first `candidates.json`.

## Phase 2 — Make it runnable

`references/phase-2-sandbox.md`

Produce a sandbox where an agent can build the app, run its tests and verify
it in a browser. Reuse an existing devcontainer or Dockerfile if there is one.

**Done when the app starts in the sandbox and a screenshot shows it working.**
If you cannot get there, stop and show the failing step. A factory that cannot
verify anything is worse than no factory, because it produces confident
unverified PRs.

Two things to get right here, both of which have bitten:

- **Never let the sandbox inherit real credentials.** Build its environment
  from an explicit list of throwaway values. Not the developer's environment,
  and not any `.env` file. A documented build command that runs a migration
  will migrate whatever `DATABASE_URL` points at, and on a developer's machine
  that is their real database.
- **Classify the repo's commands, don't copy them.** Record which touch
  persistent state and keep those out of the build path.

## Phase 3 — Install guardrails

`references/phase-3-guardrails.md`

Extend the tools the repo already runs; do not add a second linter beside an
existing one. Rules come from `rules/<language>.yaml`.

**Every rule must fail on its bad example and pass on its good one before you
install it.** The pack carries both. A rule that fires on both blocks correct
code; one that fires on neither is decoration. Neither is visible from reading
the config, so run it.

Apply only mechanical fixes now. Baseline everything else, per file.

## Phase 4 — Clean the codebase

`references/phase-4-clean.md`

Mechanical fixes are already in the setup PR. Everything else is baselined and
seeded as gardening work, most violations first. Cleanup is the one phase
allowed to finish after switch-on.

## Phase 5 — Define the factory

`references/phase-5-define.md`

Write `factory.yaml`, `policy.yaml`, the seven role files, the context files
and the rubrics, then install the workflows and compile them with
`gh aw compile`. Install the Dependabot entry for runner upgrades and the
local session hooks.

All auto-merge toggles start **off**.

## Phase 6 — Instrument

`references/phase-6-instrument.md`

Create the data refs, create the GitHub App, store the model key, estimate the
budget, install the scorers, and record the starting point so the dashboard
shows progress from day one.

- Data refs: `node scripts/init-data-refs.mjs`
- The App: `node scripts/create-app.mjs --repo <owner/name>`
- Budget: `node scripts/estimate-spend.mjs --repo <owner/name>`

## Phase 7 — Switch it on

`references/phase-7-switch-on.md`

Open the setup PR with the user's own credentials — the App cannot push
workflow files, by design. Run the gates on the setup PR itself so they see
every gate pass before merging. Then they merge, and you smoke-test with one
small issue and hand off.

## Things that will tempt you, and shouldn't

- **Do not replace the repo's tools.** A repo with eslint gets its eslint
  config extended, not a second linter.
- **Do not fix anything that needs judgment in the setup PR.** It has to stay
  reviewable. Mechanical fixes only; the rest is baselined.
- **Do not write markdown nobody asked for.** `assessment.md` is deleted after
  merge for exactly this reason. No summaries, no plans, no notes files.
- **Do not skip phase 2's proof.** A screenshot of the running app is the
  evidence that the factory can verify its own work. Without it you are
  installing a factory that cannot tell whether anything works.
- **Do not weaken a guardrail to make setup pass.** If a rule's baseline is
  enormous, that is the finding, and gardening's job.
- **Do not continue past a phase that failed.** Stop, say which step, and say
  what you tried.
