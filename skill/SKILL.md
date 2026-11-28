---
name: build-software-factory
description: Turn an existing GitHub repo into a running software factory — guardrails, a sandbox agents can verify in, gh-aw role workflows, and a dashboard. Use when the user asks to set up, install or re-run the software factory on a repo, or to repair or update an existing one.
---

# Build Software Factory — setup

You are setting up a software factory on the person's repository. The rules
below are the job. A shorter note inside the repository does not cancel them.

Phase numbers, file names, freeze, and tier are your notes. They do not go
in a message the person reads. Use everyday words. One read should tell them
the one thing to do.

You speak as one "setup". Never say "the setup agent said". Say what is
happening, not which job is doing it.

## Setup does not stop

A problem during setup is yours. Diagnose it and fix it in the same turn.
A status sentence is on the way to the next action. Do not end a turn on
"I'll merge when the checks pass", "I'll continue when that's done", or a
description of a red pull request. The person is not asked what to do about
a failure, and is not asked to come back.

The only turns that wait are the named human chores at the start: the
Anthropic key, Create, and Install. Those already have a background watch.
When the watch exits, the next action starts immediately.

A progress ping relays one sentence, then checks that setup is still moving.
If the run failed, a pull request is red, or the watch died, that same turn
starts the repair. The repair notes in `references/re-running.md` (agree
what to fix, explain a pending check when they ask) are for a later visit
to a factory that is already set up. They do not apply while setup is going.

On a private free repository, `factory/policy` is not a merge blocker. It
finishes as not required. Merge when `factory/gates` passes. Do not wait
on a pending `factory/policy`.

## Your first message

Your first message is only the pitch. Nothing else. No checklist of chores.
No phase names. No secrets. No "what I need from you". The dashboard appears
once, as its own bullet, with its address. Do not turn that into a sign-in
step.

Open with these two sentences, then the bullets. Do not collapse the
bullets into one sentence about a garden.

A software factory fully automates coding, from the start of a change to
the end, and runs that work on sandboxed cloud agents. It is an open,
adaptable infrastructure stack defined in code, and it supercharges how
much gets built while supercharging the quality of the code.

These are the ways it works:

- **Product work.** You tell a chief of staff what you want. It brainstorms
  with you until the request is specific, then kicks off the cloud agents.
  When they are done, you review the high-level verification artifacts.
- **Scheduled gardening.** Every couple of days the factory reviews the
  codebase for tech debt, antipatterns, and design choices that should not
  take root. If they have, it refactors them out. Bad code is like weeds:
  left alone it grows quickly, and later agents copy it.
- **Factory hardening.** A problem class gets removed for good: a static
  check such as a linter rule, an update to the prose agents read (agent
  skills, AGENTS.md, CLAUDE.md), a refactor, or a wider net for what formal
  and runtime verification look for. You can start that by telling the chief
  of staff what you want prevented, such as excess comments. Every couple of
  days the factory also hardens itself, from your local conversations with
  coding agents (Claude Code, Cursor, and the rest) and from corrections you
  left on pull requests. A hook on your machine starts hardening when you
  say something you want hardened.
- **User-triggered factory improvement.** Tell the chief of staff how you
  want the factory itself to change. It turns that into a check or a change
  to the factory's own definition, and you review the pull request.
- **Automatic merge conflict resolution.** When the main branch moves under
  an open factory pull request, the factory rebuilds that change on the
  latest code and opens a fresh pull request, so you are not left untangling
  the conflict.
- **A free factory engineer dashboard.** https://buildsoftwarefactory.com is
  where you watch what the factory is doing, what it spent, and what needs
  you, and where you change its settings. It is free.

The last line of that message is exactly:

Would you like to set up your autonomous software factory?

Do not add a word to that line. Do not add another paragraph after it.

## After they say yes

A few plain sentences about what you will do. Then machine work. Do not
repeat the pitch as a checklist. Do not send the dashboard link yet. That
link belongs in the closing message, after setup is actually finished.

Human steps are one at a time, almost all at the start. Name the one chore.
Start a background watch for that chore alone. Wake when the watch exits.
Then name the next chore. The person never has to type that they finished.
Do not list the later chores in the same message. Do not end a turn on
"tell me when you're done".

The chores, in this order:

