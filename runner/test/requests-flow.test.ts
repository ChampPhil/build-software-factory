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
      pin: async () => null,
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

const { runIntakeCommand, recordIntakeCommand } = await import("../src/commands/intake-run.js");
const { LEDGER, workItemPath } = await import("../src/lib/store.js");

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
};

const posted: { path: string; body: string; labels?: string[] }[] = [];
function runEvent(eventName: string, payload: unknown, dispatched: string[], now: string, record: true): Promise<Awaited<ReturnType<typeof recordIntakeCommand>>>;
function runEvent(eventName: string, payload: unknown, dispatched: string[], now: string, record?: false): ReturnType<typeof runIntakeCommand>;
function runEvent(eventName: string, payload: unknown, dispatched: string[], now: string, record = false): Promise<unknown> {
  const path = join(mkdtempSync(join(tmpdir(), "bsf-ev-")), "event.json");
  writeFileSync(path, JSON.stringify(payload));
  const gh = {
    repo: "o/r",
    get: async (path: string) => ({ permission: path.includes("/stranger/") ? "none" : "admin" }),
    send: async (_m: string, p: string, b: { body: string; labels?: string[] }) => { posted.push({ path: p, body: b?.body, ...(b?.labels === undefined ? {} : { labels: b.labels }) }); return {}; },
    dispatchWorkflow: async (_w: string, _r: unknown, inputs: Record<string, string>) => { dispatched.push(inputs["work_item"]!); },
    defaultBranch: async () => "main",
  } as never;
  return (record ? recordIntakeCommand : runIntakeCommand)({
    gh, eventName, eventPath: path, now, policy,
    triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
    maxRuns: 3, runningRuns: 0, setupFinished: true,
  });
}

const emptyFactory = () => {
  files.clear(); commits.length = 0; posted.length = 0;
  files.set(LEDGER, JSON.stringify({ schema: "ledger/1", updated_at: "t", open: [], recent: [], merge_queue: [] }));
};

const opened = (body: string, login = "philip", assoc = "OWNER", labels: string[] = []) => ({
  action: "opened",
  issue: { number: 9, title: "CSV export", body, labels: labels.map((name) => ({ name })), user: { login, type: "User" }, author_association: assoc },
});

