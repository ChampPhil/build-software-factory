# Phase 4 — Clean the codebase

Cleanup is part of setup, not something deferred to the factory. The factory
starts from a repo that passes its own rules.

- **Mechanical fixes** (the formatter and linter autofixes) are one "format
  only" commit from phase 3.
- **Everything else** is fixed now, by you. There is no baseline, so there is
  nothing for gardening to burn down later.
- **One PR or a sequence**, your choice and not the person's: one when the whole
  change stays reviewable, a sequence when it would not (mechanical first, then
  one rule or one feature folder per PR). Each PR is gated like any other.
- **The target is pristine:** zero guardrail violations, one pattern per
  concern, every feature folder covered above the floor.
- Gardening still runs afterwards, for new drift: it opens up to the configured
  number of cleanup PRs a night, and each must lower a count and raise none.

## Doing it well

A cleanup PR a reviewer can judge is one problem class, in one place, with a
clear way to tell behaviour did not change. So:

- **One rule or one principle per PR** when you split.
- **At most 20 files** per PR outside the formatter commit.
- **Name the flows the verifier should compare** before and after. Cleanup
  changes no behaviour, and the evidence is a before-and-after of the flows the
  touched code serves.
- **Biggest rule first,** so the count the dashboard shows drops soonest.

## What to watch for

- **Do not fold a behaviour change into cleanup.** If a file cannot be cleaned
  without changing behaviour, that is a product work item: file it, say so, and
  leave the rule enforced.
- **Do not weaken a rule to finish.** A rule that cannot be satisfied is a
  finding to report, not something to switch off.