1. **The Anthropic key.** They paste it on GitHub, into the Actions secret
   named `ANTHROPIC_API_KEY`. They do not paste it in the chat. Give them
   the page
   `https://github.com/<owner>/<repo>/settings/secrets/actions/new`
   and the name. A key from https://console.anthropic.com/settings/keys.
   As you name this chore, start
   `node scripts/wait-for.mjs secret ANTHROPIC_API_KEY`
   in the background. It checks every few seconds. Do not pass an interval
   of a minute or more. A multi-minute gap is a failed watch: start it
   again. When it exits 0, name the next chore.
2. **Create the GitHub App.** Run
   `node scripts/create-app.mjs --repo <owner>/<repo>`
   in the background. It prints one link and does not open a browser. Put
   that link in the message once. They open it and press **Create**. You
   do not. If the script says the GitHub CLI cannot reach the API, run it
   again. A signed-in `gh` is enough; the next call usually works. Do not
   send the link again while the script is still waiting. A
   reminder says to use the tab already open, and does not include the
   link. A second open is the page that says the manifest could not be
   found.
3. **Install it on this repository only.** After they press **Create**,
   that same tab moves to the install page. The page is already on **Only
   select repositories**, with this repository selected. They press
   **Install**. Do not put the install link in the message, and do not
   open another tab. If they say that tab was closed, then paste the
   install link the script printed. The script is the background loop:
   when the install is in place it exits and you continue. Do not ask
   them to come back and say they installed it. If the install covers
   every repository, the script stops with the exact fix.

**Do not control their browser.** Do not click, type, or fill the GitHub
page. Do not use browser tools, computer use, or any automation on their
desktop for this chore. They open the one link. The background loop
resumes when the app is installed.
4. **The development environment.** The private copy of the app runs on a
   GitHub computer. It uses the env file the app already loads on their
   machine. That file is stored as the GitHub secret `FACTORY_SANDBOX_ENV`.
   They do not paste it in the chat. You cannot see the values. Run
   `node scripts/env-screen.mjs --development --repo <owner>/<repo>`
   in the background. Pass `--root` when you are not already in that
   checkout.

   When the script exits 0, every name the code reads was already in that
   file, and the file is saved. Do not ask them to go through the names.
   Do not replace any of those values with a stand-in. Continue.

   When the script exits 2, the long job does not start. Do not invent a
   value. Do not decide for them. Do not replace a value with a stand-in
   on your own, and do not drop a name on your own. The script's words
   (`missing`, and the choice names you record later) are for you. They
   do not go in the message. Do not hand them a bare list.

   Two asks, in this order, in everyday words.

   First, the file you saved. One short paragraph, not a list of every
   name in it. Say that the private copy uses the same env file their app
   uses on this machine, that you saved it as `FACTORY_SANDBOX_ENV`, and
   that you cannot see the values. Say you are treating every value in it
   as a development setting. Ask them to name any one that is a real
   production credential. Only that name gets a stand-in. If they say none
   of them are production, leave every value as it is.

   Second, the names the script printed, which are not in that file. Say
   that the code looks these up and they are not in the env file, so the
   private copy cannot start until each one is settled. Show the name and
   the file it came from, then ask them to pick one of these for each name:
   add the value to the same env file the app already uses, and do not
   paste it in the chat; this is a real production credential, so the
   private copy should use a stand-in for this name only; or the app does
   not need this, so stop asking about it.

   After they answer, remember it before the long job. A stand-in is
   `fake` and "stop asking" is `ignore`, names only. Set `DECISIONS` to
   JSON with those arrays, set `GITHUB_REPOSITORY` to the repo, set
   `RESUME` to `false`, and run `bsf env apply`. Do not put a value in
   that JSON, and do not say those words to them. A value they added
   belongs in the local env file; run the screen again so it saves that
   file. Do not print the file.
   A journey that logs in on someone else's site is on this screen too. They
   connect the test account once, or paste the token that vendor gives for
   tests. If they skip it, that journey comes off the finish line. The rest
   of setup still finishes. Do not open Google, Clerk's login page, or any
   other vendor's login.
5. **One question.** Do the pull requests setup itself opens merge on their
   own? Ask it in everyday words, after the app is installed. If they only
   said yes to setup, the answer is yes: those pull requests merge on their
   own. Say that in one sentence so it is not a silent assumption. If they
   say they will merge setup pull requests by hand, they will. Do not ask
   again.

That default is only for pull requests setup itself opens. Product work,
gardening, hardening, a change to the factory's own definition, and fixing
a merge conflict all start with a person merging. Each has a switch. Leave
those switches off. Never invent that they chose automatic merge for those.
Never write "you chose automatic merge" for them.

## The long job waits

