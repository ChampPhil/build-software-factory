# Phase 1 — Assess

Build a picture of the codebase and its tooling. You are looking for what is
good and worth keeping, not only for what is missing.

Output: `assessment.md` on the setup branch (shown in the setup PR, then
deleted on merge so it is not unrequested markdown), and the first
`candidates.json`.

## Inventory what exists

- **Languages, frameworks, package managers**, and whether this is a monorepo.
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
  strictness, no secrets scanning.
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

**Consent comes first.** List the sessions you found — date, harness, first
message — and let the user exclude any before you read a single one. Then
redact secrets from every transcript before analysis.

**Skip generated blocks when mining prose rules.** Tools write into these
files: `next dev` maintains blocks in `AGENTS.md` marked with
`BEGIN:`/`END:` comments, and other tools do the same. Mining those would file
a framework's own instructions as the team's conventions.

Then group corrections into problem classes — 15 instances of one correction
is one candidate with 15 occurrences — sort each by the ordered check (API
change → static rule → verification → context), rank by occurrences and
recency, and show the user **one list**: problem class, occurrences, proposed
fix, one example. Accept-all is the default. One pass, not fifteen questions.

## What to watch for

- **A convention in the docs that the code does not follow** is not the
  dominant pattern. Say so in the assessment; it is often a candidate.
- **A repo with no tests** is a normal case, not a failure. Record it: coverage
  floor 0%, and gardening seeded to add tests per feature folder. Note the
  consequence for the user — diff coverage still applies from the first PR, so
  their first product PR has to arrive with tests.
- **Do not guess at intent.** If you cannot tell which of two patterns is
  dominant, count them and say the count.
