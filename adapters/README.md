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
general. Each custom adapter records what it actually needs.

**And the thing worth looking for first: someone may have already written it.**
gh-aw ships maintained engine definitions for ten third-party CLIs in
`.github/workflows/shared/`, and one of them is Cursor. So `cursor-cli.md`
here is gh-aw's own file, copied verbatim — self-installing from a pinned
archive, with the real headless flags, a log parser, `CURSOR_API_KEY` auth,
and gh-aw's own conformance and smoke workflows run against it. That is
better than anything this project could write without the CLI in hand. See
`cursor-cli.NOTES.md`.

## Where each harness stands

| Harness | How it runs | What it still needs |
| --- | --- | --- |
| Claude Code | gh-aw built-in engine `claude` | A conformance run |
| pi | gh-aw built-in engine `pi` | A conformance run |
| Cursor CLI | gh-aw's own definition, vendored here | A conformance run |
| Kilo Code | A definition written here from Kilo's own CLI docs | A log parser, a confirmed version pin, a conformance run |
| Hermes Agent | A definition written here from Hermes's own CLI docs | A **pinned install** (its own installer pins nothing and builds its own toolchain), a log parser, a conformance run |

Neither of the last two needed a CLI in hand to get this far: both vendors
document their headless mode precisely, and every value in those two files has
a source recorded in the file itself. What documentation cannot give is the
shape of the JSONL events each emits, which is what a log parser needs, and in
Hermes's case a way to install a fixed version. Those are the honest remainder.

Kilo Code's is the easier of the two for a reason worth knowing: its CLI is a
fork of OpenCode, and gh-aw ships an OpenCode definition with a working
parser, so that parser is the starting point rather than a blank page.

The pattern across all five: **the session side is solved for every harness**
(gh-aw parses its own, memex reads all five locally, and for Hermes `ccusage`
reads the same `state.db` as a second implementation to check against), while
**the execution side is solved for three of five** outright and documented for
the other two.

**Thirteen more engines gh-aw can already run** are listed in
`GH_AW_ENGINES_NOT_YET_ADOPTED` in `adapters.ts`, including Codex, Copilot,
OpenCode, goose and Kiro. Each is an engine gh-aw installs, runs and parses
already, so adopting one is a registry entry plus a conformance run — not an
integration. Eight of them also have a memex source, so correction mining
would work too. This is the cheap way the supported set grows.

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
`bsf contribute-corrections`. Its source names here were read from its own
`SourceKind` enum rather than guessed — but setup still verifies them against
the installed memex, because a rename upstream would otherwise show up only
as a step that reports zero tokens.