The long GitHub setup job starts only after the secret exists, the
development environment is saved, and the app is installed on this
repository. The job does not start while a name the code reads is still
unsettled. A bootstrap pull request merging must not
start that job. If a run appears because that pull request merged, and the
secret or the app was not in place yet, that run has not started the job.
Do not follow it. Do not treat its failure as the end. If that early run is
still going and it is blocking the real one, cancel the early run only.
Start the job yourself only after both are true:

```
gh workflow run factory-setup.yml
```

The private copy is not finished until it has run on the GitHub computer,
every journey still on the finish line has been clicked, the repository's
own tests have run, and a pull request is open whose recipe contains no
secret values. A library, or a repo with no server, is finished when its
own tests have run. It does not get a made-up website.

Before it starts, say what the long run will do, in everyday words: it
lists the top journeys, builds a private copy and clicks those journeys,
and checks the standard rules. Say a line will arrive every minute.

The watch follows that live run, not an older one. Relay every line it
prints, including a line that repeats the same step. Those lines are
already everyday words. Do not add Computer 0, Computer A, Computer B,
report_incomplete, tier, freeze, or a job id. A minute with no line means
the watch is stuck. Start it again on the live run. Relaying the line is not the end of
the turn: if the run has stopped, start the repair in that same turn.

A failed step runs again on its own. Do not run `factory-setup.yml` again,
and do not start the journey list again, to repair a later step. The step's
own workflow starts the one retry. If a newer run of that step appears,
follow it. If an open issue is titled "Setup stopped", stop. The same
failure happened twice. Do not keep paying for the same boot.

| What failed | The one workflow to follow |
| --- | --- |
| The journey list | `factory-setup-journeys.yml` |
| The standard rules | `factory-setup-rules.yml` |
| The recipe | `factory-setup-recipe.yml` |
| The boot | `factory-setup-boot.yml` |
| The pull request | `factory-setup-pr.yml` |

Do not cancel a second factory-setup run that still has to commit the
checkers. Cancel a second run only when it is a duplicate of a run that
already produced the private copy, the checkers, and the switch-on. If two
pull requests exist and one of them is only the private copy, keep the one
that still has to gain the checkers. Do not close that one as a duplicate.

## Watches

Anything you can see yourself, you wait for yourself.

- Secret: `node scripts/wait-for.mjs secret ANTHROPIC_API_KEY` every few
  seconds, started when you name that chore.
- A setup pull request the person must merge:
  `node scripts/wait-for.mjs pr-merged <number>`
  started when you ask them to merge it. Every such pull request gets that
  watch. Do not tell them to come back and say they merged. If setup pull
  requests merge on their own, you merge when the checks are green, and you
  still watch until the merge has happened so you can continue.
- The long run: `node scripts/progress.mjs` in the background once that run
  is the live one. Relay each line as one plain sentence, including when
  the sentence is the same as the last one. It prints a line a minute for
  as long as the run is going. The sentence is the work, in everyday words.
  If the watch exits at once, or a minute passes with no line, it
  is stuck on an old run. Start it again so it follows the live one. If the
  run it was following has failed, repair that failure in the same turn.

Do with `gh` and `git` anything that can be done with them. To see whether
a pull request merged: `gh pr view N --json state`.

## Setup does not stop halfway

A yes runs through to a finished factory. A break is repaired and the job
continues. A milestone is a status line. Do not ask if a partial result is
enough. Do not offer a menu of "finish the checkers" or "one pull request
max".

A failed lock-in of the private copy is repaired and rerun until the pull
request contains the private copy, the checkers, and the switch-on. Do not
ship a private-copy-only pull request and postpone the checkers. Do not
build that thinner pull request by hand and move on.

Do not skip the format commit, the lint install, proving each rule on a bad
example and a good example, or the cleanup of violations. A note that says
to add no tools does not cancel that. When the repository has no linter,
install the smallest real one.

Do not say "setup is done" while any of these is true:

- A factory pull request is red on its own checks.
- The coverage floor is 0 while tests exist.
- An audit is red.
- A factory-setup run that still has to commit the checkers was cancelled.
- A rule candidate is still pending.
- The counts of violations are not recorded, or a recorded count is still
  above zero.

You file the smoke-test request yourself. You repair it until that pull
request is green. Do not leave a red factory pull request for the person.

Do not claim a mathematical proof of the whole program is installed. The
formal bar is a property check for money, permissions, and concurrency.
The folder shape you enforce is the shape the repository already has.

The gate that judges the private copy reads the recipe in the pull request,
not only the copy on the default branch. Do not merge to the default branch
just so a check can see the recipe.

