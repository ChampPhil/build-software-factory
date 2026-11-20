/**
 * The adapter registry.
 *
 * An adapter is data, not code: the runner never launches an agent, and gh-aw
 * never learns about the factory. Everything a harness needs is either a gh-aw
 * engine id (for the two gh-aw ships built in) or a gh-aw engine definition
 * file in this directory (for the other three).
 *
 * What is recorded here is only what has been confirmed from gh-aw's source
 * and memex's documentation. In particular the memex *source name* for each
 * harness is deliberately not hardcoded: memex documents the store paths but
 * not the full list of `--source` values, so a guessed name would fail
 * silently — the step report would simply carry no tokens. Instead setup asks
 * the installed memex for its source list and matches on the store path,
 * which fails loudly when it cannot (`resolveMemexSource`).
 */

export type HarnessId = "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";

export interface HarnessAdapter {
  readonly id: HarnessId;
  /** The `engine:` value a role workflow sets. */
  readonly engineId: string;
  /**
   * Null for gh-aw's built-in engines (`pkg/workflow/data/engines/*.md`).
   * Otherwise the definition file in this directory, which the role workflow
   * imports and then selects by id.
   */
  readonly engineDefinition: string | null;
  /** The repo secret the engine reads its model key from. */
  readonly keySecret: string;
  /** How memex is matched to this harness. See resolveMemexSource. */
  readonly memex: {
    /** The engine name memex uses in its own engine-support table. */
    readonly engineLabel: string;
    /**
     * Where this harness keeps local sessions, as memex documents it. Used to
     * identify the right source when the name cannot be assumed, and to make a
     * failure diagnosable without reading memex's source. Null where memex
     * documents the engine but not its path.
     */
    readonly store: string | null;
    /** Whether memex reports token counters for this engine. */
    readonly tokenUsage: "yes" | "credits_only" | "no";
  };
  /** The config that captures local sessions as they happen, if any. */
  readonly localHook: { readonly path: string; readonly kind: "hooks" | "none" };
  readonly status: AdapterStatus;
}

export interface AdapterStatus {
  /** `builtin`: gh-aw ships the engine. `definition`: this directory does. */
  readonly kind: "builtin" | "definition";
  /** Set once a real step has run on this harness and produced token data. */
  readonly conformance: "passed" | "not_run";
  /** What this adapter still needs, in plain words. Empty when ready. */
  readonly needs: readonly string[];
}

const NEEDS_CLI_FACTS = [
  "the CLI's exact headless flags and JSON event shape, confirmed against the installed CLI",
  "a log parser, because gh-aw ships none for this engine",
  "a conformance run proving the step yields token data",
] as const;

