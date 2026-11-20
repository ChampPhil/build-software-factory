import { describe, it, expect, vi, beforeEach } from "vitest";

// An in-memory data ref, so the lifecycle is tested for what it writes, not
// for the Git Data API calls the store makes (dataref-api.test.ts covers those).
const files = new Map<string, string>();
const commits: string[] = [];
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FactoryStore {
    data = { read: async (p: string) => files.get(p) ?? null };
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

const { startRun, finishRun, gateVerdicts, gateFailuresPath } = await import("../src/commands/run-lifecycle.js");

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
