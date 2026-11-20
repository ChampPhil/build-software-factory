# Build Software Factory — v1.0 Acceptance Report

Nov 20, 2026 · Claude

The nine v1.0 acceptance criteria from the Build Plan, with what is actually
established and how. Read this with [the v0.1 report](11-acceptance-v0.1.md),
whose verdicts and their meanings this one reuses.

## Where this stands

**Two criteria are met in logic, three partly, four are blocked on a factory
that has run.** 919 runner tests and 75 dashboard tests, all passing; CI runs
them on every push, along with the gates and rule packs against the real
fixtures with the real tools.

The blocking is one thing, not four: **no factory has run a pipeline on a
repository yet.** Four of the nine criteria are statements about fifty runs, a
merged PR per pipeline, a review of real work, or a setup that completed. None
of those can be manufactured — a benchmark over invented runs would measure
nothing, and claiming otherwise would be the failure this report exists to
prevent.

What that needs is in [What is still needed](#what-is-still-needed) at the
end: it is short, and all of it is Philip's.

## The criteria

### 1. A scheduled review on a factory with 50+ runs routes every problem

**Partly.** The routing is proven; the fifty runs are not.

`review.test.ts` decides the same question the criterion asks, on the same
inputs: scores are grouped by tag and area; a problem a deterministic check
could catch routes to hardening; one the agent could not have known routes to
a definition change; an unrecognised tag defaults to hardening, which is the
cheaper mistake to make. Problem ids are stable across calls, so the same
problem in two reviews is one problem.

`reviewDue` is proven separately: it skips below the minimum run count however
long it has been, runs after the interval, and runs early when runs pile up.

What is unproven is the criterion's own setting — a real review over fifty
real runs, where the scores come from a grader rather than a fixture.

### 2. A degraded context file is caught, fixed, and shown to improve over 3 repeats

**Blocked.** This needs the model key and a factory that has produced enough
completed work to build benchmark tasks from. Every piece it is made of is
built and tested — the scorers, the task builder, the admission rule, the
three-repeat comparison and its spread — but the criterion is a claim about
what happens when they are pointed at a real degraded runbook, and that has
not happened.

### 3. A change that lowers the score or raises cost by more than 20% is not proposed

**Logic proven.** `review.test.ts` → `admitDefinitionChange` refuses each
case separately: a gain inside the run-to-run spread, failure tasks that did
not improve, anything else regressing, too few tasks, too few repeats, and a
cost rise over twenty per cent. `benchmark.test.ts` adds the veto that sits
above all of them: a task that stopped passing a check the reference merge
passed refuses the change whatever the scores say, and a check that was
already failing does not veto.

The one that matters most is the first. A change whose number went up by less
than the noise has not been shown to be better, and the Improvement page
labels that "no clear winner" rather than a win.

### 4. The benchmark set includes corrected and escalated runs, graded against the human's fix

**Logic proven.** `benchmark.test.ts` → `originOf` tells a clean run from one
a human had to fix and prefers an explicit mark over what the run did;
`buildTasks` skips a run that is already a task, one with nothing to grade
against, and one with no base commit; and a corrected task's rubric names what
went wrong last time and says it has not passed, which a clean task's rubric
does not.

### 5. The cost vs quality chart shows three configurations, current one marked

**Partly.** The chart is built and its arithmetic is proven; three real
configurations are not, because no benchmark has run.

`improvement.test.ts` covers what the chart has to get right: one point per
configuration rather than one per side, so a configuration measured in two
comparisons is one point and the newest measurement wins; the frontier marks
every point nothing beats for the money; a side with no models recorded falls
back to its label. `benchmark.test.ts` covers the numbers behind a point,
including that the spread is how much the score moves between repeats — drawn
through each point, so a number that wobbles cannot be read as precise.

`bsf benchmark run` now persists the comparison, which is what makes three
configurations accumulate at all; before this they existed only in a CI log.

### 6. Setup completes on every fixture repo, all eight languages and the monorepo

**Blocked, and the fixtures are ready.** All eight rule packs exist; five are
verified by running the real tool (eslint, ruff, clippy, go vet, javac) and
three are `documented_not_run` where the toolchain could not be installed
here, which the packs say rather than imply. Data-flow rules run live on CI
through Semgrep.

All eight fixture repos now exist, each with its own CI: `ts-webapp`,
`py-api`, `js-legacy`, `go-cli`, `java-service`, `rust-lib`, `csharp-api`,
`ruby-app`, plus `polyglot-monorepo`. `rust-lib` builds, tests and lints clean
here; `ruby-app`'s tests pass here and its lint runs on CI; `csharp-api` is
honest that it has not been built here at all.

What is missing is running the setup skill against them, which needs Docker
and a machine that is not this container.

### 7. Re-running the skill changes nothing unless the user picks re-mine or repair

**Partly.** The two modes are built; the claim about a full re-run is not
tested end to end.

`bsf doctor` is the diagnosis the skill's repair mode is required to do before
touching anything: it reports a missing definition, role, context or rubric
file, a guardrail file that no longer validates, a missing workflow, a lock
file too stale for gh-aw to run and — with `--repo` — a missing secret or
variable. It changes nothing, and `doctor.test.ts` proves that against a
factory installed from the templates, then against six separate breakages.

`bsf mine-corrections --merge-into` is re-mine: `skill.test.ts` runs it twice
over a real git repository and shows that a candidate the user rejected is not
offered again.

### 8. A schema-major upgrade arrives as a Dependabot PR, then a definition PR migrates the config

**Blocked on a release.** The machinery is built and frozen: schema 1.0 is
recorded in `schema/SURFACE.json`, `bsf schema-surface --check` fails a
breaking change and names it, `bsf migrate` writes migrated files beside the
originals and never over them, and `bsf migrate --support` prints what the
runner reads and writes. There is no second major to migrate to yet, which is
the point of a freeze rather than a gap in it.

### 9. On Philip's old repo, three pipelines have each merged a PR

**Blocked.** This is the criterion the others serve, and it needs the factory
installed and running on `ChampPhil/trinsports`.

One thing worth saying about that repository now, because it bears on the
first thing the factory would do there: `npm run build` runs `db:migrate`, and
`drizzle.config.ts` loads `.env.local`. Anything running the documented build
command on a machine with that file present migrates the real Neon dev
branch. That is worth guarding before an agent ever runs it.

## What is still needed

Everything below is Philip's; none of it can be done from here.

1. **Install the factory App on the repositories it should act on** —
   `bsf-fixtures/*`, `ChampPhil/trinsports`. The App exists; whether it is
   installed cannot be checked from here, because the endpoint that would say
   needs the App's own credentials.
2. **Run setup on a machine with Docker.** Phase 2 builds the sandbox and
   proves the app runs inside it; without that there is no runtime
   verification, and the skill stops rather than installing a factory that
   cannot verify its own work.
3. **Delete five leftover probe branches** that the proxy here refuses to
   remove: `probe-branch`, `factory/probe-policy`, `factory/probe-clean`,
   `factory/probe-testedit` on `bsf-fixtures/ts-webapp`, and
   `probe/write-test` on `build-software-factory`. Plus
   `factory/corrections-champphil-2026-11-20-8fc06a`, left behind when a
   contribution's branch pushed and its pull request then failed.
4. **The App's login is no longer a variable.** The workflows that need it
   pass the token step's own `app-slug`, so renaming the App cannot leave a
   stale login behind.

Once the App is installed and setup has run once, criteria 1, 2, 5, 6, 7 and 9
become measurable rather than blocked, and this report can be finished with
evidence rather than with reasons.