export const ADAPTERS: Readonly<Record<HarnessId, HarnessAdapter>> = {
  "claude-code": {
    id: "claude-code",
    engineId: "claude",
    engineDefinition: null,
    keySecret: "ANTHROPIC_API_KEY",
    memex: { engineLabel: "Claude Code", store: null, tokenUsage: "yes" },
    localHook: { path: ".claude/settings.json", kind: "hooks" },
    status: {
      kind: "builtin",
      conformance: "not_run",
      needs: ["a conformance run proving the step yields token data"],
    },
  },

  pi: {
    id: "pi",
    engineId: "pi",
    engineDefinition: null,
    keySecret: "ANTHROPIC_API_KEY",
    memex: { engineLabel: "Pi", store: null, tokenUsage: "yes" },
    localHook: { path: ".pi/config.json", kind: "none" },
    status: {
      kind: "builtin",
      conformance: "not_run",
      needs: ["a conformance run proving the step yields token data"],
    },
  },

  "cursor-cli": {
    id: "cursor-cli",
    engineId: "cursor-cli",
    engineDefinition: "cursor-cli.md",
    keySecret: "CURSOR_API_KEY",
    // memex's table: history from agent transcripts, usage from local
    // databases; it documents no path for either.
    memex: { engineLabel: "Cursor", store: null, tokenUsage: "yes" },
    localHook: { path: ".cursor/rules", kind: "none" },
    status: { kind: "definition", conformance: "not_run", needs: [...NEEDS_CLI_FACTS] },
  },

  "kilo-code": {
    id: "kilo-code",
    engineId: "kilo-code",
    engineDefinition: "kilo-code.md",
    keySecret: "ANTHROPIC_API_KEY",
    memex: {
      engineLabel: "KiloCode CLI",
      store: "~/.local/share/kilo/kilo.db (or $XDG_DATA_HOME/kilo/kilo.db; KILO_DATA_DIR adds stores)",
      tokenUsage: "yes",
    },
    localHook: { path: ".kilocode/config.json", kind: "none" },
    status: { kind: "definition", conformance: "not_run", needs: [...NEEDS_CLI_FACTS] },
  },

  "hermes-agent": {
    id: "hermes-agent",
    engineId: "hermes-agent",
    engineDefinition: "hermes-agent.md",
    keySecret: "ANTHROPIC_API_KEY",
    // memex reads Hermes's usage counters and metadata only, not message
    // content — enough for a step report, not enough for correction mining.
    memex: { engineLabel: "Hermes", store: "a local state.db (path undocumented)", tokenUsage: "yes" },
    localHook: { path: ".hermes/config.toml", kind: "none" },
    status: {
      kind: "definition",
      conformance: "not_run",
      needs: [
        ...NEEDS_CLI_FACTS,
        "correction mining cannot use Hermes sessions: memex reads its counters and metadata, not message content",
      ],
    },
  },
};

/** The harnesses whose engine gh-aw already ships, so they can run a role today. */
export function readyHarnesses(): readonly HarnessId[] {
  return (Object.keys(ADAPTERS) as HarnessId[]).filter((id) => ADAPTERS[id].status.kind === "builtin");
}

/** One key covers four of the five; Cursor needs its own account (doc 07). */
export function keysNeeded(ids: readonly HarnessId[]): readonly string[] {
  return [...new Set(ids.map((id) => ADAPTERS[id].keySecret))];
}

export interface MemexSource {
  readonly name: string;
  readonly engine?: string;
  readonly path?: string;
}

export type MemexResolution =
  | { readonly ok: true; readonly source: string; readonly how: "engine_label" | "store_path" }
  | { readonly ok: false; readonly reason: string };

/**
 * Match a harness to one of the installed memex's own source names.
 *
 * Nothing is guessed. If memex's list contains no source for this harness,
 * that is reported — because the alternative is a step report that silently
 * carries no tokens, and a cost of zero that the budget then believes.
 */
export function resolveMemexSource(
  id: HarnessId,
  sources: readonly MemexSource[],
): MemexResolution {
  const adapter = ADAPTERS[id];
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const byLabel = sources.find(
    (s) => norm(s.name) === norm(adapter.memex.engineLabel) || norm(s.engine ?? "") === norm(adapter.memex.engineLabel),
  );
  if (byLabel !== undefined) return { ok: true, source: byLabel.name, how: "engine_label" };

  // Fall back to the documented store path, which is the fact memex publishes
  // for the engines whose source name it does not.
  const store = adapter.memex.store;
  if (store !== null) {
    const stem = /([a-z0-9_-]+)\.db/.exec(store)?.[1];
    if (stem !== undefined) {
      const byPath = sources.find((s) => (s.path ?? "").includes(`${stem}.db`));
      if (byPath !== undefined) return { ok: true, source: byPath.name, how: "store_path" };
    }
  }

  return {
    ok: false,
    reason:
      `the installed memex lists no source for ${adapter.memex.engineLabel}. ` +
      `Its sources are: ${sources.map((s) => s.name).join(", ") || "(none)"}. ` +
      `Without one, this harness's steps would report no tokens and a cost of zero, ` +
      `so the factory refuses the harness rather than mis-reporting its spend.`,
  };
}
