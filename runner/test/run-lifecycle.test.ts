import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory data ref, so the lifecycle is tested for what it writes, not
// for the Git Data API calls the store makes (dataref-api.test.ts covers those).
const files = new Map<string, string>();
const commits: string[] = [];
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FactoryStore {
    data = {
      read: async (p: string) => files.get(p) ?? null,
      readJson: async (p: string) => (files.has(p) ? (JSON.parse(files.get(p)!) as unknown) : null),
      list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
    };
    async get<T>(p: string): Promise<T | null> {
      const t = files.get(p);
      return t === undefined ? null : (JSON.parse(t) as T);
    }
    async ledger(now: string) {
      return (await this.get(real.LEDGER)) ?? real.emptyLedger(now);
    }
    async put(changes: { path: string; content: string | null }[], message: string) {
      for (const c of changes) {
        if (c.content === null) files.delete(c.path);
        else {
          const schema = real.schemaFor(c.path);
          if (schema !== null) (await import("../src/lib/schema.js")).assertValid(schema, JSON.parse(c.content));
          files.set(c.path, c.content);
        }
      }
      commits.push(message);
      return "sha";
    }
  }
  return { ...real, FactoryStore };
});

const { startRun, finishRun, gateVerdicts, gateFailuresPath, reapStaleRuns, prClosed, dropItems } = await import("../src/commands/run-lifecycle.js");

const WI = "wi_01M7XHGA7F5CNWC3BD3BSP0WYW";
const RUN = "run_01M7XHGA7F5CNWC3BD3BSP0WYX";
const item = (status = "queued") => ({
  schema: "work-item/1",
  id: WI,
  created_at: "2026-11-20T00:00:00Z",
  source: { kind: "issue", ref: "#9", actor: "someone" },
  trigger_class: "request",
  pipeline: "product_work",
  title: "Show the total",
  body: "",
  priority: "normal",
  fingerprint: `sha256:${"a".repeat(64)}`,
  status,
  runs: [],
  pr: null,
});

function fakeGh(checks: { name: string; status: string; conclusion: string | null; text?: string }[][]) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  const dispatched: Record<string, string>[] = [];
  let poll = 0;
  const gh = {
    repo: "o/r",
    pull: async () => ({ number: 5, draft: true, node_id: "PR_x", head: { sha: "abc1234" } }),
    get: async (path: string) => {
      if (path.includes("/check-runs")) {
        const now = checks[Math.min(poll++, checks.length - 1)] ?? [];
        return { check_runs: now.map((c) => ({ ...c, output: { title: c.name, summary: "s", text: c.text ?? null } })) };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    send: async (method: string, path: string, body: unknown) => {
      sent.push({ method, path, body });
      return {};
    },
    markReady: async () => {
      sent.push({ method: "READY", path: "", body: null });
    },
    dispatchWorkflow: async (_w: string, _r: unknown, inputs: Record<string, string>) => {
      dispatched.push(inputs);
    },
  };
  return { gh: gh as never, sent, dispatched };
}

const base = { workItem: WI, runId: RUN, maxAttempts: 3, buildResult: "success", now: () => "2026-11-20T01:00:00Z", waitMs: 60_000, pollMs: 1, sleep: async () => undefined };

beforeEach(() => {
  files.clear();
  commits.length = 0;
});

describe("startRun", () => {
  it("moves a queued item to running and records the run as live", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify(item()));
    const r = await startRun({ gh: fakeGh([]).gh, workItem: WI, attempt: 1, escalate: false, firstStep: "triage", now: "2026-11-20T00:30:00Z", runId: RUN });
    expect(r.status).toBe("running");
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("running");
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).runs).toEqual([RUN]);
    expect(files.has(`live/${RUN}.json`)).toBe(true);
    expect(JSON.parse(files.get("ledger.json")!).open[0].status).toBe("running");
  });

  it("refuses an item that is not queued, so a second dispatch cannot start it again", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify(item("in_review")));
    const r = await startRun({ gh: fakeGh([]).gh, workItem: WI, attempt: 1, escalate: false, firstStep: "builder", now: "2026-11-20T00:30:00Z" });
    expect(r).toMatchObject({ runId: "", status: "not_claimed" });
    expect(commits).toEqual([]);
  });

  it("escalates past the cap and records no live run", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify(item("running")));
    const r = await startRun({ gh: fakeGh([]).gh, workItem: WI, attempt: 4, escalate: true, firstStep: "builder", now: "2026-11-20T00:30:00Z", runId: RUN });
    expect(r.status).toBe("escalated");
    expect(files.has(`live/${RUN}.json`)).toBe(false);
  });
});

