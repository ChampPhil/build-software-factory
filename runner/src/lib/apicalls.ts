import { apiCallCount, type GitHub } from "./github.js";
import { DataRefStore } from "./dataref.js";

/** Below this many requests left in the hour, the factory says so (fix 2). */
export const RATE_WARN_REMAINING = 300;

/**
 * Print how many API calls this command made and how many the installation
 * has left this hour, and write `ratelimit.json` to the data ref when the
 * hour is nearly spent so the dashboard can say why the factory went quiet.
 * Never throws: a failure here must not fail the command it reports on.
 */
export async function reportApiCalls(gh: GitHub, now: string, write: (s: string) => void): Promise<void> {
  try {
    const rl = await gh.get<{ resources: { core: { remaining: number; limit: number; reset: number } } }>("rate_limit");
    const { remaining, limit, reset } = rl.resources.core;
    write(`api calls: ${apiCallCount()}, remaining: ${remaining}\n`);
    if (remaining < RATE_WARN_REMAINING) {
      const text = JSON.stringify({ at: now, remaining, limit, resets_at: new Date(reset * 1000).toISOString() }, null, 2);
      await new DataRefStore(gh).commitWithRetry(async () => [{ path: "ratelimit.json", content: `${text}\n` }], "rate limit: nearly spent");
    }
  } catch {
    write(`api calls: ${apiCallCount()}\n`);
  }
}
