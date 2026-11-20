# Build Software Factory — v0.1 Acceptance Report

Nov 19, 2026 · Claude

Every v0.1 acceptance criterion from the Build Plan, with what was actually
established and how. Revised as the build progressed; the first version of
this report is in git history.

## How to read the verdicts

**No criterion is fully met.** Every one of the 23 is ultimately a statement
about behaviour on GitHub, and no factory has run: there is no GitHub App, so
nothing can act on a repo. What exists is the whole deterministic half of
v0.1 — plus the dashboard, the skill, the adapters and the Worker — with its
correctness decided locally rather than asserted.

| Verdict | What it means |
| --- | --- |
| **Logic proven** | A test decides the same question the criterion asks, on the same inputs, and passes. The decision is right. What is unproven is the wiring that puts it behind a real GitHub check. |
| **Design verified** | The configuration or code the criterion depends on is asserted in a test, but the runtime behaviour belongs to gh-aw, to GitHub, or to a browser, and was not exercised. |
| **Blocked** | Cannot be established at all yet, with the reason. |

Of the 23: **12 logic proven, 7 design verified, 1 partly proven (21), 3
blocked.** 501 tests, all passing; run with `npm test` in `/runner`.

The two half-criteria are counted with their main verdict and noted in place:
criterion 5 is proven on its policy half and design-verified on its structural
half, and 19 is proven on the fallback queue and blocked on the native one.

| Test file | Tests | Test file | Tests |
| --- | --- | --- | --- |
| `templates.test.ts` | 86 | `policy.test.ts` | 28 |
| `rulepack.test.ts` | 51 | `queue-rollup.test.ts` | 25 |
| `gates.test.ts` | 37 | `policy-run.test.ts` | 24 |
| `skill.test.ts` | 37 | `gates-run.test.ts` | 19 |
| `schema.test.ts` | 36 | `worker.test.ts` | 19 |
| `intake.test.ts` | 28 | `adapters.test.ts` | 18 |
| `review.test.ts` | 17 | `session.test.ts` | 16 |
| `create-app.test.ts` | 16 | `ghaw-frontmatter.test.ts` | 13 |
| `run-plan.test.ts` | 11 | `garden.test.ts` | 7 |
| `step-report.test.ts` | 7 | `audit.test.ts` | 6 |

## What blocks the three, and what no longer does

**Still blocking, and both need Philip:**

1. **No GitHub App.** Nothing can act on a repo without it. The script that
   creates it is built and tested (`create-app.test.ts`, 16 tests); it needs
   someone to approve the manifest in a browser, which is not a step that can
   be automated away.
2. **Setup runs on the user's machine by design.** The skill mines local agent
   sessions for corrections, which only exist there.

**What this session's write access turned out to allow.** Pushing branches,
opening and closing pull requests, creating labels and issues all work.
Creating or updating a ref under `refs/factory/*` does not, by either route —
the Git Data API and `git push` are both refused by the proxy — and neither
does writing branch protection, or *deleting* a branch. So the deterministic
commands could be run against real pull requests on a real repository, which
is what the "proven against GitHub" rows below mean, while anything that
writes the data refs or repository settings stayed local.

**No longer blocking** — these were in the first version of this report:

- *The dashboard is not built.* It is: nine pages, static export, reads GitHub
  directly. Criteria 18, 20 and 22 move from blocked to design verified.
- *The skill's phase scripts are not built.* They are: four scripts and seven
  phase references, 37 tests. Criterion 1 moves to design verified.
- *The scheduled workflows don't exist.* All eleven trigger workflows exist
  now, including the three that legitimately run on a timer. Criterion 16's
  verification is correspondingly sharper.
- *`gh aw compile` can't run, so the role workflows are unverified.* Still
  true of the compiler, but the gap is now covered two ways: the frontmatter
  is validated against gh-aw's own schema in the test suite — which caught
  four real bugs — and `bsf audit` detects a lock file that no longer matches
  its source, using gh-aw's own hash implementation, verified against a real
  gh-aw workflow and lock file pair.