describe("gateVerdicts", () => {
  it("reads static and verification from the gate checks, and the aggregate as the backstop", () => {
    expect(gateVerdicts([{ name: "factory/gate-static", status: "completed", conclusion: "failure", title: null, summary: null, text: null }]).staticGate).toBe("failed");
    expect(gateVerdicts([{ name: "factory/gates", status: "completed", conclusion: "failure", title: null, summary: null, text: null }]).verificationGate).toBe("failed");
    const pass = gateVerdicts([
      { name: "factory/gate-static", status: "completed", conclusion: "success", title: null, summary: null, text: null },
      { name: "factory/gate-tests", status: "completed", conclusion: "success", title: null, summary: null, text: null },
    ]);
    expect(pass).toEqual({ staticGate: "passed", verificationGate: "passed" });
  });
});

describe("finishRun", () => {
  beforeEach(() => {
    files.set(`work-items/${WI}.json`, JSON.stringify(item("running")));
    files.set(`live/${RUN}.json`, "{}");
  });

  it("waits for factory/gates, then clears: PR ready, labelled, item in review, live record gone", async () => {
    const { gh, sent } = fakeGh([
      [],
      [
        { name: "factory/gate-static", status: "completed", conclusion: "success" },
        { name: "factory/gates", status: "completed", conclusion: "success" },
      ],
    ]);
    const r = await finishRun({ ...base, gh, attempt: 1, pr: 5 });
    expect(r.next).toBe("clear");
    expect(sent.some((s) => s.method === "READY")).toBe(true);
    expect(sent.some((s) => s.path.endsWith("/issues/5/labels"))).toBe(true);
    const wi = JSON.parse(files.get(`work-items/${WI}.json`)!);
    expect(wi.status).toBe("in_review");
    expect(wi.pr).toBe(5);
    expect(files.has(`live/${RUN}.json`)).toBe(false);
  });

  it("writes the run's record, with each role's cost from its StepReport", async () => {
    const { gh } = fakeGh([[{ name: "factory/gate-static", status: "completed", conclusion: "success" }, { name: "factory/gates", status: "completed", conclusion: "success" }]]);
    const step = { role: "builder", model: "claude-opus-5", exit: "ok" as const, duration_sec: 600, tokens: { in: 1000, out: 200 }, cost_usd: 3.25, transcript: null };
    await finishRun({ ...base, gh, attempt: 1, pr: 5, steps: [step, { ...step, role: "spec", cost_usd: 1.5 }] });
    const rec = JSON.parse(files.get(`runs/${RUN}.json`)!);
    expect(rec.outcome).toBe("draft_pr");
    expect(rec.cost_usd).toBe(4.75);
    expect(rec.gates.map((g: { gate: string; result: string }) => `${g.gate}:${g.result}`)).toEqual(["static:pass", "verification:skipped"]);
  });

  it("on a failed gate under the cap, stores the failures and dispatches the next attempt on the same PR", async () => {
    const { gh, dispatched } = fakeGh([
      [
        { name: "factory/gate-static", status: "completed", conclusion: "failure", text: "lib/a.ts:3 no-unused-vars" },
        { name: "factory/gates", status: "completed", conclusion: "failure" },
      ],
    ]);
    const r = await finishRun({ ...base, gh, attempt: 1, pr: 5 });
    expect(r.next).toBe("retry");
    expect(dispatched).toEqual([{ work_item: WI, attempt: "2", pr_number: "5" }]);
    const failures = JSON.parse(files.get(gateFailuresPath(WI))!);
    expect(failures.items.map((i: { check: string }) => i.check)).toContain("factory/gate-static");
    expect(failures.items[0].text).toContain("no-unused-vars");
  });

  it("at the cap, escalates and says so on the PR", async () => {
    const { gh, sent, dispatched } = fakeGh([[{ name: "factory/gates", status: "completed", conclusion: "failure" }]]);
    const r = await finishRun({ ...base, gh, attempt: 3, pr: 5 });
    expect(r.next).toBe("escalate");
    expect(dispatched).toEqual([]);
    expect(sent.some((s) => s.path.endsWith("/issues/5/comments"))).toBe(true);
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("escalated");
  });

  it("with no PR, retries the build, and at the cap tells the source issue", async () => {
    const a = fakeGh([]);
    expect((await finishRun({ ...base, gh: a.gh, attempt: 1, pr: null, buildResult: "failure" })).next).toBe("retry");
    files.set(`work-items/${WI}.json`, JSON.stringify(item("running")));
    const b = fakeGh([]);
    expect((await finishRun({ ...base, gh: b.gh, attempt: 3, pr: null, buildResult: "failure" })).next).toBe("escalate");
    expect(b.sent.some((s) => s.path.endsWith("/issues/9/comments"))).toBe(true);
  });

  it("leaves the item in review when the gates never report in time", async () => {
    let t = 0;
    const { gh } = fakeGh([[]]);
    const r = await finishRun({ ...base, gh, attempt: 1, pr: 5, now: () => new Date(Date.parse("2026-11-20T01:00:00Z") + (t += 40_000)).toISOString() });
    expect(r.next).toBe("timed_out");
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("in_review");
  });
});

