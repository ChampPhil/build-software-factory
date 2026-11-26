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

const { runIntakeCommand } = await import("../src/commands/intake-run.js");
const { LEDGER, workItemPath, runPath } = await import("../src/lib/store.js");

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
};

function setup(pr: { pipeline: string; item: string }) {
  files.clear();
  commits.length = 0;
  files.set(LEDGER, JSON.stringify({ schema: "ledger/1", updated_at: "t", open: [{ work_item: pr.item, pipeline: pr.pipeline, status: "in_review", pr: 7 }], recent: [], merge_queue: [] }));
  files.set(workItemPath(pr.item), JSON.stringify({ schema: "work-item/1", id: pr.item, pipeline: pr.pipeline, runs: ["run_1"] }));
  files.set(runPath("run_1"), JSON.stringify({ id: "run_1" }));
}

function run(eventName: string, payload: unknown, dispatched: string[] = [], now = "2026-11-22T10:00:00Z") {
  const path = join(mkdtempSync(join(tmpdir(), "bsf-ev-")), "event.json");
  writeFileSync(path, JSON.stringify(payload));
  const gh = {
    repo: "o/r",
    get: async () => ({ permission: "admin" }),
    dispatchWorkflow: async (_w: string, _r: unknown, inputs: Record<string, string>) => { dispatched.push(inputs["work_item"]!); },
    defaultBranch: async () => "main",
  } as never;
  return runIntakeCommand({
    gh, eventName, eventPath: path, now, policy,
    triggers: { issues: false, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
    maxRuns: 3, runningRuns: 0, setupFinished: true,
  });
}

const pull = { number: 7, head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } };
const comment = (body: string, login = "philip") => ({
  action: "created", pull_request: pull,
  comment: { id: 1, body, user: { login, type: "User" }, author_association: "OWNER", created_at: "2026-11-22T10:00:00Z", html_url: "https://github.com/o/r/pull/7#discussion_r1" },
});

describe("a correction on a factory PR, start to finish", () => {
  it("becomes a queued hardening item, is written onto the run it corrects, and starts hardening", async () => {
    setup({ pipeline: "product_work", item: "wi_P" });
    const dispatched: string[] = [];
    const r = await run("pull_request_review_comment", comment("Please use apiClient here instead of fetch."), dispatched);

    expect(r.result.decisions[0]!.outcome).toBe("correction_captured");
    const created = [...files.keys()].find((k) => k.startsWith("work-items/") && k !== workItemPath("wi_P"))!;
    const item = JSON.parse(files.get(created)!);
    expect(item).toMatchObject({ pipeline: "hardening", status: "queued", parent: "wi_P", source: { kind: "correction", ref: "#7" } });
    expect(item.body).toContain("pull/7#discussion_r1");

    const run1 = JSON.parse(files.get(runPath("run_1"))!);
    expect(run1.human_corrections).toHaveLength(1);
    expect(run1.human_corrections[0]).toMatchObject({ by: "philip", kind: "review_comment", url: "https://github.com/o/r/pull/7#discussion_r1" });

    const ledger = JSON.parse(files.get(LEDGER)!);
    expect(ledger.open.find((o: { work_item: string }) => o.work_item === item.id)).toMatchObject({ pipeline: "hardening" });
    expect(dispatched).toEqual([item.id]);
  });

  it("does not harden on a comment on a hardening PR, and writes nothing to its run", async () => {
    setup({ pipeline: "hardening", item: "wi_H" });
    const dispatched: string[] = [];
    const r = await run("pull_request_review_comment", comment("Please use a different name for this rule."), dispatched);
    expect(r.result.decisions[0]!.outcome).toBe("revision_of_existing_run");
    expect([...files.keys()].filter((k) => k.startsWith("work-items/"))).toEqual([workItemPath("wi_H")]);
    expect(JSON.parse(files.get(runPath("run_1"))!).human_corrections).toBeUndefined();
    expect(dispatched).toEqual([]);
  });

  it("ignores an approval", async () => {
    setup({ pipeline: "product_work", item: "wi_P" });
    const r = await run("pull_request_review_comment", comment("LGTM"));
    expect(r.result.decisions[0]!.workItem).toBeNull();
  });

  it("a person's push to the branch is a correction too", async () => {
    setup({ pipeline: "product_work", item: "wi_P" });
    const gh = { before: "a".repeat(40), after: "b".repeat(40) };
    const r = await run("pull_request_target", { action: "synchronize", pull_request: pull, sender: { login: "philip", type: "User" }, ...gh });
    expect(r.result.decisions[0]!.outcome).toBe("correction_captured");
    expect(r.result.decisions[0]!.correction?.kind).toBe("human_push");
  });

  it("the same correction said twice is one hardening item", async () => {
    setup({ pipeline: "product_work", item: "wi_P" });
    await run("pull_request_review_comment", comment("Please use apiClient here instead of fetch."));
    // A second comment with the same words, a moment later.
    const again = await run("pull_request_review_comment", { ...comment("Please use apiClient here instead of fetch."), comment: { ...comment("x").comment, body: "Please use apiClient here instead of fetch.", id: 2, created_at: "2026-11-22T10:00:05Z" } }, [], "2026-11-22T10:05:00Z");
    expect(again.result.decisions.at(-1)!.outcome).toBe("context_for_open_item");
    expect([...files.keys()].filter((k) => k.startsWith("work-items/"))).toHaveLength(2);
  });
});