Two session limits still shaped what could be checked: no Docker daemon, so
the sandbox could not be built or run; and `refs/factory/*` cannot be created
from here, so the data-ref layer is tested against its logic rather than
against a live ref.

**The three fixtures are live.** `bsf-fixtures/ts-webapp`, `py-api` and
`js-legacy` are pushed, public, and their own CI passes on GitHub's runners —
not only locally. `ts-webapp` and `py-api` each carry a deliberately
`on: push` workflow, which is the fixture criterion 7 needs, and each has
exactly one CI run so far: a clean baseline for the moment a factory write
can be made and the count has to stay where it is.

## The criteria

### Logic proven (12, plus 21 partly)

| # | Criterion | Evidence |
| --- | --- | --- |
| 3 | An issue from an untrusted account starts nothing until `factory:accept` is added | `intake.test.ts` — the item is left `waiting_trust`; its text is stripped from prompts while it waits; the label admits it; an integration's bot is treated as outside however its association reads; a fork event starts nothing |
| 4 | A PR that edits `.factory/definition/` from the product pipeline fails `factory/policy` | `policy.test.ts` — fails naming the files, and still fails *with* a human approval, because the product pipeline may never change the definition. **Also run against a real PR**: `bsf policy --pr 1` on `bsf-fixtures/ts-webapp`, labelled `factory:product-work`, exited 1 with "The product_work pipeline may not change the factory definition: .factory/definition/policy.yaml" |
| 5 | A fork PR that edits `factory-gates.yml` to always pass still fails and can't merge without approval | `policy.test.ts` — fails on both the protected path and on being a fork, and is not cleared by an approval from an untrusted author. **The protected-path half also run against a real PR**: the same PR above, which edited `.github/workflows/ci.yml`, failed with `protected_path`. The fork half and the structural half stay test-only — a fork PR needs a second account, and approving one's own PR is not something GitHub allows |
| 6 | Ten issues opened within one minute each become a work item; none is lost | `intake.test.ts` — all ten become items in one run; a second run after a dropped one picks up all seven it missed; events at or below the cursor are never processed twice; out-of-order arrival is handled in id order |
| 8 | A human PR that's behind main can't merge until it's updated and re-checked | `queue-rollup.test.ts` — blocked while behind main, blocked when the gates passed on an older commit, allowed once both hold |
| 9 | A cancelled run doesn't stall the queue: the next rollup dispatches the next queued item | `queue-rollup.test.ts` — a rollup following a cancelled run dispatches both queued items; dispatches nothing when every slot is busy, and says why |
| 10 | A PR that raises a baseline or lowers the coverage floor fails the weakening check | `gates.test.ts` — all seven weakening kinds, including a per-file raise whose rule total stays level, a lowered diff minimum, a raised skip cap, and a retired rule given a baseline again. Lowering a count and raising the floor stay allowed for every pipeline |
| 11 | A product PR that adds no violations passes the ratchet; one that fixes one in one file and adds one in another fails | `gates.test.ts` — the second case fails *because* counts are per file, even though the rule's total is unchanged |
| 12 | A factory PR that edits an existing test not listed in its spec fails `factory/policy` | `policy.test.ts` — fails undeclared, passes declared, and a new test file is always allowed. **Also run against two real PRs** on `bsf-fixtures/ts-webapp`: one editing `lib/invoices.test.ts` failed with `undeclared_test_edit`; the control — a source change plus a *new* test file — passed, so the rule is not simply failing everything |
| 13 | A human PR runs only the deterministic gates and spends nothing on models; `factory:verify` runs agent verification | `gates.test.ts` — `planGates` returns `agentVerification: false` for a human PR and `true` once labelled |
| 14 | A draft PR's gates run once per commit | `gates.test.ts` — a commit already checked runs nothing; only a missing gate runs; a new commit runs both |
| 19 | Two approved PRs that each pass alone but break the build together never both land | `queue-rollup.test.ts` — the queue merges the head, then the second is behind main and must update and be re-checked against the main that now contains the first. **Fallback queue only**; the native merge-queue half is blocked |
| 21 | Cost per run is within 5% of billed usage | **Partly.** The 5% comparison needs real runs and a real bill, so the number is unproven. What is proven is the thing that would make it meaningless: `session.test.ts` and `step-report.test.ts` — gh-aw's normalized session is preferred over the harness's self-report, camelCase and snake_case token aliases count once rather than twice, a reported cost of zero is kept as a measurement, and an *un*reported cost is `unknown` rather than zero. A factory that invented zeros would hit 5% by accident |
| — | *(not a numbered criterion)* A compiled role workflow that no longer matches its source is detected | `audit.test.ts` — against a real gh-aw workflow and its real lock file: clean when unmodified, caught on a body edit, caught on a frontmatter edit, reported when never compiled. Included because the criteria assume the workflow that runs is the workflow that was reviewed |
| — | *(not a numbered criterion)* Something that reached main without passing the gates is detected afterwards | `bsf audit` run against two real commits on `bsf-fixtures/ts-webapp`: on main's own commit it reported `direct_push` — correctly, that commit was pushed straight to main — and on a pull request's head commit the `direct_push` finding was absent, so the two cases are distinguished against the live API rather than against a stub. Both correctly reported that no factory check had run, which is also true |
| — | *(not a numbered criterion)* The event normalizer reads GitHub's real payload shape | `normalizeEvent` run on a real `issues` payload built from a real issue: owner association, not-a-bot, title, body, `#number` and labels all read correctly. This is the part of intake where an invented field name would fail silently in production and pass every unit test |

