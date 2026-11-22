import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../src/lib/types.js";

/** An in-memory data ref, so the whole intake run is exercised, not its pieces. */
const files = new Map<string, string>();
const commits: string[] = [];
vi.mock("../src/lib/store.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/store.js")>();
  class FactoryStore {
    constructor(_gh: unknown, _ref?: string) {}
    data = {
      read: async (p: string) => files.get(p) ?? null,
      readJson: async (p: string) => (files.has(p) ? (JSON.parse(files.get(p)!) as unknown) : null),
      list: async (prefix = "") => [...files.keys()].filter((k) => k.startsWith(prefix)),
      commitWithRetry: async (build: () => Promise<{ path: string; content: string }[]>, msg: string) => {
        for (const c of await build()) files.set(c.path, c.content);
        commits.push(msg);
        return "sha";
      },
    };
    async get<T>(p: string): Promise<T | null> { return files.has(p) ? (JSON.parse(files.get(p)!) as T) : null; }
    async ledger(now: string) { return (await this.get<unknown>("ledger.json")) ?? real.emptyLedger(now); }
    async put(changes: { path: string; content: string | null }[], msg: string) {
      for (const c of changes) {
        if (c.content === null) files.delete(c.path);
        else files.set(c.path, c.content);
      }
      commits.push(msg);
      return "sha";
    }
  }
  return { ...real, FactoryStore };
});

const { LEDGER } = await import("../src/lib/store.js");
const { runIntakeCommand } = await import("../src/commands/intake-run.js");

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
};


import type { Router } from "../src/commands/routing-run.js";

const posted: { path: string; body: string }[] = [];
const emptyFactory = () => {
  files.clear(); commits.length = 0; posted.length = 0;
  files.set(LEDGER, JSON.stringify({ schema: "ledger/1", updated_at: "t", open: [], recent: [], merge_queue: [] }));
};

/** A chief of staff that answers by the request's title, like a model reading it would. */
const answers: Record<string, Record<string, unknown>> = {
  "Add CSV export": { pipeline: "product_work", goal: "A user can download their data as CSV.", success_check: "Click Export on Settings and open the file.", priority: "normal", reason: "It adds behaviour.", question: null },
  "fetch keeps bypassing apiClient": { pipeline: "hardening", goal: "No code calls fetch directly.", success_check: "A lint rule fails on a direct fetch call.", priority: "normal", reason: "A recurring mistake, so a rule fixes it.", question: null },
  "Clean up the date helpers": { pipeline: "gardening", goal: "One date helper, used everywhere.", success_check: "grep finds one formatDate definition and the tests pass.", priority: "normal", reason: "A tidy that must not change behaviour.", question: null },
  "Make it better": { pipeline: "product_work", goal: "Something is better.", success_check: "Unclear.", priority: "normal", reason: "Too vague to say.", question: "Better in what way, and where?" },
};
const prompts: string[] = [];
const charged: number[] = [];
let down = false;
const router = (): Router => ({
  model: "claude-haiku-5-5",
  complete: async (_s, user) => {
    prompts.push(user);
    if (down) return null;
    const title = /Title: (.*)\n/.exec(user)![1]!;
    const base = answers[title] ?? answers["Add CSV export"]!;
    // Once a question has been answered it must not ask again.
    const q = user.includes("Do not ask a question") ? null : base["question"];
    return { text: JSON.stringify({ ...base, question: q }), tokensIn: 1500, tokensOut: 120 };
  },
  context: async () => ({ featureMap: "Settings, Billing", history: "" }),
  charge: async (usd) => { charged.push(usd); },
});

function runEvent(eventName: string, payload: unknown, dispatched: string[], now: string, withRouter = true) {
  const path = join(mkdtempSync(join(tmpdir(), "bsf-ev-")), "event.json");
  writeFileSync(path, JSON.stringify(payload));
  const gh = {
    repo: "o/r",
    get: async (p: string) => ({ permission: p.includes("/stranger/") ? "none" : "admin" }),
    send: async (_m: string, p: string, b: { body: string }) => { posted.push({ path: p, body: b.body }); return {}; },
    dispatchWorkflow: async (_w: string, _r: unknown, inputs: Record<string, string>) => { dispatched.push(inputs["work_item"]!); },
    defaultBranch: async () => "main",
  } as never;
  return runIntakeCommand({
    gh, eventName, eventPath: path, now, policy,
    triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
    maxRuns: 10, runningRuns: 0, setupFinished: true,
    ...(withRouter ? { router: router() } : {}),
  });
}

const issue = (n: number, title: string, body = "details", login = "philip", assoc = "OWNER") => ({
  action: "opened", issue: { number: n, title, body, labels: [], user: { login, type: "User" }, author_association: assoc },
});
const docs = () => [...files.keys()].filter((k) => k.startsWith("work-items/")).map((k) => JSON.parse(files.get(k)!) as Record<string, unknown> & { title: string; pipeline: string; routing?: { by: string; reason: string }; goal?: string; success_check?: string; status: string });
const byTitle = (t: string) => docs().find((d) => d.title === t)!;

