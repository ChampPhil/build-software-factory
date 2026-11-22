# Build Software Factory

Turns a repository into a governed, automated loop: work comes in as an issue,
agents triage, specify, build and verify it, deterministic gates decide whether
it is allowed to merge, and a human approves what lands. It runs entirely on
GitHub Actions with no server to host, and it improves itself — the corrections
people have already made to agents become static rules, and changes to the
factory's own definition have to beat a frozen benchmark before they are
adopted.

> **Status: beta.** It has run end to end on nine fixture repositories and on
> one real app; what is proven, and how, is in
> [`docs/12-acceptance-v1.0.md`](docs/12-acceptance-v1.0.md).

## Quickstart

You need: a GitHub repository you are an admin of, the
[`gh` CLI](https://cli.github.com) signed in (`gh auth login`), Node 20 or
later, [Claude Code](https://code.claude.com), and an Anthropic API key.
Nothing else runs on your machine: the sandbox the agents verify in is built
and proved in your repository's GitHub Actions.

**1. Get the factory and give Claude Code its setup skill.**

PowerShell (Windows):

```powershell
git clone https://github.com/ChampPhil/build-software-factory "$HOME\build-software-factory"
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
New-Item -ItemType Junction -Path "$HOME\.claude\skills\build-software-factory" -Target "$HOME\build-software-factory\skill"
```

bash (macOS, Linux):

```bash
git clone https://github.com/ChampPhil/build-software-factory ~/build-software-factory
mkdir -p ~/.claude/skills
ln -s ~/build-software-factory/skill ~/.claude/skills/build-software-factory
```

The skill is linked rather than copied because its scripts install the
factory's templates from the clone beside it.

**2. In your repository, ask Claude Code to set it up.**

```
cd path/to/your-repo
claude
> Set up the software factory on this repo.
```

**3. Do the five things only you can do.** Claude Code does everything else
and tells you at each step what it found and what it needs.

| You | When |
| --- | --- |
| Click **Create**, then **Install**, on two GitHub App pages it opens | Phase 6: the factory's App, which is what its agents act as |
| Paste your Anthropic API key once | It is stored as the repo secret `ANTHROPIC_API_KEY`, never in a file |
| Answer a few questions about the product | They become the agents' standing instructions, which you can change later |
| Merge the **bootstrap PR** | It installs the runner and workflows; setup then runs on its own in Actions |
| Merge the **setup PR** | It shows the app running in the sandbox and every gate passing; merging switches the factory on |

**4. Open an issue.** The factory triages it, writes a spec, builds it,
verifies it in the sandbox and opens a PR with the proof. You review and merge.

Later, comment `/practice <anything>` on any issue or PR to add a standing
instruction every agent follows, and `/retry` to hand back something the
factory stopped on.

## What it does

| | |
| --- | --- |
| **Intake** | An issue from someone trusted becomes a work item. Anything else waits for a one-click accept, and its text never reaches a prompt until it does. |
| **Pipelines** | Product work, gardening, hardening, definition changes and conflict resolution, each with its own roles, path policy and budget share. |
| **Sandbox** | Each role works against a sandbox built to match the app: its database, sign-in and outside services stand in as stubs, each with a probe that must pass. When a role finds the sandbox lacking, the factory repairs it itself and verifies the stuck change again, with no one in the loop unless the repair asks for a new host or secret. |
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

## What it costs, and the budget

Two meters, both yours: your Anthropic API key, and your GitHub Actions
minutes. The factory has a monthly budget in dollars (default **$35**) split
into shares (product work 60%, gardening 25%, review and benchmarks 15%). Both are set and changed from the
dashboard's Factory page.

**The factory stops before it can spend past the budget, even if that means
stopping with money left.** Before any agent step starts, it reserves the most
that step could cost: its gh-aw credit cap, plus one request past it (the cap
is checked before each request, so the request that crosses it still
finishes), for the agent and for its threat-detection check, at Anthropic's
list prices. The step starts only if what is already spent this month, what
running steps have reserved, and its own reservation all fit within the budget
and its pipeline's share. When the step ends it is charged what it measured
(the larger of its session's reported cost and its tokens at list price), and
anything it could not measure is charged at the full reservation. When even
the largest step of a pipeline no longer fits, that pipeline's work waits in
the queue until next month or until you raise the budget.

Measured on the fixtures with the default models: triage (Haiku 5.5) about
$0.01, a spec (Opus 5.5) about $0.50–0.70, a build (Sonnet 5.5) about
$0.50–3, verification (Haiku 5.5) a few cents. With the $35 default and one
gardening PR a night, that is roughly a dozen small product changes a month.

As a second line of defence, make the key in its own
[Anthropic Console](https://console.anthropic.com) workspace with a monthly
spend limit a little above the factory's budget: then Anthropic stops the
spending too, whatever happens in the factory.

**The factory runs its agents on Claude Code only.** gh-aw's per-step credit
cap, which the budget is built on, was tested live with a 2-credit cap: it
stopped Claude Code after one request, and did not stop Cursor CLI at all
(49 tool calls, about 29 times the cap), because Cursor's requests never
reach gh-aw's metering proxy. A harness whose spend cannot be stopped cannot
run under a budget, so it is not supported.

Actions minutes are separate. A private repository on GitHub Free gets 2,000
a month; public repositories get standard runners free. To estimate both for
your repository before you start:

```bash
node $HOME/build-software-factory/skill/scripts/estimate-spend.mjs --repo owner/name   # works in PowerShell and bash
```

## Built on

The factory reuses mature tools wherever one fits its constraints — free,
nothing hosted, works on free GitHub plans, MIT-compatible —
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
4. **A budget it cannot overspend.** Each agent step reserves its worst case
   before it starts, so the monthly cap is a ceiling rather than an estimate.

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
| [11 Acceptance v0.1](docs/11-acceptance-v0.1.md) | The first milestone's evidence |
| [12 Acceptance v1.0](docs/12-acceptance-v1.0.md) | What is proven live, how, and what is not |
| [13 Security review](docs/13-security-review.md) | Threats considered and how each is handled |

## Developing

```bash
npm ci
npm test          # the runner's and the dashboard's tests
npm run lint
npm run typecheck
npm run schema-check   # the schemas against their frozen shape
```

`CONTRIBUTING.md` covers adding a rule pack. A new harness is only worth
adding once a live test shows gh-aw's credit cap stops it (see
`tests/live`).

## Licence

MIT. See [`LICENSE`](LICENSE).