describe("a request, start to finish", () => {
  it("an issue becomes a queued item with its goal, a run starts, and the factory says it read it", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    const r = await runEvent("issues", opened("### What do you want?\n\nExport\n\n### Goal\n\nUsers can download a CSV."), dispatched, "2026-11-22T10:00:00Z");
    expect(r.result.decisions[0]!.outcome).toBe("queued");
    const id = [...files.keys()].find((k) => k.startsWith("work-items/"))!;
    expect(JSON.parse(files.get(id)!)).toMatchObject({ pipeline: "product_work", status: "queued", goal: "Users can download a CSV.", source: { ref: "#9" } });
    expect(dispatched).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("repos/o/r/issues/9/comments");
    expect(posted[0]!.body).toContain("Users can download a CSV.");
    expect(r.acknowledged).toEqual([9]);
  });

  it("a request from the dashboard's workflow_dispatch becomes a queued item too, with nothing to comment on", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    const r = await runEvent("workflow_dispatch", { inputs: { title: "Add a badge", body: "### Goal\n\nThe README shows a badge." }, sender: { login: "philip", type: "User" } }, dispatched, "2026-11-22T10:00:00Z");
    expect(r.result.decisions[0]!.outcome).toBe("queued");
    expect(dispatched).toHaveLength(1);
    expect(posted).toHaveLength(0);
  });

  it("a tidy form goes to gardening", async () => {
    emptyFactory();
    await runEvent("issues", opened("### What should be tidied?\n\nDates", "philip", "OWNER", ["factory:tidy"]), [], "2026-11-22T10:00:00Z");
    const id = [...files.keys()].find((k) => k.startsWith("work-items/"))!;
    expect(JSON.parse(files.get(id)!).pipeline).toBe("gardening");
  });

  it("an untrusted author waits, is told how to get started, and nothing runs", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    await runEvent("issues", opened("please", "stranger", "NONE"), dispatched, "2026-11-22T10:00:00Z");
    expect(dispatched).toEqual([]);
    expect(posted[0]!.body).toContain("factory:accept");
  });

  it("a question waits for as long as it takes, and a trusted person's reply starts the work again", async () => {
    emptyFactory();
    files.set(LEDGER, JSON.stringify({ schema: "ledger/1", updated_at: "t", open: [{ work_item: "wi_Q", pipeline: "product_work", status: "needs_info", source_ref: "#9", created_at: "2026-11-01T00:00:00Z" }], recent: [], merge_queue: [] }));
    files.set(workItemPath("wi_Q"), JSON.stringify({ schema: "work-item/1", id: "wi_Q", pipeline: "product_work", status: "needs_info", title: "t", body: "Export", runs: [] }));

    // Weeks later, someone chats on the issue without answering: nothing changes, and nothing escalates.
    const dispatched: string[] = [];
    const chat = { action: "created", issue: { number: 9, title: "t", labels: [] }, comment: { id: 1, body: "any news?", user: { login: "stranger", type: "User" }, author_association: "NONE", created_at: "2026-12-20T00:00:00Z" } };
    await runEvent("issue_comment", chat, dispatched, "2026-12-20T00:00:00Z");
    expect(dispatched).toEqual([]);
    expect(JSON.parse(files.get(LEDGER)!).open[0].status).toBe("needs_info");

    const answer = { ...chat, comment: { ...chat.comment, id: 2, body: "The settings page, please.", user: { login: "philip", type: "User" }, author_association: "OWNER", created_at: "2026-12-21T00:00:00Z" } };
    const r = await runEvent("issue_comment", answer, dispatched, "2026-12-21T00:00:00Z");
    expect(r.result.decisions.at(-1)!.outcome).toBe("answers_open_item");
    expect(JSON.parse(files.get(workItemPath("wi_Q"))!)).toMatchObject({ status: "queued" });
    expect(JSON.parse(files.get(workItemPath("wi_Q"))!).body).toContain("The settings page, please.");
    expect(dispatched).toEqual(["wi_Q"]);
    expect(posted.at(-1)!.body).toContain("answers the question");
  });
});

describe("recording an event on its own (fix 4)", () => {
  it("writes the event down and marks the issue queued, deciding nothing", async () => {
    emptyFactory();
    const dispatched: string[] = [];
    const r = await runEvent("issues", opened("### What do you want?\n\nExport"), dispatched, "2026-11-22T10:00:00Z", true);
    expect(r.recorded).toBe(true);
    expect(r.event).not.toBeNull();
    expect([...files.keys()].some((k) => k.startsWith("work-items/"))).toBe(false);
    expect(dispatched).toHaveLength(0);
    expect(posted.map((p) => p.path)).toEqual(["repos/o/r/issues/9/labels"]);
  });

  it("recording twice, then processing, still makes one work item", async () => {
    emptyFactory();
    const ev = opened("### What do you want?\n\nExport");
    await runEvent("issues", ev, [], "2026-11-22T10:00:00Z", true);
    await runEvent("issues", ev, [], "2026-11-22T10:00:00Z", true);
    const dispatched: string[] = [];
    await runEvent("issues", ev, dispatched, "2026-11-22T10:00:00Z");
    expect([...files.keys()].filter((k) => k.startsWith("work-items/"))).toHaveLength(1);
  });
});

describe("the label an issue gets while it waits (D53)", () => {
  it("says queued only for someone the factory trusts", async () => {
    emptyFactory();
    await runEvent("issues", opened("Add a thing", "philip", "OWNER"), [], "2026-11-22T10:00:00Z", true);
    expect(posted.filter((p) => p.path.endsWith("/labels")).map((p) => p.labels)).toEqual([["factory:queued"]]);
  });

  it("says awaiting-maintainer for a stranger, never queued", async () => {
    emptyFactory();
    await runEvent("issues", opened("Add a thing", "stranger", "NONE"), [], "2026-11-22T10:00:00Z", true);
    expect(posted.filter((p) => p.path.endsWith("/labels")).map((p) => p.labels)).toEqual([["factory:awaiting-maintainer"]]);
  });
});
