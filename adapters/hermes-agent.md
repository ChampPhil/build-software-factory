---
# UNVERIFIED. This definition is written from gh-aw's engine schema and its own
# worked samples (pkg/workflow/data/engines/*.md and
# .github/workflows/shared/opencode.md), not from having run the CLI. The
# package name, the headless flags, the event shape and the version pin are all
# unconfirmed, and the adapter's status.needs says so. Nothing selects this
# engine until a conformance run proves a step yields token data.
engine:
  id: hermes-agent
  display-name: Hermes Agent
  description: Hermes Agent in headless mode, as a gh-aw behaviour-defined engine
  experimental: true
  # Prompt rendering and threat detection fall back to a known engine, as
  # gh-aw's own third-party samples do.
  detection-engine: copilot
  runtime-id: hermes-agent
  version: "0.0.0-unverified"
  provider:
    name: anthropic
  behaviors:
    secret-strategy: universal-llm-consumer
    capabilities:
      # Declared conservatively: gh-aw adapts prompt delivery to what the
      # engine says it supports, and claiming a capability the CLI lacks
      # produces a run that fails in the middle rather than at the start.
      tools-allowlist: false
      max-turns: false
      web-search: false
      native-agent-file: false
    network:
      defaults:
        - github.com
        - raw.githubusercontent.com
      provider-domains:
        anthropic: api.anthropic.com
    installation:
      package-manager: npm
      package-name: "hermes-agent"
      version: "0.0.0-unverified"
      binary-name: hermes
      include-node-setup: true
      cooldown: true
      step-name: Install Hermes Agent
      verify-command: hermes --version
      verify-step-name: Verify Hermes Agent installation
    execution:
      command-name: hermes
      args:
        - --print
      step-name: Execute Hermes Agent
      model-env-var: FACTORY_MODEL
      mcp-config-env-var: GH_AW_MCP_CONFIG
      write-timestamp: true
      provider-env-mode: universal-llm-consumer
      env:
        NO_COLOR: "1"
---

<!--
# Hermes Agent adapter

**Status: unverified.** Every value above that describes the CLI rather than
gh-aw is a placeholder, including the npm package name, the `--print` headless
flag and the version pin. They are marked rather than omitted so the shape of
the definition can be reviewed and tested now, and so the one thing that has to
happen next is unambiguous: install the CLI, run one step, and replace each
placeholder with what the CLI actually does.

**Why a definition and not `engine.command`.** gh-aw's `engine.command` runs a
binary but leaves us owning the install steps and the log parsing. A
behaviour-defined engine hands both back to gh-aw and keeps its retry, timeout
and tool-policy behaviour, which `engine.harness` would replace. gh-aw's own
OpenCode sample is the worked example.

**What is still missing after the placeholders are filled in.** A log parser.
gh-aw ships parsers for its own engines; for anything else, per-step tokens and
cost come from the parser this definition supplies. Until then the step report
falls back to memex and, failing that, reports `cost_source: unknown` — which
is correct behaviour, not a working adapter.

**The key.** `ANTHROPIC_API_KEY` for this harness.
-->
