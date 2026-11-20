---
# Written from Kilo Code's own CLI documentation and its package metadata, not
# from having run the CLI here. Every value below has a source, recorded in the
# notes at the bottom of this file. What is NOT established is the shape of the
# JSONL events `--format json` emits, which is why `log-parser` is absent and
# the adapter's status.needs still names a conformance run.
#
# The useful lead: Kilo Code's CLI is a fork of OpenCode, and reads
# OpenCode-style config. gh-aw ships an OpenCode engine definition with a
# working log parser, so that parser is the starting point for this one rather
# than a blank page.
engine:
  id: kilo-code
  display-name: Kilo Code CLI
  description: Kilo Code's CLI in autonomous mode, as a gh-aw behaviour-defined engine
  experimental: true
  detection-engine: copilot
  runtime-id: kilo-code
  version: "7.8.3"
  provider:
    name: anthropic
  auth:
    - role: api-key
      secret: ANTHROPIC_API_KEY
  behaviors:
    secret-strategy: universal-llm-consumer
    supported-env-var-keys:
      - ANTHROPIC_API_KEY
    capabilities:
      # Declared from documented flags only. Claiming a capability the CLI
      # lacks produces a run that fails in the middle rather than at the start.
      tools-allowlist: false
      max-turns: false
      web-search: false
      native-agent-file: false
    manifest:
      # OpenCode-style config, which is what the fork reads.
      files:
        - kilo.jsonc
        - kilo.json
        - AGENTS.md
      path-prefixes:
        - .kilo/
    network:
      defaults:
        - github.com
        - raw.githubusercontent.com
        - api.github.com
      provider-domains:
        anthropic: api.anthropic.com
    installation:
      package-manager: npm
      package-name: "@kilocode/cli"
      version: "7.8.3"
      binary-name: kilo
      include-node-setup: true
      cooldown: true
      step-name: Install Kilo Code CLI
      verify-command: kilo --version
      verify-step-name: Verify Kilo Code CLI installation
      docs-url: https://kilo.ai/docs/code-with-ai/platforms/cli
    execution:
      command-name: kilo
      args:
        - run
        # --auto is not optional for CI. Without it a non-interactive run
        # cannot prompt for approval, auto-rejects every permission request,
        # and exits 1 with a diagnostic — so the step would fail having done
        # nothing, which is the worst of both outcomes.
        - --auto
        - --format
        - json
      step-name: Execute Kilo Code CLI
      model-env-var: FACTORY_MODEL
      mcp-config-env-var: GH_AW_MCP_CONFIG
      write-timestamp: true
      provider-env-mode: universal-llm-consumer
      env:
        NO_COLOR: "1"
---

<!--
# Kilo Code CLI adapter

**Status: written from documentation, not verified by a run.** The adapter
registry says the same, and nothing selects this engine until a conformance run
shows a step yielding token data.

## Where each value comes from

| Value | Source |
| --- | --- |
| Package `@kilocode/cli`, binary `kilo` | Kilo Code's package metadata; the package also exports `kilocode` |
| `kilo run --format json` | Kilo Code's official CLI reference |
| `--auto` required for CI | Kilo Code's own docs: without it a non-interactive run auto-rejects permission requests and exits 1 |
| `ANTHROPIC_API_KEY` | Kilo Code's docs for non-interactive use: set the provider's standard variable |
| Version `7.8.3` | The version its package metadata reported when this was written. **Re-pin before shipping** — this is the one value here most likely to be stale |
| OpenCode-style config files | Kilo Code's CLI is a fork of OpenCode and reads its config |
| `~/.local/share/kilo/kilo.db` session store | memex's engine documentation; `$XDG_DATA_HOME/kilo/kilo.db` and `KILO_DATA_DIR` also apply |

## What is still missing

**A log parser.** gh-aw ships parsers for its own engines; for anything else,
per-step tokens and cost come from the parser the definition supplies. Until
there is one, the step report falls back to memex's reading of
`kilo.db` and, failing that, reports `cost_source: unknown` — correct
behaviour, not a working adapter.

The fork lineage is the shortcut: because this CLI is OpenCode underneath,
gh-aw's `shared/opencode.md` parser and its `parse_opencode_log.cjs` are the
place to start, and `kilo export <sessionID>` is the counterpart of the
`session export` that OpenCode's harness script uses to reconcile steps.

**A pin that is current.** `7.8.3` was what the package reported when this was
written; confirm it against the registry before a release depends on it.
-->
