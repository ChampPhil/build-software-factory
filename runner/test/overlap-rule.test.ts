import { describe, it, expect, vi } from "vitest";
import { runIntake, type IncomingEvent, type IntakeContext } from "../src/commands/intake.js";
import { scopeOf, scopesOverlap, knownScopesOverlap, normaliseText, filesNamedIn } from "../src/lib/scope.js";
import { closePullWithReason } from "../src/lib/github.js";
import { strayHardeningFiles } from "../src/commands/run-lifecycle.js";
import type { Policy } from "../src/lib/types.js";

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
};
const ctx = (over: Partial<IntakeContext> = {}): IntakeContext => ({
  policy, triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
  cursor: 0, openItems: [], prItems: { "7": { work_item: "wi_PRODUCT", pipeline: "product_work" } }, newId: () => "wi_NEW", ...over,
});
const ev = (over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: 1, kind: "review_comment", at: "2026-11-22T10:00:00Z", actor: "philip", actor_association: "OWNER",
  body: "Please use apiClient here instead of fetch.", ref: "#7", pr: 7, url: "u", ...over,
});

describe("one overlap rule (fix 19)", () => {
  it("is shared by every pipeline", () => {
    expect(scopesOverlap(scopeOf(["a/b.js"]), scopeOf(["a"]))).toBe(true);
    expect(knownScopesOverlap(scopeOf([]), scopeOf(["a.js"]))).toBe(false);
    expect(normaliseText("  Use  ApiClient\nhere ")).toBe("use apiclient here");
    expect(filesNamedIn("x\nFiles changed: a.js, b.js and 3 more")).toEqual(["a.js", "b.js"]);
  });

  it("folds an exact duplicate correction into the open item and says where", () => {
    const open = [{ work_item: "wi_OPEN", status: "in_review", pipeline: "hardening" as const, pr: 31 }];
    const d = runIntake([ev()], ctx({ openItems: open, openItemBodies: { wi_OPEN: "> Please use   apiClient here instead of fetch." } })).decisions[0]!;
    expect(d.workItem).toBeNull();
    expect(d.openItem).toBe("wi_OPEN");
    expect(d.alsoRequested).toMatchObject({ pr: 31, sourcePr: 7, exact: true });
  });

  it("folds a correction touching the same files into the open item instead of a second PR", () => {
    const open = [{ work_item: "wi_OPEN", status: "in_review", pipeline: "hardening" as const, pr: 28 }];
    const d = runIntake(
      [ev({ id: 2, kind: "human_push", body: "tweak", files: ["eslint.config.mjs"] })],
      ctx({ openItems: open, openItemBodies: { wi_OPEN: "do a thing\nFiles changed: eslint.config.mjs" } }),
    ).decisions[0]!;
    expect(d.workItem).toBeNull();
    expect(d.alsoRequested?.exact).toBe(false);
  });

  it("still files a correction that overlaps nothing", () => {
    const open = [{ work_item: "wi_OPEN", status: "in_review", pipeline: "hardening" as const, pr: 28 }];
    const d = runIntake([ev({ body: "Please use logger here instead of console." })], ctx({ openItems: open, openItemBodies: { wi_OPEN: "unrelated" } })).decisions[0]!;
    expect(d.outcome).toBe("correction_captured");
  });

  it("explains every PR it closes, comment first", async () => {
    const calls: string[] = [];
    const gh = { repo: "o/r", send: vi.fn(async (m: string, p: string) => { calls.push(`${m} ${p}`); }) } as never;
    expect(await closePullWithReason(gh, 21, "Replaced by #24 because it conflicted.")).toBe(true);
    expect(calls).toEqual(["POST repos/o/r/issues/21/comments", "PATCH repos/o/r/pulls/21"]);
  });

  it("holds a hardening PR to the files its correction named, plus tests", async () => {
    const gh = { pullFiles: async () => [{ filename: "eslint.config.mjs" }, { filename: "test/rules.test.js" }, { filename: "package.json" }] } as never;
    expect(await strayHardeningFiles(gh, 5, { body: "x\nFiles changed: eslint.config.mjs" })).toEqual(["package.json"]);
    expect(await strayHardeningFiles(gh, 5, { body: "names no files" })).toEqual([]);
  });
});

