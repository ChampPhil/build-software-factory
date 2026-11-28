# Phase 1 — Assess

Build a picture of the codebase and its tooling. You are looking for what is
good and worth keeping, not only for what is missing.

Output: `assessment.md` on the setup branch (shown in the setup PR, then
deleted on merge so it is not unrequested markdown), and the first
`candidates.json`.

## Inventory what exists

- **Languages, frameworks, package managers**, and whether this is a monorepo.
- **Whether the repo has any tooling at all**, and **what its pages load from
  the network.** A hand-written site with its libraries on a CDN and no
  `package.json` is a common thing to find, and it changes two expectations
  that are better set now than discovered later:
    - **Pages that load libraries from the network.** A blank page makes every
      screenshot worthless. Run `bsf scan-asset-hosts --why` and list what it
      finds. Those library hosts need a local copy, because the private copy
      does not browse the public web for them. A real integration is different:
      Stripe, Clerk, mail, and a job runner keep a standing test surface. A
      stub that forgets the request does not count, and a fake key that only
      lets the process boot does not count. Ask once for a test-mode secret.
      They paste it on GitHub, not in the chat. The finish line is the journeys
      in the feature map, not a page that merely renders.
    - **It has nothing for guardrails to extend**, so phase 3 §0 applies and
      the setup PR will add a minimum toolchain. Say that in the assessment
      too: it is a change the owner did not ask for, and they should meet it
      here rather than in a diff.
  One factory per repo, with a section per app in the feature map and runbook.
- **Existing CI**, and above all **the name of the repo's own test check and
  what triggers it.** If it runs on pushes to `factory/*` branches, Gate 2 can
  read its result for the same commit instead of re-running the tests. If it
  does not, record no test check and let the factory run the tests itself.
  **Do not edit the team's CI to make this work.** A factory that rewrites the
  team's pipeline on day one is a factory nobody trusts.
- **Existing branch protection and required checks.** The factory keeps every
  one of them and adds its own.
- **How the app builds and runs**: Dockerfiles, devcontainers, `Makefile` and
  `package.json` scripts, setup docs.
- **Folder structure**: whether code is one folder per feature, and the import
  edges between folders.
- **Dominant patterns worth keeping.** For each recurring concern — API calls,
  errors, logging, data access — find the pattern most of the codebase uses.
  This is what the guardrails will enforce, so get it from the code rather than
  from the docs, which are often aspirational.

## Find the gaps

- Missing guardrails per kind: no formatter, no dependency rules, no type
  strictness.
- Coverage per area, and areas with no tests at all.
- **Two patterns for one concern.** Two ways of calling the API is nuance an
  agent will get wrong. Copy-pasted code is worth finding too.

## Mine past corrections

The point is to catch every correction already made and turn the recurring ones
into guardrails on day one, so the factory does not relearn them one PR at a
time.

| Source | Where | What counts |
| --- | --- | --- |
| Past agent sessions | memex, across all five harnesses | A turn that rejects or redirects the agent ("no", "don't", "instead", "that's wrong"), or an undo of an agent edit |
| PR review comments | every merged and closed PR | A comment that asked for a change the author then made |
| Reverts | `git log` | Any revert, plus what it reverted |
| Fix commits | `git log` | A fix/hotfix touching code changed in the previous 14 days |
| Bug history | issues labelled bug with a linked fix | The bug and its fix |
| Prose rules | `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, style guides | Every rule-like sentence: always, never, use X instead of Y |

**Consent comes first.** `bsf mine-corrections --list` names every session it
would read — date, harness, opening line — and reads nothing else. Show that
list, let the user exclude any, then `bsf mine-corrections --exclude <ids>`
reads only the rest. A turn whose session cannot be identified is dropped
rather than kept, because it might be one they excluded.

Secrets are redacted as each correction is kept, not on the way out: these
candidates are committed and pushed, and people paste keys into agent chats.

**The repository's own history needs no consent and no memex,** so it is mined
either way: reverts, fixes that landed within fourteen days of the code they
fixed, and the rule-shaped sentences in `AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md` and the rest. On a repo no agent has touched, this is the
only mining that will find anything.

**Skip generated blocks when mining prose rules.** Tools write into these
files: `next dev` maintains blocks in `AGENTS.md` marked with
`BEGIN:`/`END:` comments, and other tools do the same. Mining those would file
a framework's own instructions as the team's conventions.

Then group corrections into problem classes — 15 instances of one correction
is one candidate with 15 occurrences — sort each by the ordered check (API
change → static rule → verification → context), rank by occurrences and
recency, and show the user **one list**: problem class, occurrences, proposed
fix, one example. Accept-all is the default. One pass, not fifteen questions.

Every do-not, must, never, and always, and every mined correction, is
installed as a check later. A bad example fails and a good example passes.
A candidate left pending means setup is not finished. An add-the-rule card
is not the install path. Do not leave the list for them to click through.

Run `bsf mine-corrections`. It writes `.factory/guardrails/mining-report.json`.
A revert is already a correction. A sentence from a conventions file, a
fix-commit subject, an applied review comment, a bug issue closed by a
commit, and a soft chat turn are evidence. They are not rules until a label
says so and the quote is copied from that evidence. Exit 2 means those
findings are still unlabelled.
Write `.factory/guardrails/classes.json` as
`{"labels":[{"id":"...","kind":"rule"|"once"|"noise","enforcement":"api_change"|"static_rule"|"verification"|"context","quote":"a span copied from the finding"}]}`
and run `bsf mine-corrections --classes .factory/guardrails/classes.json`.
A quote that is not in the finding is refused. If `ANTHROPIC_API_KEY` is set
and you pass no classes file, the miner asks the model itself.

## The survey has to be complete

Write `assessment.json` with one field per section (`schema` is `"survey/1"`),
then run `bsf assess write --from assessment.json`. That command writes
`assessment.md` and inserts the miner's own summary sentence, so the counts
cannot be misquoted. Then run `bsf assess check`.

`assessment.md` uses these headings. Each one has to be there. A short true
sentence is enough. The check does not measure length.

- `## How it builds and tests`
- `## The test check` — the repo's own test workflow and what triggers it, or
  that there is none
- `## Patterns` — the dominant pattern per concern, from the code
- `## Where two patterns compete` — how many patterns compete, including when
  the answer is one
- `## Coverage` — the measured floor, or that there are no tests
- `## What mining found` — extra notes; the miner's summary sentence is
  inserted by `bsf assess write`, do not type it yourself

Then run `bsf assess check`. Setup is not finished while it fails. A survey
that skips a heading, or that does not include the miner's summary sentence,
fails. The file is still deleted after the setup pull request merges.
`practices.md` and `fundamentals.md` stay short, because every later run
re-reads them. `fundamentals.md` does not become a second copy of the README
or `AGENTS.md`. `bsf assess fundamentals` refuses it when half or more of
its long lines are copied from those files. A few shared sentences are not
a failure.

## What to watch for

- **A convention in the docs that the code does not follow** is not the
  dominant pattern. Say so in the assessment; it is often a candidate.
- **A repo with no tests** is a normal case, not a failure. Record coverage
  floor 0%, because that is what was measured, and gardening seeded to add
  tests per feature folder. Note the consequence for the user — diff coverage
  still applies from the first pull request, so their first product pull
  request has to arrive with tests. If tests exist, the floor is the coverage
  the suite measured. A floor of 0 while tests exist means setup is not
  finished. Do not deselect or ignore tests to go green.
- **Do not guess at intent.** If you cannot tell which of two patterns is
  dominant, count them and say the count.
