# Phase 3 — Install guardrails

These are your notes. The person does not hear a phase number, a file name,
the word freeze, or the word tier.

Build static rules and verification from the assessment, **extending the tools
the repo already runs** rather than replacing them. A repo with eslint gets its
eslint config extended. It does not get a second linter beside the first.

During setup this is the factory's standard pack only. Each rule must fail on
a bad example and pass on a good one. Rules taken from this repo's own
patterns, or from past corrections, are a later pass. They are not part of
this install.

A note that says to add no tools does not cancel this part. Do not skip the
linter install, the format commit, the proof of each rule, or the cleanup.

Output: `.factory/guardrails/` plus edits to existing tool configs, all inside
the setup PR.

## 0. When the repo has no tools at all

"Extend what is there" has nothing to extend in a repo with no linter, no
formatter and no test runner — a hand-written page with its libraries on a CDN,
which is a very common thing to find. The first live install was exactly this,
and the result was a factory with no rules installed. The gates passed because
they had nothing to check, and every change went through on an agent's word.

That is worse than no guardrails, because it looks like guardrails. So when the
dominant language has no tool present, install a minimum one as part of the
setup PR, and say in the PR that you did and why:

- **JavaScript or TypeScript** — a `package.json` if there is none, with eslint
  and prettier as devDependencies and `lint` and `format` scripts, then the
  universal rules below configured on them.
- **Python** — ruff, with `lint` and `format` entry points.
- **Anything else** — the standard formatter and linter for that language, or,
  if there is genuinely none, say so in the setup PR. If tests exist, the
  coverage floor is the coverage the suite measured. A floor of 0 while tests
  exist means this part is not done. With no tests at all, the floor is 0
  because that is what was measured. Do not pretend a suite ran.

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

The folder shape you enforce is the shape the repository already has. One
folder per feature, with dependency-graph checks between feature folders,
only where the codebase already leans that way. Imposing a structure the
repository does not have is a refactor, not a guardrail.

## 4. Accepted candidates

Each becomes whatever the ordered check chose: an API change (queued as a
cleanup pull request), a static rule, a verification scenario added to the
runbook and test suite, or a context line. You install it. An add-the-rule
card is not the install path. A candidate left pending means setup is not
finished.

Every do-not, must, never, and always, and every mined correction, is
installed as a check. A bad example fails. A good example passes.

Candidates flagged `critical_logic` — money, permissions, concurrency — get
a property check generated from that code and run as a gate. That property
check is the formal bar. Do not claim a mathematical proof of the whole
program is installed. A kind of check that cannot yet fail a pull request
is not installed.

## 5. Coverage

The test command is the repository's own suite. Deselecting or ignoring tests
to go green means this part is not done.

Record the current total as the high mark. The floor is the coverage the
suite measured. When that number is above zero, set the floor one point below
it. Set the diff minimum to 80% (this is the main check), and count existing
skips.

With no tests at all: floor 0%, and gardening seeded to add tests per feature
folder. Diff coverage still applies, so say that to the person in everyday
words. If tests exist, a floor of 0 means this part is not done.

## 6. Record the counts, then clean to zero

Write `baselines.json` with the current count for each installed rule. That
file is the record of how many violations each rule still has. It is not
permission to leave a violation in place.

A cleanup pull request lowers at least one count and raises none. Keep going
until every count is zero. An empty `baselines.json`, or a file with no
counts, while the repository still has violations, means setup is not
finished.

Do not hide violations in `eslint-suppressions.json`.

Every setup installs, and installs fully:

- **A linter**, with every rule in `AGENTS.md` written as a lint rule, so what
  the repo says in prose is also enforced. Every do-not, must, never, and
  always, and every mined correction, is one of those checks.
- **A formatter.** Format is its own commit, exempt from the 20-file cap and
  listed in `.git-blame-ignore-revs` so blame stays useful. Lint fixes are
  the next commit, or the next pull request. Do not mix a repo-wide format
  into the same pull request as the lint fixes.
- **Every rule candidate** from the assessment, de-duplicated, each verified
  in step 7. A candidate left pending means setup is not finished. An
  add-the-rule card is not the install path.
- **The local correction hook**, on by default, so a correction the person makes
  in a local session becomes a candidate rule.

Then the setup removes every existing violation. Linter autofixes run after
the format commit. What is left is fixed by hand, until the counts are zero.

How the violations get fixed is your call, and you do not ask. If one pull
request would be unreviewable, name the sequence first, then open them in
that order: the format commit, then the lint fixes, then one rule or one
feature folder at a time. Say the sequence in one line before you open the
first.

The verification bar stays in the instructions the builder and the verifier
read on every change. Moving that bar into a side document so a size check
passes is a failed check. A new markdown file the request did not name fails.

## 7. Verify every rule

**Every rule must fail on its bad example and pass on its good one before you
install it.** The pack carries both. Run the tool against both. This includes
every do-not, must, never, and always, and every mined correction, not only
the pack's built-in rules.

A rule that fires on both would block correct code. A rule that fires on
neither is decoration that costs a CI step. Neither is visible from reading the
config, which is exactly why this step exists and why it is not optional.

If a rule does not discriminate, do not install it, and say which and why. A
rule pack entry that cannot be verified is a bug in the pack. A candidate you
could not prove is not left pending. Pending means setup is not finished.

## What to watch for

- **An enormous violation count is a finding, not a problem to hide.** Record
  the count and work through it until the count is zero. Do not loosen the
  rule to make the number look better.
- **Do not add a rule the repo's dominant pattern violates.** You would be
  enforcing your taste over their codebase, and every PR would fail.
- **A guardrail in an existing tool's config** (`pyproject.toml#tool.ruff`)
  must be listed in `policy.yaml` as a guardrail path, or nothing stops a
  product PR from editing it.