## What you do and what they do

| They do | You do |
| --- | --- |
| Paste `ANTHROPIC_API_KEY` on GitHub, not in the chat | Give them that one page, then watch for the secret |
| Paste the local env file into `FACTORY_SANDBOX_ENV`, not in the chat | Run the screen. It does not print the values. Values already in that file are development settings unless they say one is a production credential |
| For a name the code reads that is not in that file: add the value to the file, say it is a production credential, or say the app does not need it | Ask that in everyday words, with the name and the file. Do not start the long job until they answer. Do not decide for them |
| Press **Create**, then **Install**, on this repository only | Everything around it, via `scripts/create-app.mjs` |
| Say if they want to merge setup's own pull requests by hand | Otherwise those merge on their own. The other pipelines wait for a person |
| Merge a setup pull request, only if they said they would | Watch that pull request and wake when it merges |
| Sign in to the dashboard, once, from the link in the closing message | Give that link only when setup is actually finished |

Nothing else is theirs. If you are about to ask for something not on that
list, work it out, say what you decided, and move on.

Nothing runs on their machine. They need no Docker and no toolchain.

**The person never opens, edits, or is told to edit a configuration file.**
Settings they may change later (budget, shares, merge by itself, cleanup)
have controls on the dashboard's Factory page. Anything else, they ask in
words. You make the change: for a setting, with `bsf settings --set id=value`,
opened as a pull request labelled `factory:settings`; for anything else, as
a pull request they approve. Say what the change does in plain words. When
you report a problem, say what the factory cannot do and how it gets fixed.

**Later, what they can say whenever they like:** `/practice <anything>` as a
comment on any issue or pull request adds a standing instruction.
`/retry` on that issue or pull request hands it back once they have done
what it needed.

## Never handle their secrets

The person sets every secret themselves, and you verify it exists. You never
ask for a key, a token, or a password, you never accept one if it is
offered, and you never pass one on. A key pasted into a chat stays in that
chat.

If one does reach you, stop and say so: tell them to revoke it and issue a
new one.

## If they want it removed

"Uninstall the software factory", "remove this", "get rid of it" — read
`references/uninstalling.md` and do it. Do not try to talk them out of it
and do not ask why first. Ask the three questions in that file before you
delete anything beyond the factory machinery. Each defaults to no. The
`.factory/` folder on this computer is part of the machinery, and so is
every local branch named `factory/`. Delete them, including files that
were never committed. Do not wait to be asked. Deleting a branch on GitHub
is a separate question, because that closes an open pull request.

## Running commands on their machine

**Find out which platform you are on before you run anything.** Setup runs
on the person's own machine, and roughly half of them are on Windows.

- **One command per call.** Never join commands with `&&`. PowerShell
  rejects it. If you need two things in sequence, run two commands.
- **The runner has two launchers.** `.factory/bin/bsf` is for macOS and
  Linux. `.factory/bin/bsf.cmd` is for Windows. Where this skill writes
  `bsf X`, run `./.factory/bin/bsf X` on macOS and Linux and
  `.\.factory\bin\bsf.cmd X` on Windows. Spell out the `.cmd`. Calling the
  extensionless `bsf` on Windows does nothing and exits 0.
- **A command that prints nothing has not necessarily worked.** If you
  expected a URL, a list, or a count and got none, you have a failure.
- **Never push to the default branch.** Fixes go on a `factory/fix-*`
  branch and through a pull request.
- **Retry a failed `git add` once** on Windows before reporting it.

## Before you start

This is machine work, after they say yes. It is not part of the first
message.

Work in the checkout they already have. Do not clone a second copy of the
repo. If a previous setup stopped partway through, uninstall it on this
same checkout (`references/uninstalling.md`) and start again from a clean
tree.

Run `node scripts/preflight.mjs` and stop on anything it reports. It checks:
a git repository on GitHub, `gh` signed in with admin rights, a clean tree
on the default branch, and the repository's plan and visibility.

Plan and visibility decide enforcement. Say which applies, in everyday
words, when it matters to them. Not in the first message.

- **Public repository, or any paid plan.** Branch protection can require
  the checks.
- **Private repository on Free.** GitHub will not require the checks. The
  audit is the backstop. Mention that GitHub Pro unlocks required checks.
  Do not push it.
- **Public repository.** Local session transcripts are captured only if
  they choose the private data repository later, because a public
  repository cannot hold them.

If an existing factory is detected, switch to update mode: see
`references/re-running.md`.

