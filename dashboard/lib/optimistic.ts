/**
 * An action that shows its result at once and takes it back if it fails.
 *
 * `act(fn, done, key)` marks `key` as held the moment it starts: the page hides
 * or relabels whatever the key names. The mark is dropped when
 *   - the call fails (with the reason said in words),
 *   - the factory's own records show the change (confirmed), or
 *   - sixty seconds pass without that (then it says so, and the thing is back).
 *
 * Keys name what changed, and `isConfirmed` says how each is seen in the data:
 *   pr-gone:<n>            a pull request merged or closed: it is no longer open
 *   issue-gone:<n>         an issue closed: it is no longer open
 *   issue-accepted:<n>     the factory:accept label landed
 *   answered:<work item>   the request is no longer waiting on an answer
 *   candidate-decided:<id> the proposed rule is no longer pending
 */
export const HOLD_MS = 60_000;

export type Held = Readonly<Record<string, number>>;

export interface HeldData {
  readonly pulls: readonly { readonly number: number }[] | null;
  readonly issues: readonly { readonly number: number; readonly labels: readonly { readonly name: string }[] }[] | null;
  readonly open: readonly { readonly work_item: string; readonly status: string }[] | null;
  readonly pendingCandidates: readonly string[] | null;
}

export interface ActionDeps {
  readonly say: (text: string) => void;
  readonly refresh: () => void;
  readonly hold: (key: string) => void;
  readonly release: (key: string) => void;
}

export async function runAction(
  fn: () => Promise<unknown>,
  done: string,
  deps: ActionDeps,
  key: string | undefined,
  reason: (e: unknown) => string,
): Promise<boolean> {
  if (key !== undefined) deps.hold(key);
  deps.say("Saving…");
  try {
    await fn();
    deps.say(done);
    deps.refresh();
    return true;
  } catch (e) {
    if (key !== undefined) deps.release(key);
    deps.say(`Could not do that: ${reason(e)}`);
    return false;
  }
}

/** Whether the records already show what a held key promised. Unknown data is never confirmation. */
export function isConfirmed(key: string, d: HeldData): boolean {
  const [kind, ...rest] = key.split(":");
  const id = rest.join(":");
  switch (kind) {
    case "pr-gone":
      return d.pulls !== null && !d.pulls.some((p) => String(p.number) === id);
    case "issue-gone":
      return d.issues !== null && !d.issues.some((i) => String(i.number) === id);
    case "issue-accepted": {
      if (d.issues === null) return false;
      const issue = d.issues.find((i) => String(i.number) === id);
      return issue === undefined || issue.labels.some((l) => l.name === "factory:accept");
    }
    case "answered":
      return d.open !== null && !d.open.some((o) => o.work_item === id && o.status === "needs_info");
    case "candidate-decided":
      return d.pendingCandidates !== null && !d.pendingCandidates.includes(id);
    default:
      return false;
  }
}

/** Drop what the records confirmed, and what has been held past `holdMs`; say which timed out. */
export function sweep(held: Held, now: number, d: HeldData, holdMs = HOLD_MS): { readonly held: Held; readonly timedOut: readonly string[] } {
  const next: Record<string, number> = {};
  const timedOut: string[] = [];
  for (const [key, at] of Object.entries(held)) {
    if (isConfirmed(key, d)) continue;
    if (now - at >= holdMs) {
      timedOut.push(key);
      continue;
    }
    next[key] = at;
  }
  return { held: next, timedOut };
}
