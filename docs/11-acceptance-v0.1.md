# Build Software Factory — v0.1 Acceptance Report

Nov 19, 2026 · Claude

Every v0.1 acceptance criterion from the Build Plan, with what was actually
established and how.

## How to read the verdicts

**No criterion is fully met.** Every one of the 23 is ultimately a statement
about behavior on GitHub, and no factory has run: there is no GitHub App, so
nothing can act on a repo. What exists is the deterministic half of v0.1, with
its correctness decided locally rather than asserted. So the verdicts are:

| Verdict | What it means |
| --- | --- |
| **Logic proven** | A test decides the same question the criterion asks, on the same inputs, and passes. The decision is right. What is unproven is the wiring that puts it behind a real GitHub check. |
| **Design verified** | The configuration the criterion depends on is asserted in a test, but the runtime behavior belongs to gh-aw or to GitHub and was not exercised. |
| **Blocked** | Cannot be established at all yet, with the reason. |

11 logic proven, 4 design verified, 8 blocked. 222 tests, all passing; run with
`npm test`.

## What blocks the eight

Four distinct blockers, three of which need Philip.

1. **No GitHub App** (needs Philip: two clicks). Nothing can act on a repo
   without it, so every end-to-end criterion is behind this one.
2. **Can't push to `bsf-fixtures`** (needs Philip: install the Claude GitHub
   App on that org). Read works; push is refused.
3. **The fixtures are empty.** `bsf-fixtures/ts-webapp` and
   `ChampPhil/bsf-private-repo-on-github-free-fixture` each hold a README and
   nothing else. `py-api` and `js-legacy` do not exist and cannot be created
   from this session. The three v0.1 fixtures have to be built before any
   criterion can run on them.
4. **The dashboard and the setup skill are not built.** Three criteria are
   about the dashboard, two about the skill.

Two session limits also shaped what could be checked: no Docker daemon, so the
sandbox could not be built or run; and gh-aw's Go toolchain and release
binaries are both blocked by the egress policy, so `gh aw compile` never ran
and the role workflows are unverified against the real compiler.

## The criteria

### Logic proven (11)

| # | Criterion | Evidence |
| --- | --- | --- |
| 3 | An issue from an untrusted account starts nothing until `factory:accept` is added | `intake.test.ts` — 5 tests: the item is left `waiting_trust`; its text is stripped from prompts while it waits; the label admits it; an integration's bot is treated as outside however its association reads; a fork event starts nothing |
| 4 | A PR that edits `.factory/definition/` from the product pipeline fails `factory/policy` | `policy.test.ts` — fails naming the files, and still fails *with* a human approval, because the product pipeline may never change the definition |
| 5 | A fork PR that edits `factory-gates.yml` to always pass still fails and can't merge without approval | `policy.test.ts` — fails on both the protected path and on being a fork, and is not cleared by an approval from an untrusted author. The structural half is #5 under Design verified |
| 6 | Ten issues opened within one minute each become a work item; none is lost | `intake.test.ts` — all ten become items in one run; a second run after a dropped one picks up all seven it missed; events at or below the cursor are never processed twice; out-of-order arrival is handled in id order |
| 8 | A human PR that's behind main can't merge until it's updated and re-checked | `queue-rollup.test.ts` — blocked while behind main, blocked when the gates passed on an older commit, allowed once both hold |
| 9 | A cancelled run doesn't stall the queue: the next rollup dispatches the next queued item | `queue-rollup.test.ts` — a rollup following a cancelled run dispatches both queued items; dispatches nothing when every slot is busy, and says why |
| 10 | A PR that raises a baseline or lowers the coverage floor fails the weakening check | `gates.test.ts` — all seven weakening kinds, including a per-file raise whose rule total stays level, a lowered diff minimum, a raised skip cap, and a retired rule given a baseline again. Lowering a count and raising the floor stay allowed for every pipeline |
| 11 | A product PR that adds no violations passes the ratchet; one that fixes one in one file and adds one in another fails | `gates.test.ts` — the second case fails *because* counts are per file, even though the rule's total is unchanged |
| 12 | A factory PR that edits an existing test not listed in its spec fails `factory/policy` | `policy.test.ts` — fails undeclared, passes declared, and a new test file is always allowed |
| 13 | A human PR runs only the deterministic gates and spends nothing on models; `factory:verify` runs agent verification | `gates.test.ts` — `planGates` returns `agentVerification: false` for a human PR and `true` once labelled |
| 14 | A draft PR's gates run once per commit | `gates.test.ts` — a commit already checked runs nothing; only a missing gate runs; a new commit runs both |
| 19 | Two approved PRs that each pass alone but break the build together never both land | `queue-rollup.test.ts` — the queue merges the head, then the second is behind main and must update and be re-checked against the main that now contains the first. **Fallback queue only**; the native merge-queue half is blocked |

Two of these are worth a note, because the tests encode a judgement rather than
just a check:

- **The ratchet reads a rule missing from "after" as zero everywhere, never as
  unchanged.** So deleting a rule's baseline entry cannot read as a pass — it
  reads as a large improvement, and the weakening check is what catches the
  removal. Both halves are tested together, because either alone is a hole.
- **An approval does not carry from an older commit.** The criteria don't ask
  for this; GitHub's own review model allows it, and it would let an approved
  PR be rewritten before merge.

### Design verified (4)