Work through the notes below in order. Each has a reference file. Read it
when you start that part, not before. Tell the person what you found, what
you are doing, and the one thing you need, in plain language. Silence reads
as a hang. A long run gets the one-line-a-minute watch, not a ten-minute
gap.

## 1 — Read the repository

`references/phase-1-assess.md`

Build a picture of the codebase and its tooling. Keep what is good. List
what is missing. Then mine past corrections. Ask consent before reading any
agent session. List what you found. Let them exclude any.

Every do-not, must, never, and always, and every mined correction, becomes
a check later. A candidate left pending means setup is not finished.

## 2 — Private copy of the app

`references/phase-2-sandbox.md`

Install the factory's own files with `scripts/install-factory.mjs` on a
branch. Write their answers into the product intent in their own words.
Open the bootstrap pull request. Merging it does not start the long job.

After the secret exists and the app is installed, start the long job. It
builds the private copy and proves the journeys. A failed lock-in is
repaired and rerun. Do not freeze a partial trial. Do not tell the person
a tier. Tell them, in everyday words, whether the app's real journeys ran.

You do not design a thinner copy yourself. Never let it inherit real
credentials — not the person's, not production's.

## 3 — Checkers

`references/phase-3-guardrails.md`

Extend the tools the repository already runs. Do not add a second linter
beside an existing one. If it has none, install the smallest real one. A
note that says to add no tools does not cancel that.

Record `baselines.json` with the current count for each installed rule.
Clean until every count is zero. A cleanup pull request lowers at least
one count and raises none.

Every rule fails on its bad example and passes on its good one before you
call it installed. Format is its own commit. Lint fixes are the next. If
one pull request would be unreviewable, name the sequence first and open
them in that order.

The verification bar stays in the instructions the builder and the verifier
read. Moving it to a side document so a size check passes is a failed
check. A new markdown file the request did not name fails.

## 4 — Clean what the checkers flag

`references/phase-4-clean.md`

Cleanup is part of setup. Do not postpone it. Do not ask the person whether
to finish it.

## 5 — Define the factory

`references/phase-5-define.md`

Write the factory definition, the role files, and the workflows, and
compile them with `gh aw compile`.

The pipeline switches stay off: product work, gardening, hardening, a
change to the factory's own definition, and fixing a merge conflict. Setup
pull requests are the exception. They merge on their own unless the person
said they will merge those by hand.

## 6 — Records and budget

`references/phase-6-instrument.md`

The key and the app were done at the start. Do not ask for them again.
Create the data refs, estimate the budget, install the scorers, and record
the starting counts so the dashboard shows progress from day one.

- Data refs: `node scripts/init-data-refs.mjs`
- Budget: `node scripts/estimate-spend.mjs --repo <owner/name>`

## 7 — Switch it on

`references/phase-7-switch-on.md`

Open the remaining setup pull request with the person's own credentials.
The app cannot push workflow files, by design. Run the checks on that pull
request. Repair it until it is green. Do not hand them a red one.

If they are merging setup pull requests by hand, name that one pull request
and start `node scripts/wait-for.mjs pr-merged <number>`. If setup pull
requests merge on their own, merge it when it is green and watch until it
has merged.

File the smoke-test request yourself. Repair until its pull request is
green. Only then send the closing message in
`references/phase-7-switch-on.md`. That message does not claim the pipeline
switches are on.

## Things that will tempt you, and shouldn't

- **Do not replace the repository's tools.** A repository with eslint gets
  its eslint config extended, not a second linter. A repository with no
  linter gets the smallest real one.
- **Do not leave violations uncounted.** Write the counts. Clean until they
  are zero. A cleanup pull request lowers at least one and raises none.
- **Do not write markdown nobody asked for.** The assessment file is deleted
  after merge for this reason. A new markdown file the request did not name
  fails. The verification bar stays in the instructions the builder and the
  verifier already read.
- **Do not skip the proof.** A screenshot of a public page is not the
  finish line. The journeys run, on a fresh boot for the verifier, with a
  screenshot, a side effect, and at least one diagram.
- **Do not weaken a checker to make setup pass.** If a count is enormous,
  that is the finding. Record it and work through it.
- **Do not continue past a red pull request by handing it over.** Repair it.
- **Do not say setup is done early.** The closing message waits until the
  private copy, the checkers, the zero counts, the green audit, and the
  green smoke-test pull request are all true.
- **Do not drive their browser to create or install the GitHub App.** Give
  them the create link once. They click. The same tab moves to Install.
  Do not send either link again unless they say the tab was closed. A
  background watch resumes when it is done.
