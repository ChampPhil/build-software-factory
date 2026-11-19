# Phase 3 — Install guardrails

Build static rules and verification from the assessment, **extending the tools
the repo already runs** rather than replacing them. A repo with eslint gets its
eslint config extended. It does not get a second linter beside the first.

Output: `.factory/guardrails/` plus edits to existing tool configs, all inside
the setup PR.

## 1. Universal rules

From `rules/<language>.yaml`, each configured on a tool the repo already has:
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

## 6. Baselines

**Apply only mechanical fixes now.** The formatter runs over the whole repo as
one separate commit, exempt from the 20-file cap and listed in
`.git-blame-ignore-revs` so blame stays useful. Linters' own autofixes run too.

Everything else gets a **per-file** baseline: in the linter's own baseline file
where it has one (`eslint --suppress-all` writes `eslint-suppressions.json`),
otherwise in `baselines.json`. Per file, not per rule — a fix in one file must
not pay for a new violation in another.

Nothing that needs judgment is fixed here. The setup PR has to stay
reviewable.

## 7. Verify every rule

**Every rule must fail on its bad example and pass on its good one before you
install it.** The pack carries both; run the tool against both.

A rule that fires on both would block correct code. A rule that fires on
neither is decoration that costs a CI step. Neither is visible from reading the
config, which is exactly why this step exists and why it is not optional.

If a rule does not discriminate, do not install it, and say which and why. A
rule pack entry that cannot be verified is a bug in the pack.

## What to watch for

- **An enormous baseline is a finding, not a problem to hide.** Report the
  count. Do not loosen the rule to make the number look better; gardening
  exists for this.
- **Do not add a rule the repo's dominant pattern violates.** You would be
  enforcing your taste over their codebase, and every PR would fail.
- **A guardrail in an existing tool's config** (`pyproject.toml#tool.ruff`)
  must be listed in `policy.yaml` as a guardrail path, or nothing stops a
  product PR from editing it.
