# Phase 3 — Install guardrails

Build static rules and verification from the assessment, **extending the tools
the repo already runs** rather than replacing them. A repo with eslint gets its
eslint config extended. It does not get a second linter beside the first.

Output: `.factory/guardrails/` plus edits to existing tool configs, all inside
the setup PR.

## 0. When the repo has no tools at all

"Extend what is there" has nothing to extend in a repo with no linter, no
formatter and no test runner — a hand-written page with its libraries on a CDN,
which is a very common thing to find. The first live install was exactly this,
and the result was a factory with **0 rules installed and 0 baselined**:
`factory/gates` passed because it had nothing to check, and every change went
through on an agent's word.

That is worse than no guardrails, because it looks like guardrails. So when the
dominant language has no tool present, install a minimum one as part of the
setup PR, and say in the PR that you did and why:

- **JavaScript or TypeScript** — a `package.json` if there is none, with eslint
  and prettier as devDependencies and `lint` and `format` scripts, then the
  universal rules below configured on them.
- **Python** — ruff, with `lint` and `format` entry points.
- **Anything else** — the standard formatter and linter for that language, or,
  if there is genuinely none, say so in the setup PR and leave the coverage
  floor at 0 rather than pretending.

Keep it to the smallest thing that makes the gates mean something. This is a
tool the repo's owner did not ask for, so it earns its place by being the
minimum, and the setup PR says plainly that it was added and that removing it
leaves the gates vacuous.

A repo with tools but no tests is a different case: that is §5, and the floor
starts at 0 by design.

## 1. Universal rules

From `rules/<language>.yaml`, each configured on a tool the repo already has
(or on the minimum one §0 just installed):
formatter, type strictness, secrets scanning, dependency cycles, suppression
control (a reason required, counted, capped).

Write the pack's `base_config` for each tool first — parser, source type,
declared globals — then merge each rule's fragment on top. Skipping it is how
`no-undef` ends up firing on `module` in a CommonJS repo.

## 2. Codebase rules

From the dominant patterns. For each recurring concern, ban the minority
patterns and enforce the dominant one: "network calls only through
`apiClient`". These are the rules that make an agent's output match the
codebase instead of matching its training data.

## 3. Structure rules

One folder per feature, with dependency-graph checks between feature folders —
**only where the codebase already leans that way.** Imposing a structure the
repo does not have is a refactor, not a guardrail.

## 4. Accepted candidates

Each becomes whatever the ordered check chose: an API change (queued as a
cleanup PR), a static rule, a verification scenario added to the runbook and
test suite, or a context line. Candidates flagged `critical_logic` — money,
permissions, concurrency — also get a targeted formal check.

## 5. Coverage

Record the current total as the high mark, set the floor one point below it,
set the diff minimum to 80% (this is the main check), and count existing skips.

With no tests at all: floor 0%, and gardening seeded to add tests per feature
folder. Diff coverage still applies, so say that to the user.

## 6. Nothing is baselined

Every setup installs, and installs fully:

- **A linter**, with every rule in `AGENTS.md` written as a lint rule, so what
  the repo says in prose is also enforced.
- **A formatter**, run over the whole repo as one "format only" commit, exempt
  from the 20-file cap and listed in `.git-blame-ignore-revs` so blame stays
  useful.
- **Every rule candidate** from phase 1, de-duplicated, each verified in step 7.
- **The local correction hook**, on by default, so a correction the person makes
  in a local session becomes a candidate rule.

Then the setup **removes every existing violation**. Nothing is suppressed and
no `baselines.json` or `eslint-suppressions.json` is written: a baseline is a
promise to clean up later, and the factory then spends its first weeks
enforcing rules the repo itself breaks. Linter autofixes run first; what is
left is fixed by hand.

How the violations get fixed is your call, and you do not ask: one pull request
when the whole change stays reviewable, or a sequence of PRs (mechanical first,
then one per rule or feature folder) when it would not. Say which you chose and
why in one line.

## 7. Verify every rule

**Every rule must fail on its bad example and pass on its good one before you
install it.** The pack carries both; run the tool against both.

A rule that fires on both would block correct code. A rule that fires on
neither is decoration that costs a CI step. Neither is visible from reading the
config, which is exactly why this step exists and why it is not optional.

If a rule does not discriminate, do not install it, and say which and why. A
rule pack entry that cannot be verified is a bug in the pack.

## What to watch for

- **An enormous violation count is a finding, not a problem to hide.** Report
  the count and work through it. Do not loosen the rule to make the number look
  better, and do not baseline it.
- **Do not add a rule the repo's dominant pattern violates.** You would be
  enforcing your taste over their codebase, and every PR would fail.
- **A guardrail in an existing tool's config** (`pyproject.toml#tool.ruff`)
  must be listed in `policy.yaml` as a guardrail path, or nothing stops a
  product PR from editing it.