describe("the chief of staff, start to finish", () => {
  it("routes a feature, a recurring mistake and a tidy to product, hardening and gardening, each with a goal a verifier can check", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    await runEvent("issues", issue(1, "Add CSV export"), dispatched, "2026-11-22T10:00:00Z");
    await runEvent("issues", issue(2, "fetch keeps bypassing apiClient"), dispatched, "2026-11-22T10:01:00Z");
    await runEvent("issues", issue(3, "Clean up the date helpers"), dispatched, "2026-11-22T10:02:00Z");

    expect(byTitle("Add CSV export")).toMatchObject({ pipeline: "product_work", goal: "A user can download their data as CSV.", routing: { by: "chief_of_staff" } });
    expect(byTitle("fetch keeps bypassing apiClient")).toMatchObject({ pipeline: "hardening", routing: { by: "chief_of_staff", from: "product_work" } });
    // Gardening is a person's own pick ("Tidy this") only when they labelled it; a plain request is routed.
    expect(byTitle("Clean up the date helpers")).toMatchObject({ pipeline: "gardening" });
    for (const d of docs()) {
      expect(d.goal).toBeTruthy();
      expect(d.success_check).toBeTruthy();
    }
    expect(new Set(dispatched).size).toBe(3);
    // The ledger carries the routed pipeline, which is what the run reads.
    const ledger = JSON.parse(files.get(LEDGER)!) as { open: { pipeline: string; status: string }[] };
    expect(ledger.open.map((o) => o.pipeline).sort()).toEqual(["gardening", "hardening", "product_work"]);
    expect(charged).toHaveLength(3);
    expect(charged.every((c) => c > 0 && c < 0.05)).toBe(true);
    // The person is told what it was taken for, why, and how to move it.
    const ack = posted.find((p) => p.path.endsWith("/issues/2/comments"))!.body;
    expect(ack).toContain("hardening");
    expect(ack).toContain("A recurring mistake");
    expect(ack).toContain("move it from the dashboard");
  });

  it("asks one question about a vague request, runs nothing, and routes it once answered", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    await runEvent("issues", issue(4, "Make it better"), dispatched, "2026-11-22T10:00:00Z");
    expect(dispatched).toEqual([]);
    expect(byTitle("Make it better")).toMatchObject({ status: "needs_info", routing: { pending: true } });
    const q = posted.find((p) => p.path.endsWith("/issues/4/comments"))!.body;
    expect(q).toContain("Better in what way, and where?");
    expect(q).toContain("Nothing times out");
    // The ordinary acknowledgement is not posted on top of the question.
    expect(posted.filter((p) => p.path.endsWith("/issues/4/comments"))).toHaveLength(1);
    expect(JSON.parse(files.get(LEDGER)!).open[0].status).toBe("needs_info");

    const answer = { action: "created", issue: { number: 4, title: "Make it better", labels: [] }, comment: { id: 9, body: "The settings page loads slowly.", user: { login: "philip", type: "User" }, author_association: "OWNER", created_at: "2026-11-23T10:00:00Z" } };
    await runEvent("issue_comment", answer, dispatched, "2026-11-23T10:00:00Z");
    const after = byTitle("Make it better");
    expect(after.status).toBe("queued");
    expect(after.body as string).toContain("The settings page loads slowly.");
    expect((after.routing as { pending?: boolean }).pending).toBeUndefined();
    expect(prompts.at(-1)).toContain("Do not ask a question");
    expect(dispatched).toHaveLength(1);
  });

  it("an unreachable chief of staff never blocks the work: the table's route stands", async () => {
    emptyFactory();
    down = true;
    const dispatched: string[] = [];
    await runEvent("issues", issue(5, "Add CSV export"), dispatched, "2026-11-22T10:00:00Z");
    down = false;
    expect(byTitle("Add CSV export")).toMatchObject({ pipeline: "product_work", routing: { by: "table" } });
    expect(dispatched).toHaveLength(1);
  });

  it("without a router, requests keep the table's route and are not touched", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    await runEvent("issues", issue(6, "fetch keeps bypassing apiClient"), dispatched, "2026-11-22T10:00:00Z", false);
    expect(byTitle("fetch keeps bypassing apiClient")).toMatchObject({ pipeline: "product_work" });
    expect(byTitle("fetch keeps bypassing apiClient").routing).toBeUndefined();
  });

  it("never routes, or spends on, an author the factory does not act for; routes it when a maintainer admits it", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    const before = prompts.length;
    await runEvent("issues", issue(7, "fetch keeps bypassing apiClient", "details", "stranger", "NONE"), dispatched, "2026-11-22T10:00:00Z");
    expect(prompts.length).toBe(before);
    expect(dispatched).toEqual([]);
    expect(docs()[0]!.status).toBe("waiting_trust");
    const label = { action: "labeled", issue: { number: 7, title: "fetch keeps bypassing apiClient", labels: [{ name: "factory:accept" }], user: { login: "stranger", type: "User" }, author_association: "NONE" }, label: { name: "factory:accept" }, sender: { login: "philip", type: "User" } };
    await runEvent("issues", label, dispatched, "2026-11-22T11:00:00Z");
    expect(prompts.length).toBe(before + 1);
    expect(docs()[0]).toMatchObject({ status: "queued", pipeline: "hardening" });
    expect(dispatched).toHaveLength(1);
  });

  it("leaves a scheduled or correction item on its fixed route", async () => {
    emptyFactory();
    const before = prompts.length;
    const dispatched: string[] = [];
    await runEvent("workflow_dispatch", { inputs: { title: "Add CSV export", body: "x", kind: "correction" }, sender: { login: "philip", type: "User" } }, dispatched, "2026-11-22T10:00:00Z");
    // A correction is hardening work started by the factory itself; it is not a person's request.
    expect(docs()[0]!.pipeline).toBe("hardening");
    expect(prompts.length).toBe(before);
  });
});

