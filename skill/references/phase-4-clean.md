# Phase 4 — Clean the codebase

Phases run in order, with one exception: cleanup is allowed to finish after
switch-on, as the factory's first gardening runs.

- **Mechanical fixes** are already in the setup PR from phase 3.
- **Everything else** is baselined, and seeded as gardening work items: one per
  rule, or one per feature folder for a large rule, ordered by most violations
  first.
- After switch-on, nightly gardening opens up to the configured number of
  cleanup PRs a night. **Each must lower its rule's count and raise no count in
  any file.** At zero, a rule's baseline is retired.
- **The target is pristine:** zero guardrail violations, one pattern per
  concern, every feature folder covered above the floor.
- The dashboard shows progress per rule — count now against count at setup —
  until every baseline is retired.

## Seeding the work well

A gardening item a builder can finish is one problem class, in one place, with
a clear way to tell behaviour did not change. So:

- **One rule or one principle per item.** A PR that cleans two things is a PR a
  reviewer cannot judge.
- **At most 20 files**, and split a large rule by feature folder.
- **Name the flows the verifier should compare** before and after. Gardening
  changes no behaviour, and the evidence for that claim is a before-and-after
  of the flows the touched code serves.
- **Order by violations descending.** The biggest baseline first means the
  count the dashboard shows moves soonest.

## What to watch for

- **Do not seed work an open PR already fixes.** The ledger records what each
  open run is fixing; gardening skips those.
- **Do not fold a behaviour change into cleanup.** If a file cannot be cleaned
  without changing behaviour, that is a product work item, and say so.