describe("reapStaleRuns", () => {
  const ghWithRun = (status: string) =>
    ({ repo: "o/r", get: async (p: string) => (p.includes("/actions/runs/") ? { status } : {}) }) as never;

  it("ends a cancelled run's live record and puts its item back in the queue", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("running"), runs: [RUN] }));
    files.set(`live/${RUN}.json`, JSON.stringify({ run: RUN, work_item: WI, started_at: "2026-11-20T00:00:00Z", actions_run: 42 }));
    const r = await reapStaleRuns(ghWithRun("completed"), "2026-11-20T00:10:00Z");
    expect(r.reaped).toEqual([{ run: RUN, work_item: WI, requeued: true }]);
    expect(files.has(`live/${RUN}.json`)).toBe(false);
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("queued");
  });

  it("leaves a run that is still going", async () => {
    files.set(`live/${RUN}.json`, JSON.stringify({ run: RUN, work_item: WI, started_at: "2026-11-20T00:00:00Z", actions_run: 42 }));
    expect((await reapStaleRuns(ghWithRun("in_progress"), "2026-11-20T00:10:00Z")).reaped).toEqual([]);
  });

  it("does not requeue an item a later run has taken", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("running"), runs: [RUN, "run_01M7XHGA7F5CNWC3BD3BSP0WZZ"] }));
    files.set(`live/${RUN}.json`, JSON.stringify({ run: RUN, work_item: WI, started_at: "2026-11-20T00:00:00Z", actions_run: 42 }));
    const r = await reapStaleRuns(ghWithRun("completed"), "2026-11-20T00:10:00Z");
    expect(r.reaped[0]?.requeued).toBe(false);
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("running");
  });

  it("presumes a record with no Actions run dead only after hours", async () => {
    files.set(`live/${RUN}.json`, JSON.stringify({ run: RUN, work_item: WI, started_at: "2026-11-20T00:00:00Z" }));
    expect((await reapStaleRuns(ghWithRun("completed"), "2026-11-20T01:00:00Z")).reaped).toEqual([]);
    expect((await reapStaleRuns(ghWithRun("completed"), "2026-11-20T07:00:00Z")).reaped).toHaveLength(1);
  });
});

