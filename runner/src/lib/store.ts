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

  /** Validate every change that names a known schema, then commit them as one. */
  async put(changes: readonly Change[], message: string): Promise<string> {
    for (const c of changes) {
      if (c.content === null || !c.path.endsWith(".json")) continue;
      const schema = schemaFor(c.path);
      if (schema === null) continue;
      assertValid(schema, JSON.parse(c.content));
    }
    return this.data.commit(changes, message);
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
  if (path.startsWith("benchmarks/")) return "benchmark-task";
  // Files the layout does not name — the event cursor, the budget note — have
  // no shared schema. Guessing one would reject legitimate writes.
  return null;
}

/** JSON, newline-terminated, stable key order as written. */
export const json = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;
