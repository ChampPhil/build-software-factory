# Budget

The factory has a monthly budget in dollars, default **$35**, split into shares: product work 60%, gardening 25%, reviews and practices 15%. Both are set from the dashboard's Factory page. Actions minutes are a second meter, and GitHub's own spending limit is what stops them.

The budget is a ceiling, not an estimate: **the factory stops before it can
spend past it, even if that means stopping with money left.** It is kept in
one file on the data ref, `budget.json` (schema `budget/2`): this month's spend
per pipeline, the holds of steps still running, and the keys already charged.

**Before an agent step** (`bsf budget reserve`, the role workflow's first
step after fetching the trusted runner, before the sandbox starts) the step
holds its ceiling: its gh-aw `max-ai-credits` cap, plus the most one request
can cost, for the agent and again for its threat-detection check. One request
is added because gh-aw checks the cap before each request, so the request that
crosses it still finishes: in the live cap test the cap was 2 credits and the
run stopped at 6.08. The most one request can cost is bounded by two settings
every role sets, `CLAUDE_CODE_DISABLE_1M_CONTEXT` (a 200k window, so with one
capped tool result on top no request sends more than 250k tokens) and
`CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000`, priced at the dearest list rate
(`runner/src/lib/prices.ts`, Anthropic's published prices). The step starts
only if this month's spend, the holds of steps still running and its own hold
fit within the monthly budget and within its pipeline's share; otherwise it
exits before the agent is invoked and says why on the job summary. A model
with no list price cannot be bounded, so a step on one does not start.

**After the step**, the role uploads what it measured (`bsf budget measure`):
the agent's cost, taken as the larger of what its session reported and what
its tokens cost at list price. The caller's next job, `factory-budget-settle`,
which every following agent step waits for, adds the threat-detection run's
cost from that job's own usage record and replaces the hold with the measured
charge. Whatever cannot be measured is charged at its full hold, never as
zero, and a hold that is never settled (a cancelled run) is charged in full by
the rollup after four hours.

**Every write is a compare-and-swap** on the data ref: the new `budget.json`
is committed on the very commit it was read from, and the non-forced ref
update fails if anyone wrote in between, so the writer re-reads and decides
again. Two runs reading the same last dollars cannot both be told yes.

**Work that cannot fit waits.** Dispatch treats a pipeline as paused when
what is left of the total or of its share cannot cover the largest single step
its run would hold (for product work on the defaults, the Opus spec), and a
run's plan checks the same before claiming its item. Queued work then stays
queued until the month turns or the budget is raised, instead of starting runs
that would be refused halfway.

**Shares.** Gardening (25% by default) and reviews and practices (15%) stay
within their share. Product work may use whatever they leave, up to the whole
budget. Setup is charged against the total only.

**Actions minutes are not counted by the factory.** GitHub's own Actions
spending limit, $0 by default, already stops runners at a plan's included
minutes. On a private Free repository that is 2,000 a month;
`estimate-spend.mjs` estimates what the factory will use.

**Proven live** on `bsf-fixtures/go-cli`: a $0.01 budget refused the
first step before its agent started and charged nothing; with $15, the
builder was refused before it started because its hold would have passed
product work's share as the rules stood then (product work may now use the
whole budget); and across every step of the proof the factory
charged at or above what each step really cost.

To estimate both meters for a repository before setup:

```bash
node $HOME/build-software-factory/skill/scripts/estimate-spend.mjs --repo owner/name
```

The key can live in its own [Anthropic Console](https://console.anthropic.com) workspace with a monthly spend limit a little above the factory's budget. Anthropic then stops the spending too.

The agents that do the factory's work run on Claude Code, because that is the harness whose spend the credit cap is proven to stop. The comparison is in [Architecture](Architecture.md), under Agent CLI adapters.
