# Build Software Factory — v1.0 Acceptance Report

Nov 21–22, 2026 · Claude

The nine v1.0 acceptance criteria from the Build Plan, with what is
established and how. A verdict is **met** only where it was seen happen on a
real repository; **logic proven** means the deciding code is tested but the
live event has not occurred; **partly** says which half is which.

## Where this stands

| # | Criterion | Verdict |
| --- | --- | --- |
| 1 | A scheduled review on a factory with 50+ runs routes every problem | **Partly**: routing is live on 5 real runs; there are not 50 |
| 2 | A degraded context file is caught, fixed and shown to improve over 3 repeats | **Logic proven**: no benchmark was paid for |
| 3 | A change that lowers the score or raises cost >20% is not proposed | **Logic proven** |
| 4 | The benchmark set includes corrected and escalated runs | **Logic proven** |
| 5 | The cost vs quality chart shows three configurations | **Logic proven**: no benchmark was paid for |
| 6 | Setup completes on every fixture repo, and the sandbox matches the app | **Met**: nine fixtures, and a sign-in app's sandbox repaired itself live (below) |
| 7 | Re-running the skill changes nothing unless asked | **Met** |
| 8 | A schema-major upgrade arrives as a Dependabot PR, then migrates | **Deferred** until the repository is public |
| 9 | On Philip's repo, three pipelines have each merged a PR | **Partly**: all three ran end to end; the sign-in sandbox is repaired, and the last verdict waits on GitHub Actions billing (below) |

Also proven live, and not a numbered criterion because it was added after the
plan was written: **the budget cannot be exceeded** (below).

1,229 runner tests pass on every push, with lint, typecheck, the schema freeze
and a gh-aw compile of every role workflow.

## The budget, and why the factory runs on Claude Code only

On Nov 21 the factory's $35 monthly cap turned out to count nothing: the
rollup wrote back the budget it had read, so spend never accumulated, and it
read the spend from a key nobody wrote. About $370 went on Opus across the
test fixtures that day before this was found. The budget was rebuilt as a
ceiling (doc 07, §Budget) and proven:

- **The cap it rests on works on Claude Code.** gh-aw's per-step credit cap,
  set to 2 credits: the proxy refused the agent's second request and it
  stopped at $0.061 (`bsf-fixtures/go-cli` run 44946845429).
- **It does not work on Cursor CLI.** The same 2-credit cap: 49 tool calls,
  about $0.58, 29 times the cap (run 44940807705). Cursor's requests go to
  Cursor's own servers, which gh-aw's proxy never sees. The factory therefore
  runs on Claude Code only.
- **A step that could pass the budget does not start.** A $0.01 budget
  refused the first step before its agent ran, and charged $0
  (run 44951031834).
- **What it charges is never below what was spent.** Across every agent and
  detection step on go-cli from 21:20 to 22:35 UTC, the real cost was $1.24
  and the factory charged $5.58; Philip's Anthropic console showed $1.30 for
  the window (the extra $0.06 is the cap test). Most of the gap was two bugs
  found during the proof and fixed: detection usage was not read, so each step
  was charged its full detection ceiling.
- **Work that cannot fit waits.** With most of a share held, queued work was
  left queued rather than started and refused ("waiting for budget"),
  repeatedly, on ts-webapp and trinsports.

## The criteria

### 1. A scheduled review routes every problem

**Partly.** The review ran end to end on `bsf-fixtures/ts-webapp`
(run 44968432870): it scored 5 real runs on every rubric criterion (50
scores), routed 3 problems (a context gap in `app/invoices`, seen 3 times, to
a definition change; "overclaimed" and "wrong scope" to hardening), filed
three work items and wrote `reviews/2026-11-22.json`. Getting there found and
fixed four bugs that only a real review could: the scorer was never given the
diffs (gh-aw's integrity filter rightly refuses the bot's own PRs, so the
runner now fetches them), it was never told its output format, the record
failed its own schema, and a review with no problems wrote no record.

Not met: fifty runs. ts-webapp has had about ten. The scorer still raises
gh-aw's "incomplete" signal when some criteria lack evidence, which turns the
job red although the review completes.

### 2. A degraded context file is caught, fixed and improves over 3 repeats

**Logic proven.** The scorers, task builder, admission rule, three-repeat
comparison and spread are built and tested (`benchmark.test.ts`,
`review.test.ts`). A benchmark run costs roughly $10–15 and was not paid for.

### 3. A change that lowers the score or raises cost >20% is not proposed

**Logic proven.** `admitDefinitionChange` refuses each case separately: a gain
inside the run-to-run spread, failure tasks that did not improve, a
regression, too few tasks or repeats, and a cost rise over 20%; a task that
stopped passing a check the reference merge passed vetoes the change whatever
the scores say.

### 4. The benchmark set includes corrected and escalated runs

**Logic proven.** `originOf`, `buildTasks` and the corrected-task rubric
(`benchmark.test.ts`).

### 5. The cost vs quality chart shows three configurations

**Logic proven.** The chart's arithmetic (`improvement.test.ts`); three
configurations need benchmark runs, as in 2.

### 6. Setup completes on every fixture repo

**Met.** Setup ran in Actions on all nine fixtures and each setup PR merged,
with the tier the trial measured:

