---
name: build-software-factory
description: Turn an existing GitHub repo into a running software factory — guardrails, a sandbox agents can verify in, gh-aw role workflows, and a dashboard. Use when the user asks to set up, install or re-run the software factory on a repo, or to repair or update an existing one.
---

# Build Software Factory — setup

You are setting up a software factory on the user's repo. Everything the user
does happens at the start and takes minutes; then it runs unattended and ends
in a pull request they merge.

## Your first message

Your first message has exactly three parts, in this order, in plain language,
a few lines each:

1. **What you are getting.** A factory that takes a request, builds it in a
   sandbox where it can run the app, checks its own work, and hands back a
   pull request, with a dashboard to watch it and steer it.
2. **What I'll do.** Read the repo, make the app runnable in a closed sandbox,
   install the checks, and clean what they flag. All of it runs on GitHub, not
   on their machine.
3. **What I need from you now.** The checklist below, then one question.
   Nothing else is theirs until the one pull request at the end.

Send the dashboard link, https://buildsoftwarefactory.com, as a **separate
follow-up message** straight after, so it is easy to find later. They sign in
to it once, at the end.

## Front-load the human steps

Every human step happens before the long work, so nothing stops it halfway.
Give them this checklist in your first message and walk them through it in
this order:

- **A. The Anthropic key.** They open
  `https://github.com/<owner>/<repo>/settings/secrets/actions/new`, name it
  `ANTHROPIC_API_KEY`, and paste a key from
  https://console.anthropic.com/settings/keys. You check it is there yourself
  with `node scripts/wait-for.mjs secret ANTHROPIC_API_KEY`.
- **B. Create the App.** `node scripts/create-app.mjs --repo <owner>/<repo>`
  opens GitHub with the name filled in; they press **Create**.
- **C. Install it.** GitHub's page opens already on this one repository; they
  press **Install**. The script checks that the install covers only this repo
  and stops with the exact fix if it covers all of them.
- **D. One question:** should the factory merge changes by itself once every
  gate passes, or ask them to review each one? Review is the safe default.

After D, the only thing left for them is merging the setup pull request, and
only if they chose review.

**Never end a turn on "tell me when you're done".** Anything you can see
yourself, you wait for yourself: run
`node scripts/wait-for.mjs pr-merged <number>` (or `secret NAME`, or
`workflow-success FILE.yml`) in the background and carry on when it exits. It
prints one line a minute so the wait does not look like a hang.

**You speak as one "setup".** Never say "the setup agent said" or name any
other part of the machinery. Say "setup", and say what it is doing, not which
job is doing it.

**Do with `gh` and `git` anything that can be done with them.** Do not ask the
person to look at a page, run a command or tell you whether something happened
when you can find out yourself. To check a file is on the default branch:
`git fetch origin`, then `git cat-file -e origin/main:assessment.md` (exit 0
means it is there). To see whether a PR merged: `gh pr view N --json state`.

**Reuse a setup run that is already going.** Before dispatching
`factory-setup`, run `gh run list --workflow factory-setup.yml --limit 5`; if
one is queued or in progress, follow it instead of starting another. If two
setup PRs exist anyway, keep the older and close the newer with
`gh pr close <n> --comment "Duplicate of #<older>"`.

**This setup runs from any coding agent** — Claude Code, Cursor, Codex, or
another. Nothing below depends on which one you are. The factory's own agents,
the ones that run in GitHub Actions afterwards, are Claude Code regardless of
what you are: that is the only harness whose spend the budget cap can hold, and
`install-factory.mjs` sets it back to Claude Code if it finds anything else.

Work through the phases in order. Each has a reference file with the detail —
read it when you start that phase, not before.

**Tell the user what you found, what you are doing, and what you need, in
plain language, at every phase.** They are watching a long process; silence
reads as a hang.

## What you do and what they do

| They do | You do |
| --- | --- |
| Set `ANTHROPIC_API_KEY` as a repo secret, themselves | Give them the exact link, then wait for the secret with `scripts/wait-for.mjs` |
| Click **Create**, then **Install** on GitHub's App pages | Everything around it, via `scripts/create-app.mjs` |
| Answer one question: merge by itself, or review each change | Turn the answers into its intent and its first practices |
| Merge the setup PR, if they chose review | Everything else, including the bootstrap PR and the wait for it |
| Sign in to the dashboard, once, from the link you give them | Hand them that link before you say setup is done |

Nothing else is theirs. If you find yourself about to ask for something not on
that list, you are about to do their job for them — work it out instead, say
what you decided, and move on.

Nothing runs on their machine. The sandbox is designed and proved in their
GitHub Actions, so they need no Docker and no toolchain.