Three of these encode a judgement rather than just a check:

- **The ratchet reads a rule missing from "after" as zero everywhere, never as
  unchanged.** So deleting a rule's baseline entry cannot read as a pass — it
  reads as a large improvement, and the weakening check is what catches the
  removal. Both halves are tested together, because either alone is a hole.
- **An approval does not carry from an older commit.** The criteria don't ask
  for this; GitHub's own review model allows it, and it would let an approved
  PR be rewritten before merge.
- **An unknown cost is never written as zero.** The budget pauses pipelines on
  spend, so a fabricated zero quietly raises the ceiling on what the factory
  may spend. gh-aw's session specification states the same rule independently.

### Design verified (7)

| # | Criterion | What was verified, and what wasn't |
| --- | --- | --- |
| 1 | The skill completes setup on each of the three v0.1 fixtures | `skill.test.ts` (37 tests) asserts the phase structure, every user action the Setup Skill Spec lists and no others, the preflight checks, the App-manifest flow, and the spend estimate. The three fixtures are built and verified locally. What is unverified is a real run end to end, which needs the App and a push to `bsf-fixtures` |
| 5 | (structural half) A PR cannot change the check that judges it | `templates.test.ts` asserts `factory-policy.yml` runs on `pull_request_target` and not `pull_request`, and checks out the default branch with `persist-credentials: false`. That GitHub then uses main's copy is GitHub's documented behaviour, not something a test here can show |
| 7 | A full factory run starts none of a repo's `on: push` CI | The design is right: `refs/factory/data`, `refs/factory/media` and `refs/factory/live/*` sit outside `refs/heads/`, and a push to a non-branch ref fires no `push` workflow. **The control is now established**: `bsf-fixtures/ts-webapp` and `py-api` carry a deliberately `on: push` workflow which has run and passed, so the CI is live and reactive, and each repo sits at exactly one run. What could not be done is the treatment — creating `refs/factory/data` was refused by both the Git Data API and `git push` — so the count could not be shown to stay at one. (`trinsports` still has no `.github/workflows/` at all, which is why the fixture matters) |
| 15 | The agent has no write token, can't leave the firewall allowlist, and threat detection blocks a planted secret | `templates.test.ts` asserts, for all seven roles: every `permissions:` scope is `read`, a `network.allowed` list is present, the sandbox is `awf`, threat detection is enabled, and only the builder and hardener can open or push a PR. `ghaw-frontmatter.test.ts` validates all seven against gh-aw's own schema. That those controls hold at runtime is gh-aw's behaviour; the planted-secret test needs a live run |
| 16 | An idle factory uses under 15 Actions minutes a day | `templates.test.ts` asserts that exactly three workflows run on a timer, and that they are nightly gardening, the daily review check and the daily rollup sweep — the three doc 07 names and no others. Each is also startable by hand, so none needs a day's wait to test. The minutes themselves are unmeasured; the estimate script puts an idle day at well under 15, and the review check exits on `bsf review due` before spending anything |
| 18, 20, 22 | The Live view's step/gate/cost within 10 s; a run file shown within 60 s; auto-merge from the dashboard opens a definition PR | The dashboard is built: nine pages, static export, reading GitHub directly, with the refresh intervals doc 08 specifies (5 s on Live, 15 s on the ledger, 60 s on the index). Every file it reads is validated against the shared schemas, so a run file it cannot show is a schema failure rather than a blank page. What is unverified is the latency, which needs a running factory, and the round trip of criterion 22, which needs the App |