describe("overriding a route, and standing goals", () => {
  it("a person moves a request in one step, and it is recorded and runs as the new pipeline", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    await runEvent("issues", issue(8, "Add CSV export"), dispatched, "2026-11-22T10:00:00Z", false);
    const id = docs()[0]!.id as string;
    // Hold it so the move happens before work starts.
    const ledger = JSON.parse(files.get(LEDGER)!);
    ledger.open[0].status = "needs_info";
    files.set(LEDGER, JSON.stringify(ledger));
    const item = JSON.parse(files.get(`work-items/${id}.json`)!);
    files.set(`work-items/${id}.json`, JSON.stringify({ ...item, status: "needs_info" }));

    await runEvent("workflow_dispatch", { inputs: { kind: "route_override", title: id, body: "gardening" }, sender: { login: "philip", type: "User" } }, [], "2026-11-22T11:00:00Z");
    const after = docs()[0]!;
    expect(after.pipeline).toBe("gardening");
    expect(after.routing).toMatchObject({ by: "person", from: "product_work", overrides: [{ by: "philip", from: "product_work", to: "gardening" }] });
    expect(JSON.parse(files.get(LEDGER)!).open[0].pipeline).toBe("gardening");
  });

  it("will not move work that is already running, or to a pipeline a request cannot take", async () => {
    emptyFactory();
    await runEvent("issues", issue(9, "Add CSV export"), [], "2026-11-22T10:00:00Z", false);
    const id = docs()[0]!.id as string;
    files.set(`work-items/${id}.json`, JSON.stringify({ ...docs()[0]!, status: "running" }));
    await runEvent("workflow_dispatch", { inputs: { kind: "route_override", title: id, body: "hardening" }, sender: { login: "philip" } }, [], "2026-11-22T11:00:00Z");
    expect(docs()[0]!.pipeline).toBe("product_work");
    files.set(`work-items/${id}.json`, JSON.stringify({ ...docs()[0]!, status: "needs_info" }));
    await runEvent("workflow_dispatch", { inputs: { kind: "route_override", title: id, body: "definition" }, sender: { login: "philip" } }, [], "2026-11-22T11:05:00Z");
    expect(docs()[0]!.pipeline).toBe("product_work");
  });

  it("records a standing goal from the dashboard, applies it to the next request, and removes it", async () => {
    emptyFactory();
    await runEvent("workflow_dispatch", { inputs: { kind: "standing_goal_add", title: "auth this month", body: "hardening" }, sender: { login: "philip" } }, [], "2026-11-22T10:00:00Z");
    const goals = JSON.parse(files.get("standing-goals.json")!) as { goals: { id: string; text: string; lane: string }[] };
    expect(goals.goals).toMatchObject([{ text: "auth this month", lane: "hardening" }]);
    await runEvent("issues", issue(10, "Add CSV export"), [], "2026-11-22T10:05:00Z");
    expect(prompts.at(-1)).toContain("auth this month (for hardening)");
    await runEvent("workflow_dispatch", { inputs: { kind: "standing_goal_remove", title: goals.goals[0]!.id }, sender: { login: "philip" } }, [], "2026-11-22T10:10:00Z");
    expect(JSON.parse(files.get("standing-goals.json")!).goals).toEqual([]);
    // None of these dispatches became a request.
    expect(docs().map((d) => d.title)).toEqual(["Add CSV export"]);
  });

  it("records /focus from a trusted comment and says so, and ignores it from a stranger", async () => {
    emptyFactory();
    const c = (login: string, assoc: string) => ({ action: "created", issue: { number: 11, title: "t", labels: [] }, comment: { id: 1, body: "/focus gardening: the billing folder", user: { login, type: "User" }, author_association: assoc, created_at: "2026-11-22T10:00:00Z" } });
    await runEvent("issue_comment", c("philip", "OWNER"), [], "2026-11-22T10:00:00Z");
    expect(JSON.parse(files.get("standing-goals.json")!).goals).toMatchObject([{ text: "the billing folder", lane: "gardening" }]);
    expect(posted.at(-1)!.body).toContain("standing goal");
    expect(docs()).toHaveLength(0);

    files.delete("standing-goals.json");
    await runEvent("issue_comment", c("stranger", "NONE"), [], "2026-11-22T10:05:00Z");
    expect(files.has("standing-goals.json")).toBe(false);
  });
});