describe("prClosed", () => {
  const cleared = async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("running"), runs: [RUN] }));
    files.set(`live/${RUN}.json`, "{}");
    const { gh } = fakeGh([[{ name: "factory/gates", status: "completed", conclusion: "success" }]]);
    await finishRun({ ...base, gh, attempt: 1, pr: 5 });
    return gh;
  };

  it("marks a merged PR's item merged, moves it to recent, and the run's outcome with it", async () => {
    // Nothing did this before: java-service and py-api PRs merged and their
    // items stayed in_review, so no metric ever counted a merge.
    const gh = await cleared();
    const r = await prClosed({ gh, pr: 5, merged: true, now: "2026-11-21T00:00:00Z" });
    expect(r.status).toBe("merged");
    const wi = JSON.parse(files.get(`work-items/${WI}.json`)!);
    expect(wi.status).toBe("merged");
    expect(wi.merged_at).toBe("2026-11-21T00:00:00Z");
    expect(JSON.parse(files.get(`runs/${RUN}.json`)!).outcome).toBe("merged");
    const ledger = JSON.parse(files.get("ledger.json")!);
    expect(ledger.open.some((o: { work_item: string }) => o.work_item === WI)).toBe(false);
    expect(ledger.recent).toContainEqual(expect.objectContaining({ work_item: WI, status: "merged", pr: 5 }));
  });

  it("marks an item rejected when its PR closes without merging", async () => {
    const gh = await cleared();
    await prClosed({ gh, pr: 5, merged: false, now: "2026-11-21T00:00:00Z" });
    const wi = JSON.parse(files.get(`work-items/${WI}.json`)!);
    expect(wi.status).toBe("rejected");
    expect(wi.closed_at).toBe("2026-11-21T00:00:00Z");
    expect(JSON.parse(files.get(`runs/${RUN}.json`)!).outcome).toBe("rejected");
  });

  it("does nothing for a PR no work item owns", async () => {
    const { gh } = fakeGh([]);
    expect((await prClosed({ gh, pr: 99, merged: true, now: "2026-11-21T00:00:00Z" })).status).toBe("no_item");
  });
});

describe("dropItems", () => {
  it("rejects the item, cancels its live run, closes its PR and leaves the ledger", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("running"), runs: [RUN], pr: 5 }));
    files.set(`live/${RUN}.json`, JSON.stringify({ schema: "live/1", run: RUN, work_item: WI, pipeline: "product_work", step: "builder", attempt: 1, started_at: "2026-11-20T00:00:00Z", actions_run: 777 }));
    files.set("ledger.json", JSON.stringify({ schema: "ledger/1", updated_at: "2026-11-20T00:00:00Z", open: [{ work_item: WI, pipeline: "product_work", status: "running", pr: 5 }], recent: [], merge_queue: [] }));
    const { gh, sent } = fakeGh([]);
    const r = await dropItems({ gh, ids: [WI, "wi_01M7XHGA7F5CNWC3BD3BSP0WZZ"], why: "overlaps another item", now: "2026-11-21T00:00:00Z" });
    expect(r.dropped).toEqual([WI]);
    expect(r.skipped.map((s) => s.why)).toEqual(["not on the data ref"]);
    expect(JSON.parse(files.get(`work-items/${WI}.json`)!).status).toBe("rejected");
    expect(files.has(`live/${RUN}.json`)).toBe(false);
    expect(sent.some((s) => s.path.endsWith("/actions/runs/777/cancel"))).toBe(true);
    expect(sent.some((s) => s.method === "PATCH" && s.path.endsWith("/pulls/5"))).toBe(true);
    expect(JSON.parse(files.get("ledger.json")!).open).toEqual([]);
  });
});

describe("a conflict rebuild", () => {
  it("claims an item in review that has a PR, and nothing else", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("in_review"), pr: 33 }));
    const { gh } = fakeGh([]);
    expect((await startRun({ gh, workItem: WI, attempt: 1, escalate: false, firstStep: "builder", now: "2026-11-21T00:00:00Z", reason: "conflict" })).status).toBe("running");
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("queued") }));
    expect((await startRun({ gh, workItem: WI, attempt: 1, escalate: false, firstStep: "builder", now: "2026-11-21T00:00:00Z", reason: "conflict" })).status).toBe("not_claimed");
  });

  it("links the new PR, keeps the old one on the item, and closes it with a pointer", async () => {
    files.set(`work-items/${WI}.json`, JSON.stringify({ ...item("running"), runs: [RUN], pr: 33 }));
    files.set(`live/${RUN}.json`, "{}");
    const { gh, sent } = fakeGh([[{ name: "factory/gates", status: "completed", conclusion: "success" }]]);
    await finishRun({ ...base, gh, attempt: 1, pr: 36 });
    const wi = JSON.parse(files.get(`work-items/${WI}.json`)!);
    expect(wi.pr).toBe(36);
    expect(wi.previous_prs).toEqual([33]);
    expect(sent.some((s) => s.method === "PATCH" && s.path.endsWith("/pulls/33"))).toBe(true);
    // The old PR closing then leaves the item alone.
    expect((await prClosed({ gh, pr: 33, merged: false, now: "2026-11-21T00:00:00Z" })).status).toBe("no_item");
  });
});