### Blocked (3, plus the native half of 19)

| # | Criterion | Blocked by |
| --- | --- | --- |
| 2 | A trusted user's issue produces a draft PR with screenshots, on all three fixtures | GitHub App. The fixtures themselves are no longer a blocker: all three are live with passing CI |
| 17 | A new runner release produces an upgrade PR without anyone acting | Needs the runner published as a tagged Action and a release for Dependabot to see. The *policy* for upgrade PRs is proven (`policy.test.ts`: scoped to the pin, never merged without a trusted human) |
| 19 | (native half) The same, on a fixture using GitHub's native merge queue | The fixture exists and qualifies — `bsf-fixtures/ts-webapp` is an org-owned public repo, where the native merge queue is available on Free. What is missing is the branch protection that turns it on, and writing branch protection is refused from here |
| 23 | The factory is set up on Philip's old repo, and a real issue becomes a verified draft PR | GitHub App; setup runs on his machine |

## v0.2 and v1.0

v0.2's scope is now largely built ahead of its gate, because the eleven
workflows needed their commands: gardening, hardening and conflict resolution
have their runner commands and templates, the four extra harness adapters
exist (marked unverified), the budget shares work, and the dashboard's
Guardrails, Work items and Sessions pages and the sign-in Worker are done.
Two v0.2 criteria are proven early:

- *When gardening's budget share is used, gardening pauses while product work
  continues, up to 110% of the total* — `queue-rollup.test.ts`, five tests,
  including the minutes limit and its absence on public repos.
- *Gardening files nothing a PR already fixes* — `garden.test.ts`, via the
  ledger's `fixes` list, with the per-PR file cap applied at filing time.

v1.0's review loop has its deterministic half: `review.test.ts` proves the
scheduling thresholds, the grouping and routing of problems, and the
benchmark admission rule — including the one that matters, that a gain inside
the run-to-run spread is refused.

What none of this changes: the gates for v0.2 and v1.0 are statements about
behaviour on GitHub, like v0.1's, and they are behind the same three blockers.

## What was found about `trinsports`

A phase-1 assessment of the real target, which changes what setup will do
there:

- **No CI at all** — no `.github/workflows/`. So `existing_ci.test_check` is
  `null` and the factory runs the tests itself, without touching any team CI.
  It also means criterion 7 has no fixture in this repo.
- **No tests at all** — no test runner, no test script, no test files. The
  skill's documented no-tests path applies: coverage floor 0%, and gardening
  seeded to add tests per feature folder, most-changed first. Note the
  consequence: diff coverage at 80% is the main check from the first PR, so
  the first product-work PR has to arrive with tests, from zero.
- **`npm run build` needs a live Postgres.** `build` runs `db:migrate` first,
  and `drizzle.config.ts` loads `.env.local`, so running the documented build
  command on a machine where that file exists migrates the real Neon dev
  branch. The runbook template now carries a "commands that change persistent
  state" table and states that the sandbox inherits no developer environment
  and reads no `.env` file, so this class of hazard is written down for every
  repo rather than remembered for this one.
- **Actions minutes are the binding constraint, not model spend.** The
  estimate script on `trinsports` puts nightly gardening at 5 PRs around
  2,466 Actions minutes a month against the 2,000 a private Free-plan repo
  includes, so setup lowers the nightly cap to 1 there.
