import { DataRefStore, type Change } from "./dataref.js";
import { assertValid } from "./schema.js";
import type { GitHub } from "./github.js";

/**
 * The layout of `refs/factory/data` (doc 07), and typed access to it.
 *
 * Everything the factory writes about itself is here: work items, run files,
 * the ledger, the rollup index, review reports and benchmark tasks. Each file
 * is validated on read and on write, so a reader never acts on a file whose
 * shape it does not know and a writer cannot persist one (doc 09).
 */

export const LEDGER = "ledger.json";
export const INDEX = "index.json";
export const CURSOR = "events/cursor.json";
export const INCOMING = "events/incoming.jsonl";
export const BUDGET = "budget.json";

export const workItemPath = (id: string): string => `work-items/${id}.json`;
export const runPath = (id: string): string => `runs/${id}.json`;
export const stepReportPath = (runId: string, role: string): string =>
  `runs/${runId}/steps/${role}.json`;
export const reviewPath = (at: string): string => `reviews/${at}.json`;
export const benchmarkResultPath = (id: string): string => `benchmark-results/${id}.json`;
export const livePath = (runId: string): string => `live/${runId}.json`;

export interface Ledger {
  schema: "ledger/1";
  updated_at: string;
  open: {
    work_item: string;
    pipeline: string;
    status: string;
    fingerprint?: string;
    pr?: number | null;
    priority?: "high" | "normal";
    created_at?: string;
    fixes?: string[];
    source_ref?: string | null;
  }[];
  recent: {
    work_item: string;
    status: string;
    merged_at?: string;
    fingerprint?: string;
    pr?: number | null;
  }[];
  merge_queue: { pr: number; eligible_at: string; pipeline?: string; work_item?: string }[];
}

export const emptyLedger = (now: string): Ledger => ({
  schema: "ledger/1",
  updated_at: now,
  open: [],
  recent: [],
  merge_queue: [],
});

export class FactoryStore {
  readonly data: DataRefStore;

  constructor(gh: GitHub, ref?: string) {
    this.data = new DataRefStore(gh, ref);
  }

  /** Read and validate one file, or null when it is absent. */
  async get<T>(path: string, schema: Parameters<typeof assertValid>[0]): Promise<T | null> {
    const doc = await this.data.readJson<unknown>(path);
    if (doc === null) return null;
    assertValid(schema, doc);
    return doc as T;
  }

  async ledger(now: string): Promise<Ledger> {
    return (await this.get<Ledger>(LEDGER, "ledger")) ?? emptyLedger(now);
  }

  /**
   * Validate every change that names a known schema, then commit them as one.
   *
   * The ledger has many writers — intake, every run's start and end, the
   * rollup, the merge queue — each reading it, changing its own entries and
   * writing the whole file back. Written as-is, the last writer erased what
   * landed between its read and its write: ts-webapp lost two queued items
   * that way. So a ledger write is merged: the writer's own changes, taken
   * against what it read, are applied to the ledger as it is now, retried
   * until the ref has not moved underneath.
   */
  async put(changes: readonly Change[], message: string): Promise<string> {
    for (const c of changes) {
      if (c.content === null || !c.path.endsWith(".json")) continue;
      const schema = schemaFor(c.path);
      if (schema === null) continue;
      assertValid(schema, JSON.parse(c.content));
    }
    const mine = changes.find((c) => c.path === LEDGER && c.content !== null);
    const base = mine === undefined ? undefined : this.data.baseOf(LEDGER);
    if (mine === undefined || base === undefined || base === null) {
      const sha = await this.data.commit(changes, message);
      if (mine !== undefined) this.data.wrote(LEDGER, mine.content);
      return sha;
    }
    let written = mine.content;
    const sha = await this.data.commitWithRetry(async () => {
      const current = await this.data.read(LEDGER);
      written =
        current === null || current === base
          ? mine.content
          : json(mergeLedgers(JSON.parse(base) as Ledger, JSON.parse(mine.content as string) as Ledger, JSON.parse(current) as Ledger));
      return changes.map((c) => (c.path === LEDGER ? { ...c, content: written } : c));
    }, message);
    this.data.wrote(LEDGER, written);
    return sha;
  }
}

/** The schema a path's contents must satisfy, by the layout above. */
export function schemaFor(path: string): Parameters<typeof assertValid>[0] | null {
  if (path === LEDGER) return "ledger";
  if (path === INDEX) return "index";
  if (path.startsWith("work-items/")) return "work-item";
  if (/^runs\/[^/]+\/steps\//.test(path)) return "step-report";
  if (path.startsWith("runs/")) return "run";
  if (path.startsWith("live/")) return "live";
  if (path.startsWith("reviews/")) return "review";
  if (path.startsWith("benchmark-results/")) return "benchmark-result";
  if (path.startsWith("benchmarks/")) return "benchmark-task";
  // Files the layout does not name — the event cursor, the budget note — have
  // no shared schema. Guessing one would reject legitimate writes.
  return null;
}

/** JSON, newline-terminated, stable key order as written. */
export const json = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

/* ------------------------------------------------------------- ledger merge */

type Keyed<T> = { readonly key: (x: T) => string };

/** Apply the change from `base` to `mine` onto `current`, entry by entry. */
function mergeList<T>(base: readonly T[], mine: readonly T[], current: readonly T[], k: Keyed<T>): T[] {
  const b = new Map(base.map((x) => [k.key(x), JSON.stringify(x)]));
  const m = new Map(mine.map((x) => [k.key(x), x]));
  const out = new Map(current.map((x) => [k.key(x), x]));
  // What the writer removed.
  for (const key of b.keys()) if (!m.has(key)) out.delete(key);
  // What the writer added or changed. An entry it left as it read it keeps
  // whatever another writer did to it since.
  for (const [key, x] of m) if (b.get(key) !== JSON.stringify(x)) out.set(key, x);
  // Keep current order, then the writer's new entries in its order.
  const order = [...current.map((x) => k.key(x)), ...mine.map((x) => k.key(x))];
  const seen = new Set<string>();
  const result: T[] = [];
  for (const key of order) {
    if (seen.has(key) || !out.has(key)) continue;
    seen.add(key);
    result.push(out.get(key)!);
  }
  return result;
}

/**
 * A three-way merge of the ledger: `base` is what a writer read, `mine` what
 * it wants to write, `current` what is there now.
 */
export function mergeLedgers(base: Ledger, mine: Ledger, current: Ledger): Ledger {
  return {
    ...current,
    updated_at: mine.updated_at > current.updated_at ? mine.updated_at : current.updated_at,
    open: mergeList(base.open, mine.open, current.open, { key: (o) => o.work_item }),
    recent: mergeList(base.recent, mine.recent, current.recent, { key: (r) => r.work_item }),
    merge_queue: mergeList(base.merge_queue, mine.merge_queue, current.merge_queue, { key: (q) => String(q.pr) }),
  };
}
