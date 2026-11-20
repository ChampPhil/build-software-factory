---
# Written from Hermes Agent's own CLI documentation (NousResearch/hermes-agent),
# not from having run the CLI here. Every value below has a source, recorded in
# the notes at the bottom. Two things are NOT established: the shape of the
# JSONL events `--format stream-json` emits, and whether gh-aw's installation
# block can install this CLI at all — see "The install problem" below.
engine:
  id: hermes-agent
  display-name: Hermes Agent
  description: Hermes Agent's CLI in one-shot mode, as a gh-aw behaviour-defined engine
  experimental: true
  detection-engine: copilot
  runtime-id: hermes-agent
  version: "0.23.1"
  provider:
    name: anthropic
  auth:
    - role: api-key
      secret: ANTHROPIC_API_KEY
  behaviors:
    secret-strategy: universal-llm-consumer
    supported-env-var-keys:
      - ANTHROPIC_API_KEY
      - HERMES_HOME
    capabilities:
      tools-allowlist: false
      max-turns: false
      web-search: false
      native-agent-file: false
    manifest:
      files:
        - MEMORY.md
        - USER.md
      path-prefixes:
        - .hermes/
    network:
      defaults:
        - github.com
        - raw.githubusercontent.com
        - api.github.com
      provider-domains:
        anthropic: api.anthropic.com
    execution:
      command-name: hermes
      args:
        - chat
        # --oneshot is load-bearing: without it, a run on a TTY seeds an
        # interactive session instead of answering and exiting.
        - --oneshot
        # --format stream-json requires -q or --query-file and implies quiet
        # non-interactive mode. --query-file - takes the prompt on stdin, and
        # nothing there is shell-interpreted, so a prompt containing quotes,
        # backticks or $(...) arrives verbatim — which is the right way to
        # pass a prompt assembled from a work item.
        - --query-file
        - "-"
        - --format
        - stream-json
      step-name: Execute Hermes Agent
      model-env-var: FACTORY_MODEL
      mcp-config-env-var: GH_AW_MCP_CONFIG
      write-timestamp: true
      provider-env-mode: universal-llm-consumer
      env:
        NO_COLOR: "1"
        # Keep the agent's state inside the job rather than wherever a runner
        # image happens to put a home directory.
        HERMES_HOME: /tmp/hermes
---

<!--
# Hermes Agent adapter

**Status: written from documentation, not verified by a run,** and with one
unresolved design question below. The adapter registry says the same.

## Where each value comes from

| Value | Source |
| --- | --- |
| `hermes chat --oneshot -q` / `--query-file` | Hermes Agent's CLI command reference |
| `--format stream-json` emits JSONL, requires `-q`/`--query-file`, implies quiet non-interactive mode and rejects `--tui` | The same reference |
| `--query-file -` reads stdin verbatim, nothing shell-interpreted | Hermes Agent's CLI interface docs |
| `--model "anthropic/claude-sonnet-4"` form, `--provider` | The same |
| Session store `~/.hermes/state.db`, or `$HERMES_HOME/state.db` | Hermes Agent's sessions documentation, and ccusage's Hermes data source, which reads the same file |
| Version `0.23.1` | The version its docs referenced when this was written. **Re-pin before shipping** |

This also fills a gap memex left: memex documents that it reads Hermes from "a
local `state.db`" without saying where. It is `~/.hermes/state.db`, relocatable
with `HERMES_HOME`, and `ccusage` reads the same file for token usage — a
second open-source implementation to check this one against.

## The install problem

Hermes Agent does not install like the others. Its installer clones the latest
stable tag into `~/.hermes/hermes-agent` and downloads its own uv, Python,
Node.js, ripgrep and FFmpeg into `~/.hermes/tools`, building a hash-verified
virtualenv. That is deliberate on their part — nothing touches the system
Python — but it means:

- `installation.package-manager: npm` does not describe it, which is why this
  definition has no `installation` block;
- the install is large, so a role step would pay for it on every run unless it
  is cached;
- "the latest stable tag" is not a pin, and a factory whose builder changes
  version between runs cannot have reproducible runs.

So this adapter needs the same treatment gh-aw gave Cursor: a `harness-script`
that fetches a **pinned** release itself and verifies it, rather than an
`installation` block. That is the piece of real work left here, and it cannot
be written honestly without running the installer once to see what it produces.

## What is still missing

A log parser, as with every non-gh-aw engine. Until there is one, tokens come
from memex's reading of `state.db` — which, for Hermes, is counters and
metadata only, not message content. That is enough to cost a step and not
enough to mine corrections from, so Hermes is costable but not minable.
-->
