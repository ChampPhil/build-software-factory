import { describe, it, expect } from "vitest";
import {
  reserve, settle, sweepStale, ceilingUsd, used, shareLimitUsd, creditsToUsd, emptyBudget,
  type BudgetDoc, type BudgetLimits, type ReserveRequest,
} from "../src/commands/budget.js";
import { worstRequestUsd, PRICES } from "../src/lib/prices.js";
import { DataRefStore } from "../src/lib/dataref.js";
import type { GitHub } from "../src/lib/github.js";

const NOW = "2026-11-21T20:00:00.000Z";
const LIMITS: BudgetLimits = {
  monthlyUsd: 35,
  shares: { product_work: 60, gardening: 25, review_and_benchmarks: 15 },
  productHardStopPct: 110,
};

const step = (over: Partial<ReserveRequest> = {}): ReserveRequest => ({
  key: "run1-1-builder-1",
  pipeline: "product_work",
  role: "builder",
  model: "claude-sonnet-5-5",
  capCredits: 400,
  detectionModel: "claude-haiku-5-5",
  detectionCapCredits: 50,
  ...over,
});

const okDoc = (r: ReturnType<typeof reserve>): BudgetDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

describe("prices", () => {
  it("bound one request by the largest input Claude Code sends at the dearest rate, plus its output cap", () => {
    // Sonnet 5.5: 250k x $4 (1h cache write) + 32k x $10 = $1.32.
    expect(worstRequestUsd("claude-sonnet-5-5")).toBeCloseTo(1.32, 6);
    // Opus 5.5: 250k x $8 + 32k x $20 = $2.64.
    expect(worstRequestUsd("claude-opus-5-5")).toBeCloseTo(2.64, 6);
    expect(worstRequestUsd("not-a-model")).toBeNull();
  });

  it("reproduce the live cap test's metered cost from list prices", () => {
    // go-cli run 44946845429: 23,243 tokens written to the 5-minute cache at
    // $2.50/M, 2 uncached input at $2/M and 267 out at $10/M; gh-aw metered
    // 6.07815 credits and Claude Code reported $0.0607815.
    const p = PRICES["claude-sonnet-5-5"]!;
    const cost = (23_243 * 2.5 + 2 * p.input + 267 * p.output) / 1_000_000;
    expect(cost * 100).toBeCloseTo(6.07815, 4);
  });
});

describe("reserve", () => {
  it("holds the cap plus one request for the agent and for detection", () => {
    const r = reserve(null, step(), LIMITS, NOW);
    const agent = ceilingUsd(400, "claude-sonnet-5-5")!;
    const detection = ceilingUsd(50, "claude-haiku-5-5")!;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.holdUsd).toBeCloseTo(agent + detection, 4);
    expect(okDoc(r).inflight).toHaveLength(1);
  });

  it("refuses a step that could pass the monthly budget, even with money left", () => {
    const doc: BudgetDoc = { ...emptyBudget(NOW), spent_usd: { product_work: 20 } };
    const r = reserve(doc, step(), LIMITS, NOW);
    // $20 spent + ~$6.3 for this step is over the product share (60% x 110% of $35 = $23.10).
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could cost up to/);
  });

  it("counts steps still running, so two runs cannot both take the last dollars", () => {
    const first = okDoc(reserve(null, step({ key: "a" }), LIMITS, NOW));
    const second = reserve(first, step({ key: "b" }), LIMITS, NOW);
    const third = reserve(okDoc(second), step({ key: "c" }), LIMITS, NOW);
    // Each Sonnet builder holds ~$6.31; three fit in the $23.10 product
    // share, a fourth would not.
    expect(third.ok).toBe(true);
    const fourth = reserve(okDoc(third), step({ key: "d" }), LIMITS, NOW);
    expect(fourth.ok).toBe(false);
  });

  it("refuses a model with no list price rather than guess its cost", () => {
    const r = reserve(null, step({ model: "auto" }), LIMITS, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no list price for auto/);
  });

  it("refuses everything when the budget is zero", () => {
    expect(reserve(null, step(), { ...LIMITS, monthlyUsd: 0 }, NOW).ok).toBe(false);
  });

  it("holds once when the same step asks twice, and never reruns a charged step", () => {
    const once = okDoc(reserve(null, step(), LIMITS, NOW));
    const twice = reserve(once, step(), LIMITS, NOW);
    expect(twice.ok && twice.doc.inflight.length).toBe(1);
    const charged = settle(once, { key: step().key, agentUsd: 1, detectionUsd: 0.01 }, NOW).doc;
    expect(reserve(charged, step(), LIMITS, NOW).ok).toBe(false);
  });

  it("charges setup against the total only", () => {
    const r = reserve(null, step({ pipeline: "setup", role: "setup", capCredits: 1000 }), LIMITS, NOW);
    expect(r.ok).toBe(true);
  });

  it("starts a new month with nothing spent", () => {
    const doc: BudgetDoc = { ...emptyBudget("2026-10-31T23:00:00Z"), spent_usd: { product_work: 34 } };
    expect(reserve(doc, step(), LIMITS, NOW).ok).toBe(true);
  });
});

