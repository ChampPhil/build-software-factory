# Build Software Factory

Turns a repository into a governed, automated loop: work comes in as an issue,
agents triage, specify, build and verify it, deterministic gates decide whether
it is allowed to merge, and a human approves what lands. It runs entirely on
GitHub Actions with no server to host, and it improves itself — the corrections
people have already made to agents become static rules, and changes to the
factory's own definition have to beat a frozen benchmark before they are
adopted.

> **Status: in development.** The deterministic half is built and tested; the
> parts that need a running factory on a real repository are listed in
> [`docs/11-acceptance-v0.1.md`](docs/11-acceptance-v0.1.md) with what is proven
> and what is not. Nothing here has run a full production loop yet.

## Three steps

```bash
# 1. In your repo, with Docker running and the `gh` CLI signed in:
npx build-software-factory setup

# 2. Approve the setup pull request it opens.

# 3. Open an issue. The factory picks it up.
```

Setup reads the repository first — languages, tools, tests, and the
corrections you have already made to agents in past local sessions — and shows
you what it proposes before it changes anything. It stops rather than
continuing with a factory that cannot verify its own work.

## What it does

| | |
| --- | --- |
| **Intake** | An issue from someone trusted becomes a work item. Anything else waits for a one-click accept, and its text never reaches a prompt until it does. |
| **Pipelines** | Product work, gardening, hardening, definition changes and conflict resolution, each with its own roles, path policy and budget share. |
| **Gates** | Static rules, tests and coverage run on every PR and decide the merge, with a per-file ratchet so a change cannot trade one new violation for one fix. |
| **Guardrails** | Eight language rule packs, each rule carrying the bad and good example that proves it discriminates — a rule is installed only once it has failed on the bad one and passed on the good one. |
| **Merge queue** | GitHub's native queue where the repo qualifies, a one-at-a-time fallback everywhere else, so a human PR and a factory PR cannot each pass alone and break main together. |
| **Self-improvement** | A scheduled review grades recent work, routes what it finds to hardening or to a definition change, and a definition change must beat the current one on frozen benchmark tasks by more than the run-to-run spread. |
| **Dashboard** | A static page that talks to GitHub from your browser. No backend, no data anywhere but your repository. |

## Enforcement depends on your GitHub plan

The factory's own checks run on every plan. What changes is whether GitHub can
be told to *require* them.

| | Free personal / private | Public, or paid org | Enterprise Cloud |
| --- | --- | --- | --- |
| Gates, policy check, ratchet | yes | yes | yes |
| Branch protection making them required | no | yes | yes |
| Native merge queue | no — the factory's fallback queue | org-owned public repos | yes |
| Bypass detection | `factory-audit` re-runs the gates on every push to main and flags anything that got past them, with an optional revert PR | as needed | as needed |

On a free private repository nothing can stop a direct push to main, so the
factory watches main instead of pretending otherwise.

## What it costs

Two meters, both yours: your model API key and your Actions minutes.

Measured by `bsf estimate-spend` against a real repository — a Next.js app with
roughly 50 issues a quarter, on the default models and a nightly gardening run:

| | Per month |
| --- | --- |
| Model spend | ~$150 |
| Actions minutes | ~2,500 |

That is above a Free private repository's 2,000 included minutes, which is why
`estimate-spend` suggests one gardening PR a night rather than five for that
plan. Public repositories get standard runners free, so minutes are not a
limit there. The factory has a budget in dollars and in minutes, each pipeline
has a share of both, and a pipeline pauses when its share is used — a factory
that quietly spent its way past a budget would be worse than one that stops.

Run it on your own repository before you decide:

```bash
npx build-software-factory estimate-spend --repo owner/name
```

## Built on

The factory reuses mature tools wherever one fits its constraints — free,
nothing hosted, works on free GitHub plans, harness-agnostic, MIT-compatible —
and writes custom code only where nothing does.

[**gh-aw**](https://github.com/githubnext/gh-aw) runs the agents (sandbox,
network firewall, threat detection, writes only through checked outputs) ·
[**memex**](https://github.com/nicosuave/memex) reads past local sessions ·
[**promptfoo**](https://github.com/promptfoo/promptfoo) grades runs and
compares configurations · [**Semgrep**](https://semgrep.dev) taint rules for
data flow · [**Playwright**](https://playwright.dev) for runtime verification ·
each linter's own native baseline for the ratchets ·
[**Dependabot**](https://docs.github.com/code-security/dependabot) for runner
upgrades. The full table, with what the factory adds to each, is in
[the architecture doc](docs/07-architecture.md).

Built custom because nothing fits: mining corrections into guardrail
candidates, the hardening pipeline, benchmark-gated definition changes, the
cross-tool weakening check, the path-policy check, the merge-queue fallback,
the git-ref data store and the static dashboard.

## How this differs from other software factories

Other projects use the name — [addyosmani/factory](https://github.com/addyosmani/factory),
claude-software-factory, agent-factory, Elastic's AI software factory. Each is
worth reading, and the overlap is real: they all orchestrate agents around a
repository.

Four things here are not in any of them, and the combination is the reason
this exists:

1. **Corrections become rules.** The moments you told an agent it was wrong —
   in your own past local sessions, in reverts, in review comments — are mined
   into guardrail candidates, and the accepted ones become static rules, tests
   or context. A correction you have made once should not be a correction you
   make again.
2. **Self-improvement that has to prove itself.** A change to the factory's own
   definition runs against frozen benchmark tasks built from its own completed
   work, three repeats a side, and is adopted only if the gain is larger than
   the run-to-run spread. "The number went up" is not evidence.
3. **It works on a free plan.** No hosted service, no Enterprise features
   required: a fallback merge queue, audit-after-the-fact where branch
   protection is unavailable, and a dashboard with no backend.
4. **Five harnesses.** Claude Code, Cursor CLI, pi, Kilo Code and Hermes Agent,
   through gh-aw engine definitions rather than a fork of each.

## The docs

The specification is the source of truth, and the build follows it rather than
the other way round.

| | |
| --- | --- |
| [01 Overview](docs/01-overview.md) | What a software factory is, and the principles this one enforces |
| [02 Decisions](docs/02-decisions.md) | Every choice made, with what it was weighed against |
| [03 Walkthrough](docs/03-walkthrough.md) | The whole thing in plain language, for a reader who is new to it |
| [04 Build plan](docs/04-build-plan.md) | Milestones, acceptance criteria, fixtures |
| [05 Setup skill](docs/05-setup-skill.md) | The seven phases that turn a repo into a factory |
| [06 Pipelines](docs/06-pipelines.md) | Each pipeline's roles, triggers and policy |
| [07 Architecture](docs/07-architecture.md) | Components, data layout, enforcement, what is reused |
| [08 Dashboard](docs/08-dashboard.md) | The nine pages and what each answers |
| [09 Schemas](docs/09-schemas.md) | Every file the factory writes, and how they are versioned |
| [10 gh-aw spike](docs/10-spike-gh-aw.md) | What was learned by building against gh-aw |
| [11 Acceptance](docs/11-acceptance-v0.1.md) | What is proven, how, and what is not |

## Developing

```bash
npm ci
npm test          # 919 runner tests, 75 dashboard tests
npm run lint
npm run typecheck
npm run schema-check   # the schemas against their frozen shape
```

`CONTRIBUTING.md` covers adding a rule pack or a harness adapter, which are
the two things most likely to be worth adding.

## Licence

MIT. See [`LICENSE`](LICENSE).
