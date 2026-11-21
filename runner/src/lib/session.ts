import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reading tokens and cost out of gh-aw's agent session evidence.
 *
 * gh-aw normalizes whatever the harness emitted into `agent-session.jsonl`,
 * and its API proxy meters tokens into `token-usage.jsonl`, both inside the
 * agent job — which is where a role workflow's post-steps run. (The fully
 * merged `usage/aw_session.jsonl` is produced later, in the conclusion job, so
 * it is not available to a post-step.)
 *
 * Two rules from gh-aw's own session specification are followed here, because
 * they are the difference between a cost number and a guess:
 *
 * - **Absence is not zero.** A missing cost is unavailable, not free. The
 *   factory's budget pauses pipelines on spend, so a fabricated zero would
 *   quietly raise the ceiling.
 * - **Aliases are the same metric, not extra ones.** `input_tokens` and
 *   `inputTokens` are one value; adding them would double every count.
 */

export interface SessionUsage {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Null when no source reported one. Never 0 as a stand-in. */
  readonly costUsd: number | null;
  readonly from: "agent_session" | "token_usage";
}

interface UsageBlock {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
}

interface SessionEvent {
  type?: string;
  totalCostUsd?: number;
  total_cost_usd?: number;
  usage?: UsageBlock;
  data?: { usage?: UsageBlock; totalCostUsd?: number; total_cost_usd?: number };
}

/** First of the aliases that is a finite number; aliases are one metric. */
function pick(block: UsageBlock | undefined, ...keys: readonly (keyof UsageBlock)[]): number {
  if (block === undefined) return 0;
  for (const k of keys) {
    const v = block[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

export function parseJsonl(text: string): readonly SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    try {
      out.push(JSON.parse(t) as SessionEvent);
    } catch {
      // A truncated last line is normal in a log still being written; the
      // rest of the file is still good evidence.
    }
  }
  return out;
}

/**
 * Sum the usage across a session's accounting events.
 *
 * Costs are summed only where reported. If no event carried one, the cost is
 * null even though tokens were counted — the caller then prices the tokens, or
 * reports the cost as unknown.
 */
export function usageFromSession(events: readonly SessionEvent[], from: SessionUsage["from"]): SessionUsage | null {
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let sawCost = false;
  let sawAny = false;

  for (const e of events) {
    const usage = e.usage ?? e.data?.usage;
    const eventCost = e.totalCostUsd ?? e.total_cost_usd ?? e.data?.totalCostUsd ?? e.data?.total_cost_usd;

    if (usage !== undefined) {
      tokensIn += pick(usage, "input_tokens", "inputTokens");
      tokensOut += pick(usage, "output_tokens", "outputTokens");
      cacheRead += pick(usage, "cache_read_input_tokens", "cacheReadInputTokens");
      cacheWrite += pick(usage, "cache_creation_input_tokens", "cacheCreationInputTokens");
      sawAny = true;
    }
    if (typeof eventCost === "number" && Number.isFinite(eventCost)) {
      cost += eventCost;
      sawCost = true;
      sawAny = true;
    }
  }

  if (!sawAny) return null;
  return {
    tokensIn,
    tokensOut,
    cacheRead,
    cacheWrite,
    costUsd: sawCost ? cost : null,
    from,
  };
}

/** The files gh-aw leaves in the agent job, in the order they are trusted. */
export const SESSION_FILES = [
  { path: "agent-session.jsonl", from: "agent_session" as const },
  // The proxy's own metering. Second because it counts what crossed the
  // firewall, which can include gh-aw's own calls as well as the agent's.
  { path: "token-usage.jsonl", from: "token_usage" as const },
] as const;

/**
 * Read whichever of gh-aw's session files is present in the agent job.
 *
 * `dir` is where gh-aw writes them, normally `${RUNNER_TEMP}/gh-aw` or the
 * uploaded agent artifact's directory; both layouts are tried.
 */
export function readSessionUsage(dirs: readonly string[]): SessionUsage | null {
  for (const { path, from } of SESSION_FILES) {
    for (const dir of dirs) {
      const full = join(dir, path);
      if (!existsSync(full)) continue;
      const usage = usageFromSession(parseJsonl(readFileSync(full, "utf8")), from);
      if (usage !== null) return usage;
    }
  }
  return null;
}