describe("settle", () => {
  it("replaces the hold with the measured cost", () => {
    const held = okDoc(reserve(null, step(), LIMITS, NOW));
    const r = settle(held, { key: step().key, agentUsd: 1.234, detectionUsd: 0.01 }, NOW);
    expect(r.chargedUsd).toBeCloseTo(1.244, 4);
    expect(r.doc.inflight).toHaveLength(0);
    expect(r.doc.spent_usd["product_work"]).toBeCloseTo(1.244, 4);
  });

  it("charges the ceiling when a cost is missing: absence is not zero", () => {
    const held = okDoc(reserve(null, step(), LIMITS, NOW));
    const r = settle(held, { key: step().key, agentUsd: null, detectionUsd: 0.01 }, NOW);
    expect(r.chargedUsd).toBeCloseTo(ceilingUsd(400, "claude-sonnet-5-5")! + 0.01, 4);
  });

  it("charges nothing twice", () => {
    const held = okDoc(reserve(null, step(), LIMITS, NOW));
    const once = settle(held, { key: step().key, agentUsd: 1, detectionUsd: 0 }, NOW).doc;
    const twice = settle(once, { key: step().key, agentUsd: 1, detectionUsd: 0 }, NOW);
    expect(twice.chargedUsd).toBe(0);
    expect(twice.doc.spent_usd["product_work"]).toBe(1);
  });

  it("reads gh-aw's credits as dollars, and an empty output as missing", () => {
    expect(creditsToUsd("6.07815")).toBeCloseTo(0.0607815, 7);
    expect(creditsToUsd("")).toBeNull();
    expect(creditsToUsd(undefined)).toBeNull();
    expect(creditsToUsd("n/a")).toBeNull();
  });
});

describe("a run through the budget", () => {
  it("spends, settles and then refuses at the share, the path the old cap never took", () => {
    let doc: BudgetDoc | null = null;
    let runs = 0;
    for (let i = 0; i < 50; i++) {
      const r = reserve(doc, step({ key: `run${i}` }), LIMITS, NOW);
      if (!r.ok) break;
      doc = settle(r.doc, { key: `run${i}`, agentUsd: 3, detectionUsd: 0.02 }, NOW).doc;
      runs++;
    }
    const spent = used(doc!, "product_work").share;
    expect(runs).toBeGreaterThan(0);
    // Never past the share, and the last step refused had real money left.
    expect(spent).toBeLessThanOrEqual(shareLimitUsd(LIMITS, "product_work"));
    expect(reserve(doc, step({ key: "next" }), LIMITS, NOW).ok).toBe(false);
  });

  it("charges holds left by a dead run at their ceiling once stale", () => {
    const held = okDoc(reserve(null, step(), LIMITS, "2026-11-21T10:00:00Z"));
    const r = sweepStale(held, NOW, 4 * 3600);
    expect(r.swept).toEqual([step().key]);
    expect(r.doc.inflight).toHaveLength(0);
    expect(r.doc.spent_usd["product_work"]).toBeCloseTo(ceilingUsd(400, "claude-sonnet-5-5")! + ceilingUsd(50, "claude-haiku-5-5")!, 4);
  });
});

