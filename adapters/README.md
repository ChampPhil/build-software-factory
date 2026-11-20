# Harness adapters

One entry per agent CLI. An adapter says three things: how gh-aw runs the
harness, where its session data comes from, and what captures its sessions on
the user's own machine.

## What changed from the original design

Doc 07 originally specified that the three harnesses gh-aw has no built-in
engine for would run through `engine.command` with hand-written setup steps.
Reading gh-aw's source showed a better mechanism and one worse problem.

**Better mechanism: behavior-defined engines.** gh-aw accepts a complete
engine *definition* — a shared `.md` file whose frontmatter carries
`engine.behaviors` with `installation`, `execution`, `capabilities`,
`network.provider-domains` and a `log-parser`. gh-aw then installs the CLI
itself, runs it, parses its log into the unified session artifact, and keeps
its own retry, timeout and tool-policy behaviour. That is strictly more than
`engine.command` gave us and strictly less code for us to own, so the three
custom adapters are definitions, not commands. gh-aw's built-in engines
(`data/engines/*.md`) and its OpenCode sample
(`.github/workflows/shared/opencode.md`) are the worked examples.

**Worse problem: a definition is not always enough.** gh-aw's own OpenCode
sample needed a ~200-line `harness-script` on top of the definition to
reconcile sessions and enforce turn limits, and it is labelled an unsupported
repository sample. So "add a harness = one adapter entry" holds for a CLI
whose headless mode emits clean JSONL and nothing else; it does not hold in
general. Each custom adapter below records what it actually needs.

## Where tokens and cost come from

Doc 07 said memex reads the harness's session log after every step. gh-aw's
unified agent session artifact already carries per-step `totalCostUsd` and
normalized token `usage`, and its API proxy meters tokens independently of
what the CLI reports about itself. It also states the rule this factory
arrived at separately: absence is not zero, and a cost that cannot be
determined must stay unavailable rather than become zero.

So the order is:

1. **gh-aw's session artifact** — in CI, for any engine gh-aw runs. Proxy
   metering beats self-reporting, and it is already there.
2. **The harness's own session log, read with memex** — when the artifact
   carries no usage for the step.
3. **The bundled LiteLLM price table** — only to price tokens that have no
   cost attached.
4. **`cost_source: "unknown"`** — when none of the above has it. The budget
   treats an unknown as unknown, not as free.

memex keeps its other job, which gh-aw cannot do: reading **past local
sessions** on the user's own machine for correction mining at setup and for
`bsf contribute-corrections`.