| # | Criterion | What was verified, and what wasn't |
| --- | --- | --- |
| 5 | (structural half) A PR cannot change the check that judges it | `templates.test.ts` asserts `factory-policy.yml` runs on `pull_request_target` and not `pull_request`, and checks out the default branch with `persist-credentials: false`. That GitHub then uses main's copy is GitHub's documented behavior, not something a test here can show |
| 7 | A full factory run starts none of a repo's `on: push` CI | The design is right: `refs/factory/data`, `refs/factory/media` and `refs/factory/live/*` sit outside `refs/heads/`, and a push to a non-branch ref fires no `push` workflow. Unverified, and there is no fixture for it — `trinsports` has no `.github/workflows/` at all |
| 15 | The agent has no write token, can't leave the firewall allowlist, and threat detection blocks a planted secret | `templates.test.ts` asserts, for all seven roles: every `permissions:` scope is `read`, a `network.allowed` list is present, the sandbox is `awf`, threat detection is enabled, and only the builder and hardener can open or push a PR. That those controls then hold at runtime is gh-aw's behavior; the planted-secret test needs a live run |
| 16 | An idle factory uses under 15 Actions minutes a day | `templates.test.ts` asserts no trigger workflow runs on a schedule. The three that legitimately do — nightly gardening, the daily review check, the daily rollup sweep — are not built yet, and nothing has been measured |

### Blocked (8)

| # | Criterion | Blocked by |
| --- | --- | --- |
| 1 | The skill completes setup on each of the three v0.1 fixtures | The skill's phase scripts are not built; the fixtures are empty; setup runs on Philip's machine by design |
| 2 | A trusted user's issue produces a draft PR with screenshots, on all three fixtures | GitHub App; empty fixtures; `bsf-fixtures` push refused |
| 17 | A new runner release produces an upgrade PR without anyone acting | Needs the runner published as a tagged Action and a release for Dependabot to see. The *policy* for upgrade PRs is proven (`policy.test.ts`: scoped to the pin, never merged without a trusted human) |
| 18 | The Live view shows step, gate attempt and cost within 10 seconds | Dashboard not built |
| 19 | (native half) The same, on a fixture using GitHub's native merge queue | Needs an org-owned public repo; `bsf-fixtures` push is refused |
| 20 | Every run produces a valid run file; the dashboard shows it within 60 seconds | The run schema and its validation pass (`schema.test.ts`), but no run has been produced and there is no dashboard |
| 21 | Cost per run is within 5% of billed usage on a 10-run sample | Needs memex reading real session logs across real runs |
| 22 | Turning on auto-merge in the dashboard opens a definition PR that merges | Dashboard not built |
| 23 | The factory is set up on Philip's old repo, and a real issue becomes a verified draft PR | Skill and GitHub App |

## v0.2 and v1.0

Not started. The Build Plan gates each release on its own criteria, and v0.1's
are not met, so beginning v0.2 would mean building on an unverified base. One
v0.2 criterion is nonetheless proven early, because its logic lives in the
budget code: *when gardening's budget share is used, gardening pauses while
product work continues, up to 110% of the total* — `queue-rollup.test.ts`, five
tests, including the minutes limit and its absence on public repos.

## What was found about `trinsports`

A phase-1 assessment of the real target, which changes what setup will do
there:

- **No CI at all** — no `.github/workflows/`. So `existing_ci.test_check` is
  `null` and the factory runs the tests itself, without touching any team CI.
  It also means criterion 7 has no fixture in this repo.
- **No tests at all** — no test runner, no test script, no test files. The
  skill's documented no-tests path applies: coverage floor 0%, and gardening
  seeded to add tests per feature folder, most-changed first. Note the
  consequence: diff coverage at 80% is the main check from the first PR, so the
  first product-work PR has to arrive with tests, from zero.
- **`npm run build` needs a live Postgres.** `build` runs `db:migrate` first,
  against `DATABASE_URL`. Two things follow. The sandbox needs a Postgres
  sidecar, which by spike §4a means the agent runs on
  `sandbox.agent.runtime: docker-sudo-iptables` — the weaker AWF profile, with
  host privileges. Philip's own repo is the case that forces the trade-off the
  spike surfaced, so it is the right place to try the `pre-agent-steps`
  alternative first.
- **A real safety hazard for phase 2.** `drizzle.config.ts` loads
  `.env.local`, and `npm run build` migrates whatever `DATABASE_URL` points at
  — the developer's Neon dev branch, on a developer's machine. The runbook must
  point `DATABASE_URL` at a throwaway sidecar and the sandbox must not inherit
  `.env.local`, or an agent running the documented build command migrates a
  real database. This belongs in the skill's phase 2 as a check, not as advice.
- **`AGENTS.md` is partly machine-written.** `next dev` writes and restores two
  blocks in it. Correction mining treats `AGENTS.md` as a prose-rule source, so
  it would mine Next.js's own generated instructions as if they were the team's
  conventions. Mining should skip generated blocks, by their `BEGIN:`/`END:`
  markers.

## What to do next, in order

1. **Philip:** install the Claude GitHub App on `bsf-fixtures`, and create
   `py-api` and `js-legacy` there.
2. **Build the three v0.1 fixtures.** Nothing end-to-end can be tried without
   them, and they are small.
3. **Create the factory GitHub App** (Philip, two clicks) — this unblocks eight
   criteria at once.
4. **Run `gh aw compile` on the seven role workflows** and fix what it rejects.
   This is the first thing that can be done on a machine with normal network
   access, and it validates the spike's central design change.
5. **The sandbox (phase 2) on `trinsports`**, including the two spike items
   that need a live run: whether the agent can reach an app in a
   `pre-agent-steps` devcontainer, and whether a `pre-agent-steps` Postgres
   avoids `docker-sudo-iptables`.
6. Then the skill's phase scripts, then the dashboard.