**The user never opens, edits or is told to edit a configuration file.** Not
`factory.yaml`, not `policy.yaml`, not a workflow. Settings they may change
(budget, shares, merge by itself, cleanup PRs and time) have controls on the
dashboard's Factory page; anything else they ask for, they ask for in words, on
the dashboard's **Ask the factory** box or in this conversation. You make the
change: for a setting, with `bsf settings --set id=value` (it checks the value,
keeps the file's comments and moves the cleanup schedule with it), opened as a
pull request labelled `factory:settings`; for anything else, as a pull request
they approve. Say what the change does in plain words, never which file it
touches. When you report a problem, say what the factory cannot do and how it
gets fixed, not which file is wrong.

**Later, what they can say whenever they like:** `/practice <anything>` as a
comment on any issue or PR adds a standing instruction every agent follows,
through a PR they approve. When the factory stops on something and says so,
`/retry` on that issue or PR hands it back once they have done what it needed.

## Never handle their secrets

The user sets every secret themselves, and you verify it exists. You never ask
for a key, a token or a password, you never accept one if it is offered, and
you never pass one on — not in the conversation, not through a file, not as a
command argument. A key pasted into a chat stays in that chat.

If one does reach you, stop and say so: tell them to revoke it and issue a new
one. That is cheap. A leaked key that nobody mentioned is not.

## If they want it removed

"Uninstall the software factory", "remove this", "get rid of it" — read
`references/uninstalling.md` and do it. Do not try to talk them out of it and
do not ask why first. The factory stops running; everything it built stays.

## Running commands on their machine

**Find out which platform you are on before you run anything.** Setup runs on
the user's own machine, and roughly half of them are on Windows. Everything
below is the difference, and getting it wrong wastes their time on errors that
look like the factory is broken.

- **One command per call.** Never join commands with `&&`: PowerShell rejects
  it outright. If you need two things in sequence, run two commands. (`;` works
  in both shells, but two calls tell you which one failed.)
- **The runner has two launchers.** `.factory/bin/bsf` is for macOS and Linux;
  `.factory/bin/bsf.cmd` is for Windows. Where this skill writes `bsf X`, run
  `./.factory/bin/bsf X` on macOS and Linux and `.\.factory\bin\bsf.cmd X` on
  Windows. **Spell out the `.cmd`** rather than relying on PowerShell to find
  it. Calling the extensionless `bsf` on Windows does nothing at all and exits
  **0**, so a missing `.cmd` reads as a command that worked and printed nothing.
- **A command that prints nothing has not necessarily worked.** If you expected
  output — a URL, a list, a count — and got none, you have a failure, not an
  empty result. Say so rather than carrying on.
- **Never push to the default branch.** Agent environments block it, and you
  will lose the time twice. Post-bootstrap fixes go on a `factory/fix-*` branch
  and through a pull request, like everything else.
- **Retry a failed `git add` once** on Windows before reporting it. An
  antivirus scanner or the search indexer can hold a file under `.git/objects`
  for a moment; the second attempt succeeds.

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
branch, write the person's answers into `practices.md` and, in their own
words, into the protected **Product intent (from you)** block of
`fundamentals.md` (the setup workflow merges around that block and never
rewrites it), and open the **bootstrap PR**. When it is
merged, dispatch `factory-setup`. From there it runs on its own:

- the setup agent reads the repo and writes a complete candidate — every
  context file, and a sandbox manifest whose values it chose by reading what
  the code does with each one;
- the runner brings up exactly that candidate and measures the tier it
  reaches: the app renders and is screenshotted, or it builds and its tests
  pass, or neither;
- up to three rounds while the measured tier falls short of the claim, then
  the best round is frozen into the **setup PR**.

While it runs, start `node scripts/progress.mjs` in the background and relay
each line it prints as one plain sentence. It prints only when the stage
changes or after three quiet minutes, and says when their app has started in
the sandbox.

Tell the user the tier it reached and, below `renders`, what stopped it — the
manifest records why. A repo that can only reach `build_and_test` still gets a
factory; its gates claim no more than that tier allows. If the trial reaches
no tier at all — the app does not even build — stop and show the failing step.
A factory that cannot verify anything produces confident, unverified PRs.

You do not design the sandbox yourself.
Never let the sandbox inherit real credentials — not the user's, not production's. The agent decides the values; the closed environment and the
trial make that safe.

## Phase 3 — Install guardrails

`references/phase-3-guardrails.md`

Extend the tools the repo already runs; do not add a second linter beside an
existing one. Rules come from `rules/<language>.yaml`. Install the linter
(every rule in `AGENTS.md` as a lint rule), the formatter, every de-duplicated
rule candidate, and the local correction hook, which is on by default.

**Every rule must fail on its bad example and pass on its good one before you
install it.** The pack carries both. A rule that fires on both blocks correct
code; one that fires on neither is decoration. Neither is visible from reading
the config, so run it.

Nothing is baselined. The formatter runs once, as its own "format only"
commit; everything else the rules flag is fixed in phase 4.

## Phase 4 — Clean the codebase

`references/phase-4-clean.md`

Setup removes every existing violation, so the factory starts on a repo that
passes its own rules. You decide, without asking, whether that is one PR or a
sequence of PRs, and say which in one line.

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
every gate pass before merging. Wait for the merge with
`scripts/wait-for.mjs pr-merged`, smoke-test with one small issue, and finish
with the closing message in `references/phase-7-switch-on.md`.

## Things that will tempt you, and shouldn't

- **Do not replace the repo's tools.** A repo with eslint gets its eslint
  config extended, not a second linter.
- **Do not baseline.** A suppression file is a promise to clean up later.
  Fix the violations; if one cannot be fixed without changing behaviour, file
  it as product work and leave the rule enforced.
- **Do not write markdown nobody asked for.** `assessment.md` is deleted after
  merge for exactly this reason. No summaries, no plans, no notes files.
- **Do not skip phase 2's proof.** A screenshot of the running app is the
  evidence that the factory can verify its own work. Without it you are
  installing a factory that cannot tell whether anything works.
- **Do not weaken a guardrail to make setup pass.** If a rule's violation
  count is enormous, that is the finding: report it and work through it.
- **Do not continue past a phase that failed.** Stop, say which step, and say
  what you tried.