/** A data ref in memory whose head can be moved under a writer. */
function fakeRef(): { gh: GitHub; moveHead: () => void } {
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const trees = new Map<string, Map<string, string>>();
  const blobs = new Map<string, string>();
  let head: string | null = null;
  let n = 0;
  let pendingMove = false;
  const id = (p: string): string => `${p}${++n}`;
  const send = async (method: string, url: string, body?: Record<string, unknown>): Promise<unknown> => {
    if (url.endsWith("/git/blobs")) {
      const sha = id("b");
      blobs.set(sha, Buffer.from(String(body!["content"]), "base64").toString("utf8"));
      return { sha };
    }
    if (url.endsWith("/git/trees")) {
      const base = body!["base_tree"] as string | undefined;
      const files = new Map(base === undefined ? [] : trees.get(base)!);
      for (const e of body!["tree"] as { path: string; sha: string }[]) files.set(e.path, e.sha);
      const sha = id("t");
      trees.set(sha, files);
      return { sha };
    }
    if (url.endsWith("/git/commits")) {
      const sha = id("c");
      commits.set(sha, { tree: String(body!["tree"]), parents: body!["parents"] as string[] });
      return { sha };
    }
    if (method === "POST" && url.endsWith("/git/refs")) {
      head = String(body!["sha"]);
      return {};
    }
    if (method === "PATCH") {
      if (pendingMove) {
        // Another writer lands first: the ref moves to a sibling commit.
        pendingMove = false;
        const c = commits.get(head!)!;
        const sib = id("c");
        commits.set(sib, { tree: c.tree, parents: [head!] });
        head = sib;
      }
      const next = String(body!["sha"]);
      if (commits.get(next)!.parents[0] !== head) throw new Error("422 not a fast forward");
      head = next;
      return {};
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const get = async (url: string): Promise<unknown> => {
    if (url.includes("/git/ref/")) {
      if (head === null) throw new Error("404");
      return { object: { sha: head } };
    }
    const commit = /\/git\/commits\/(\w+)$/.exec(url);
    if (commit !== null) return { tree: { sha: commits.get(commit[1]!)!.tree } };
    const tree = /\/git\/trees\/(\w+)/.exec(url);
    if (tree !== null) {
      return { sha: tree[1], tree: [...trees.get(tree[1]!)!].map(([path, sha]) => ({ path, sha, type: "blob" })) };
    }
    const blob = /\/git\/blobs\/(\w+)$/.exec(url);
    if (blob !== null) return { content: blobs.get(blob[1]!)!, encoding: "utf-8" };
    throw new Error(`unexpected GET ${url}`);
  };
  const gh = { repo: "o/r", send, get } as unknown as GitHub;
  return { gh, moveHead: () => { pendingMove = true; } };
}

describe("updateJson", () => {
  it("re-reads and recomputes when another writer lands first, instead of writing a stale value", async () => {
    const { gh, moveHead } = fakeRef();
    const store = new DataRefStore(gh, "refs/factory/data");
    await store.updateJson<{ n: number }, void>("c.json", () => ({ next: { n: 1 }, result: undefined }), "init");
    let calls = 0;
    moveHead();
    await store.updateJson<{ n: number }, void>(
      "c.json",
      (cur) => {
        calls++;
        return { next: { n: (cur?.n ?? 0) + 1 }, result: undefined };
      },
      "inc",
    );
    expect(calls).toBe(2);
    expect(JSON.parse((await store.read("c.json"))!)).toEqual({ n: 2 });
  });
});
