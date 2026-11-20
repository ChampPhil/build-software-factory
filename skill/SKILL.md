---
name: build-software-factory
description: Turn an existing GitHub repo into a running software factory — guardrails, a sandbox agents can verify in, gh-aw role workflows, and a dashboard. Use when the user asks to set up, install or re-run the software factory on a repo, or to repair or update an existing one.
---

# Build Software Factory — setup

You are setting up a software factory on the user's repo. Everything the user
does happens at the start and takes minutes; then it runs unattended and ends
in a pull request they merge.

Work through the phases in order. Each has a reference file with the detail —
read it when you start that phase, not before.

**Tell the user what you found, what you are doing, and what you need, in
plain language, at every phase.** They are watching a long process; silence
reads as a hang.

## What you do and what they do

| They do | You do |
| --- | --- |
| Click **Create**, then **Install** on GitHub's App pages | Everything around it, via `scripts/create-app.mjs` |
| Paste a model API key once | Store it as a repo secret |
| Answer a few questions about the product | Turn the answers into its intent and its first practices |
| Merge the bootstrap PR | Install the runner, the definition and the workflows in it |
| Merge the setup PR | Everything between the two: the setup episode runs on its own |

Nothing else is theirs. If you find yourself about to ask for something not on
that list, you are about to do their job for them — work it out instead, say
what you decided, and move on.

Nothing runs on their machine. The sandbox is designed and proved in their
GitHub Actions, so they need no Docker and no toolchain.

**Later, what they can say whenever they like:** `/practice <anything>` as a
comment on any issue or PR adds a standing instruction every agent follows,
through a PR they approve.

## Before you start

Run `node scripts/preflight.mjs` and stop on anything it reports. It checks:
a git repo on GitHub, `gh` signed in with admin rights, a clean tree on the
default branch, and the repo's plan and visibility. Not Docker, and not any
language toolchain: nothing of phase 2 runs here.

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

Install the factory's own files with `scripts/install-factory.mjs` on a
branch, write the product answers into `practices.md` and the product-intent
section of `fundamentals.md`, and open the **bootstrap PR**. When it is
merged, dispatch `factory-setup`. From there it runs on its own:

- the setup agent reads the repo and writes a complete candidate — every
  context file, and a sandbox manifest whose values it chose by reading what
  the code does with each one;
- the runner brings up exactly that candidate and measures the tier it
  reaches: the app renders and is screenshotted, or it builds and its tests
  pass, or neither;
- up to three rounds while the measured tier falls short of the claim, then
  the best round is frozen into the **setup PR**.

Tell the user the tier it reached and, below `renders`, what stopped it — the
manifest records why. A repo that can only reach `build_and_test` still gets a
factory; its gates claim no more than that tier allows.

You do not design the sandbox yourself, and you do not hand it any credential
of the user's. The agent decides the values; the closed environment and the
trial make that safe.

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
