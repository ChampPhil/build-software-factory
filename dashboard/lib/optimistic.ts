/**
 * An action that shows its result at once and takes it back if it fails.
 * `apply` changes what the page shows; `rollback` restores it. The state is
 * held until the factory's records confirm it or `holdMs` passes, whichever
 * comes first; after that the page shows what the records say.
 */
export interface Optimistic {
  readonly apply: () => void;
  readonly rollback: () => void;
}

export const HOLD_MS = 60_000;

export interface ActionDeps {
  readonly say: (text: string) => void;
  readonly refresh: () => void;
}

export async function runAction(
  fn: () => Promise<unknown>,
  done: string,
  deps: ActionDeps,
  optimistic: Optimistic | undefined,
  reason: (e: unknown) => string,
): Promise<boolean> {
  optimistic?.apply();
  deps.say("Saving…");
  try {
    await fn();
    deps.say(done);
    deps.refresh();
    return true;
  } catch (e) {
    optimistic?.rollback();
    deps.say(`Could not do that: ${reason(e)}`);
    return false;
  }
}

/** True when an optimistic change has outlived the time it may be held without the records confirming it. */
export const expired = (appliedAt: number, now: number, holdMs = HOLD_MS): boolean => now - appliedAt >= holdMs;
