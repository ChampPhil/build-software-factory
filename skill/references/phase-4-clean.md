# Phase 4 — Clean the codebase

These are your notes. The person does not hear a phase number, a file name,
the word freeze, or the word tier.

Cleanup is part of setup, not something deferred. Do not ask the person
whether to finish it. Do not offer to stop after the private copy.

`baselines.json` holds the current count for each installed rule. A cleanup
pull request lowers at least one count and raises none. Keep going until
every count is zero. An empty counts file while violations remain means
setup is not finished.

- **Format is its own commit.** It is not mixed into the lint fixes.
- **Lint fixes are the next** commit, or the next pull request.
- **Everything else** is fixed now, by you, until the counts are zero.
- **If one pull request would be unreviewable, name the sequence first**,
  then open them in that order. Format, then lint fixes, then one rule or
  one feature folder at a time. Say the sequence in one line before the
  first pull request. Each one is checked like any other.
- **The target is a clean tree:** zero violations, one pattern per concern,
  every feature folder covered at or above the floor. The floor is the
  coverage the suite measured. A floor of 0 while tests exist means this
  part is not done.
- Gardening still runs afterwards, for new drift. Each gardening pull
  request must lower at least one count and raise none.

The verification bar stays in the instructions the builder and the verifier
read on every change. Moving it to a side document so a size check passes
is a failed check. A new markdown file the request did not name fails.

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