describe("a failed triage (fix 22)", () => {
  it("treats a triage whose agent finished as a recovery, and any other failure as real", async () => {
    const { agentFinishedCleanly } = await import("../src/commands/run-lifecycle.js");
    const ok = [
      { name: "triage / activation", conclusion: "success" },
      { name: "triage / agent", conclusion: "success" },
      { name: "triage / detection", conclusion: "success" },
      { name: "triage / safe_outputs", conclusion: "success" },
      { name: "triage / conclusion", conclusion: "failure" },
    ];
    expect(agentFinishedCleanly(ok, "triage")).toBe(true);
    expect(agentFinishedCleanly(ok.map((j) => (j.name.endsWith("agent") ? { ...j, conclusion: "failure" } : j)), "triage")).toBe(false);
    expect(agentFinishedCleanly(ok.map((j) => (j.name.endsWith("detection") ? { ...j, conclusion: "failure" } : j)), "triage")).toBe(false);
    expect(agentFinishedCleanly([], "triage")).toBe(false);
  });

  it("queues the item again and says so when triage really failed", async () => {
    const { failStep } = await import("../src/commands/run-lifecycle.js");
    const sent: string[] = [];
    const gh = { repo: "o/r", send: async (m: string, p: string, b?: { body?: string }) => { sent.push(`${m} ${p} ${b?.body ?? ""}`); }, get: async () => ({}) } as never;
    const files = new Map<string, unknown>();
    const { FactoryStore } = await import("../src/lib/store.js");
    const proto = FactoryStore.prototype as unknown as Record<string, unknown>;
    const orig = { get: proto["get"], put: proto["put"], ledger: proto["ledger"] };
    proto["get"] = async () => ({ id: "wi_1", pipeline: "product_work", status: "running", source: { ref: "#9" } });
    proto["ledger"] = async () => ({ schema: "ledger/1", updated_at: "t", open: [{ work_item: "wi_1", pipeline: "product_work", status: "running" }], recent: [], merge_queue: [] });
    proto["put"] = async (c: { path: string; content: string }[]) => { for (const x of c) files.set(x.path, JSON.parse(x.content)); return "sha"; };
    try {
      const r = await failStep({ gh, workItem: "wi_1", step: "triage", runId: "1", now: "2026-11-25T10:00:00Z", jobs: [{ name: "triage / agent", conclusion: "failure" }] });
      expect(r.action).toBe("requeued");
      expect(sent.some((s) => s.includes("could not read this request (triage failed). Trying again in 5 minutes."))).toBe(true);
      expect((files.get("work-items/wi_1.json") as { requeues: number }).requeues).toBe(1);
    } finally {
      Object.assign(proto, { get: orig.get, put: orig.put, ledger: orig.ledger });
    }
  });
});

describe("one comment is recorded once (fix 22)", () => {
  it("reads the comment id out of a GitHub comment URL", async () => {
    const { commentIdOf } = await import("../src/commands/intake-run.js");
    expect(commentIdOf("https://github.com/o/r/issues/9#issuecomment-4412")).toBe(4412);
    expect(commentIdOf(undefined)).toBeNull();
  });

  it("appendTurn skips a turn whose comment is already in the log", async () => {
    const { appendTurn } = await import("../src/commands/brainstorm.js");
    const { FactoryStore } = await import("../src/lib/store.js");
    const proto = FactoryStore.prototype as unknown as Record<string, unknown>;
    const orig = { get: proto["get"], put: proto["put"] };
    let puts = 0;
    proto["get"] = async () => ({ schema: "brainstorm/1", work_item: "wi_1", turns: [{ at: "t", who: "person", text: "build it", comment: 77 }], understood: null, open: [] });
    proto["put"] = async () => { puts++; return "sha"; };
    try {
      await appendTurn({} as never, "wi_1", { at: "t2", who: "person", text: "build it", comment: 77 });
      expect(puts).toBe(0);
      await appendTurn({} as never, "wi_1", { at: "t3", who: "person", text: "different", comment: 78 });
      expect(puts).toBe(1);
    } finally {
      Object.assign(proto, orig);
    }
  });
});