| Fixture | Tier | Setup PR |
| --- | --- | --- |
| ts-webapp | renders | #8 |
| py-api | renders | #6 |
| js-legacy | renders | #17 |
| java-service | renders | #8 |
| csharp-api | renders | #10 |
| go-cli | build_and_test | #8 |
| rust-lib | build_and_test | #9 |
| ruby-app | build_and_test | #9 |
| polyglot-monorepo | build_and_test | #10 |

A product PR from the factory has merged on six of them (ts-webapp #19, py-api
#11, js-legacy #11, go-cli #15, java-service #13, csharp-api #17), and on
go-cli a full run from issue to a PR with every gate green ran under the new
budget (issue #30 → PR #32).

#### A sandbox that matches the app

A sandbox that renders the app is not enough when the app has pages behind
sign-in, a database and outside services. The manifest now lists each of those
as a dependency with a stand-in and a probe (a request to the running app that
only works if the stand-in does), and a `sign_in` command that mints a session
for a throwaway test user, since an agent's browser can reach the app and
nothing else. A trial round counts only if the tier is reached and every probe
passes; a sign-in that mints nothing is dropped and reported.

A role that cannot do its job on the sandbox files a report. The factory
repairs the sandbox from the report with no person involved: one amendment at a
time, up to two attempts per need, and one issue to the user if both fail.
`bsf sandbox land` merges an amendment itself when it changes only
`.factory/sandbox/`, adds no host or secret, and proves at least what main's
sandbox did. The stuck change is then brought up to date with main and
verified again.

**Seen live on trinsports** (Google sign-in, Postgres, Google Sheets, Resend),
with no person in the loop other than merging the factory's own upgrades:

1. Trinsports' verifier could not open any page behind sign-in and reported it.
2. The repair's first trial caught a design that could not work: the sign-in
   script was copied to the wrong folder, so every probe failed. The factory
   rejected the design itself. Fixed in the factory (stubs are replaced, not
   copied into).
3. The next trial minted a session and three probes passed (sign-in,
   Postgres, Google Sheets). The run then died on an over-long line in the
   agent's PR write-up. Fixed in the factory (text over a limit is cut; an
   unusable write-up no longer blocks a working repair).
4. The following run produced the same sandbox and the factory merged it as
   #41 on its own, then asked for the stuck change to be verified again.
5. That request, a label added by the factory's App, was refused at the
   verifier's checkout. Fixed in the factory (the stuck branch is updated from
   main, the push gh-aw allows).
6. The updated branch was verified in the repaired sandbox: the verifier's
   browser ran its full pass with no checkout error. The run's detection step
   then could not start: "recent account payments have failed or your spending
   limit needs to be increased" (GitHub Actions billing on the owner's
   account). That is outside the factory, and the verdict is pending it.

Two more things the live runs showed, both fixed: budget settle records were
lost to concurrent writers on the data ref (each write is now checked after it
lands and made again), and a change the sandbox could not judge was rebuilt
three times on the same broken sandbox (it is now held in review, with no
spend, until the repair lands).

### 7. Re-running the skill changes nothing unless asked

**Met.** Reinstalling the same version on all nine fixtures produced no change
("already at 964bffd"), and the installer keeps every definition file it finds
(`kept 22 existing file(s)`) unless `--force` is passed. Re-mine and repair
are covered by `skill.test.ts` and `doctor.test.ts`.

### 8. A schema-major upgrade arrives as a Dependabot PR

**Deferred.** Dependabot cannot watch a private repository's releases for this;
the alerts are to be set up when the repository is made public. The machinery
is built and frozen (`schema/SURFACE.json`, `bsf migrate`).

### 9. On Philip's repo, three pipelines have each merged a PR

**Partly.** On `ChampPhil/trinsports`:

- **Product work:** issue #12 (a team's current streak) → triage, an Opus
  spec, a build → PR #13, rebuilt on main as #17 after a conflict.
- **Gardening:** the nightly gardener, run once by hand → PR #16.
- **Hardening:** run end to end on `bsf-fixtures/ts-webapp` instead, where it
  could be shipped without another upgrade PR: an issue labelled
  `factory:harden` (#48, money must only be formatted through
  `lib/invoices`) → hardener → PR #53 with a lint rule, and PR #55 with the
  rule and its test, every gate green. Two PRs from one item was a bug, fixed:
  when the hardener opens its PR, spec and build are now skipped. The label
  itself was documented and never implemented; it is now.

Not met: nothing has merged on trinsports from these yet. The verifier could
not check its pages because every team page is behind Google sign-in; the
sandbox repair above fixes that, and the re-verification of the streak PR (#40)
is waiting on GitHub Actions billing, not on the factory.

Trinsports spent its $35 and then $50 budget getting here, most of it on Opus
specs, repair rounds and verifier runs that could not complete before the
fixes above; the budget cap held throughout.

## What is still needed

1. **GitHub Actions billing on the owner's account**, then the streak PR (#40)
   finishes its verification. Re-run the failed jobs of the last gates run.
2. **The repository made public**, then Dependabot alerts (criterion 8).
3. **Fifty runs** on one repository for criterion 1 as written, and a paid
   benchmark for 2 and 5, if wanted.
