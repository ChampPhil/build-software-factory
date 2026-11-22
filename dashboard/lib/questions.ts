import type { LedgerOpenItem } from "./types";

/**
 * Questions the factory asked before starting.
 *
 * Triage asks one question on the issue and the item waits. Nothing times it
 * out: it stays until someone answers, so the page says how long it has been.
 */

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly user: { readonly login: string; readonly type?: string } | null;
}

/** The newest comment the factory itself wrote, which is the question. */
export function questionFrom(comments: readonly IssueComment[]): string | null {
  const mine = comments.filter((c) => c.user?.type === "Bot" || /\[bot\]$/.test(c.user?.login ?? ""));
  const last = mine[mine.length - 1];
  return last === undefined ? null : last.body.trim();
}

export interface Waiting {
  readonly item: LedgerOpenItem;
  /** The issue number the question is on, or null when the item did not come from an issue. */
  readonly issue: number | null;
}

/** The items waiting on an answer, each with the issue to answer on. */
export function waitingOn(open: readonly LedgerOpenItem[]): readonly Waiting[] {
  return open
    .filter((i) => i.status === "needs_info")
    .map((item) => {
      const m = /^#(\d+)$/.exec(item.source_ref ?? "");
      return { item, issue: m === null ? null : Number(m[1]) };
    });
}

/** "waiting 3 days", for a question nobody has answered. */
export function waitingFor(createdAt: string | undefined, now: Date): string | null {
  if (createdAt === undefined) return null;
  const ms = now.getTime() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "asked just now";
  if (hours < 48) return `asked ${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `asked ${Math.floor(hours / 24)} days ago`;
}
