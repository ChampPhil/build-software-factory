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
     * memex's own `--source` value, read from its `SourceKind` enum rather
     * than guessed. Still checked against the installed memex at setup, since
     * a rename there would otherwise fail silently.
     */
    readonly source: string;
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
  /**
   * - `builtin`: gh-aw ships the engine in its compiler.
   * - `vendored`: gh-aw ships a maintained engine *definition*, copied here.
   * - `definition`: this project would have to write the definition, and
   *   cannot finish it without running the CLI.
   */
  readonly kind: "builtin" | "vendored" | "definition";
  /** Set once a real step has run on this harness and produced token data. */
  readonly conformance: "passed" | "not_run";
  /** What this adapter still needs, in plain words. Empty when ready. */
  readonly needs: readonly string[];
}

const NEEDS_CLI_FACTS = [
  "gh-aw ships no engine for this CLI, built in or shared, so the definition would have to be written here",
  "the CLI's exact headless flags and JSON event shape, which needs the CLI installed and run",
  "a log parser, so per-step tokens reach gh-aw's session artifact",
  "a conformance run proving the step yields token data",
] as const;

export const ADAPTERS: Readonly<Record<HarnessId, HarnessAdapter>> = {
  "claude-code": {
    id: "claude-code",
    engineId: "claude",
    engineDefinition: null,
    keySecret: "ANTHROPIC_API_KEY",
    memex: { engineLabel: "Claude Code", source: "claude", store: null, tokenUsage: "yes" },
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
    memex: { engineLabel: "Pi", source: "pi", store: null, tokenUsage: "yes" },
    localHook: { path: ".pi/config.json", kind: "none" },
    status: {
      kind: "builtin",
      conformance: "not_run",
      needs: ["a conformance run proving the step yields token data"],
    },
  },

  "cursor-cli": {
    id: "cursor-cli",
    // gh-aw's own definition declares the engine as `cursor`, and the id in
    // the definition is what a role workflow must set.
    engineId: "cursor",
    engineDefinition: "cursor-cli.md",
    keySecret: "CURSOR_API_KEY",
    memex: { engineLabel: "Cursor", source: "cursor", store: null, tokenUsage: "yes" },
    localHook: { path: ".cursor/rules", kind: "none" },
    status: {
      kind: "vendored",
      conformance: "not_run",
      needs: ["a conformance run proving the step yields token data"],
    },
  },

  "kilo-code": {
    id: "kilo-code",
    engineId: "kilo-code",
    engineDefinition: "kilo-code.md",
    keySecret: "ANTHROPIC_API_KEY",
    memex: {
      engineLabel: "KiloCode CLI",
      source: "kilocode",
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
    memex: { engineLabel: "Hermes", source: "hermes", store: "a local state.db (path undocumented)", tokenUsage: "yes" },
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

/**
 * The harnesses that can run a role today — those whose engine gh-aw ships,
 * either built into its compiler or as a maintained definition this project
 * vendors. Nothing here waits on anyone installing a CLI.
 */
export function readyHarnesses(): readonly HarnessId[] {
  return (Object.keys(ADAPTERS) as HarnessId[]).filter((id) => ADAPTERS[id].status.kind !== "definition");
}

/**
 * The harnesses that cannot be finished without the CLI in hand, with the
 * reason. Kept as a function rather than a list so the answer comes from the
 * registry and cannot drift from it.
 */
export function blockedHarnesses(): readonly { readonly id: HarnessId; readonly needs: readonly string[] }[] {
  return (Object.keys(ADAPTERS) as HarnessId[])
    .filter((id) => ADAPTERS[id].status.kind === "definition")
    .map((id) => ({ id, needs: ADAPTERS[id].status.needs }));
}

/**
 * Engines gh-aw can run that this factory does not list as a harness.
 *
 * Recorded because it is the cheapest way the supported set can grow: each of
 * these is an engine gh-aw already installs, runs and parses, so adding one is
 * a registry entry and a conformance run rather than an integration. The
 * memex column says whether local correction mining would also work, which is
 * the only thing gh-aw cannot supply.
 */
export const GH_AW_ENGINES_NOT_YET_ADOPTED: readonly {
  readonly engineId: string;
  readonly how: "builtin" | "shared definition";
  readonly memexSource: string | null;
}[] = [
  { engineId: "codex", how: "builtin", memexSource: "codex" },
  { engineId: "copilot", how: "builtin", memexSource: "copilot" },
  { engineId: "gemini", how: "builtin", memexSource: null },
  { engineId: "agy", how: "builtin", memexSource: "antigravity" },
  { engineId: "opencode", how: "shared definition", memexSource: "opencode" },
  { engineId: "goose", how: "shared definition", memexSource: "goose" },
  { engineId: "kiro", how: "shared definition", memexSource: "kiro" },
  { engineId: "aider", how: "shared definition", memexSource: null },
  { engineId: "crush", how: "shared definition", memexSource: null },
  { engineId: "factory", how: "shared definition", memexSource: null },
  { engineId: "langgraph", how: "shared definition", memexSource: null },
  { engineId: "mini-swe-agent", how: "shared definition", memexSource: null },
  { engineId: "deepseek-harness", how: "shared definition", memexSource: null },
];

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
  | { readonly ok: true; readonly source: string; readonly how: "recorded_name" | "engine_label" | "store_path" }
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

  // memex's own name for this engine, as recorded from its SourceKind enum.
  const byName = sources.find((s) => norm(s.name) === norm(adapter.memex.source));
  if (byName !== undefined) return { ok: true, source: byName.name, how: "recorded_name" };

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
