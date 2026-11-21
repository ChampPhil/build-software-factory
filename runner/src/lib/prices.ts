/**
 * Anthropic list prices, USD per million tokens, and each model's limits.
 *
 * Source: platform.claude.com/docs/en/about-claude/pricing and each model's
 * overview page, read 2026-11-21. They are used for one thing the budget
 * cannot do without: an upper bound on what a single request can cost, which
 * is how far a step may run past its gh-aw credit cap (the cap is checked
 * before each request, so the request that crosses it still goes through).
 *
 * A model missing here has no bound, so the budget refuses to start it
 * rather than guess.
 */
export interface ModelPrice {
  /** Base input. */
  readonly input: number;
  /** The dearest way an input token can be billed: a one-hour cache write. */
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
}

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, cacheWrite1h: 8, cacheRead: 0.2, output: 20, contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-5-5": { input: 2, cacheWrite1h: 4, cacheRead: 0.1, output: 10, contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  // Haiku 5.5 is priced by prompt length; the over-100k rates are the bound.
  "claude-haiku-5-5": { input: 0.5, cacheWrite1h: 1, cacheRead: 0.05, output: 2.5, contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-opus-5": { input: 5, cacheWrite1h: 10, cacheRead: 0.5, output: 25, contextTokens: 1_000_000, maxOutputTokens: 128_000 },
  "claude-sonnet-5": { input: 2, cacheWrite1h: 4, cacheRead: 0.2, output: 10, contextTokens: 1_000_000, maxOutputTokens: 128_000 },
};

/**
 * What Claude Code lets one request carry, as every role workflow configures
 * it: CLAUDE_CODE_DISABLE_1M_CONTEXT keeps the window at 200k (Claude Code
 * compacts before a request would pass it), and one tool result can land on
 * top before it does, which Claude Code caps at about 30k; 250k covers both.
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS caps output at 32k. A test fails if a role
 * workflow stops setting either.
 */
export const HARNESS_LIMITS = { contextTokens: 250_000, maxOutputTokens: 32_000 } as const;

/**
 * The most one request to this model can cost: the largest input it can be
 * sent, billed at the dearest input rate, plus the most output it can
 * return. Null for a model with no listed price.
 */
export function worstRequestUsd(model: string): number | null {
  const p = PRICES[model];
  if (p === undefined) return null;
  const input = Math.min(p.contextTokens, HARNESS_LIMITS.contextTokens);
  const output = Math.min(p.maxOutputTokens, HARNESS_LIMITS.maxOutputTokens);
  return (input * p.cacheWrite1h + output * p.output) / 1_000_000;
}

/**
 * What a step's tokens cost at list price, every input token at the rate it
 * was billed (cache writes at the one-hour rate, the dearer of the two).
 * Null for a model with no listed price.
 */
export function listCostUsd(
  model: string,
  usage: { readonly tokensIn: number; readonly tokensOut: number; readonly cacheRead: number; readonly cacheWrite: number },
): number | null {
  const p = PRICES[model];
  if (p === undefined) return null;
  return (usage.tokensIn * p.input + usage.tokensOut * p.output + usage.cacheRead * p.cacheRead + usage.cacheWrite * p.cacheWrite1h) / 1_000_000;
}
