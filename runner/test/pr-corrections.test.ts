import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntake, type IncomingEvent, type IntakeContext } from "../src/commands/intake.js";
import { classifyCorrection, isApprovalOnly, recordOf, workItemBody, workItemTitle } from "../src/commands/corrections.js";
import { normalizeEvent, correctionChanges, prItemsFor } from "../src/commands/intake-run.js";
import { captureLocal, parseHookInput, withHook, withoutHook, hookCommand, alreadySent, markSent } from "../src/commands/local-hook.js";
import type { Policy } from "../src/lib/types.js";

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
  paths: { definition: [".factory/definition/**"], guardrails: [".factory/guardrails/**"], tests: ["**/*.test.*"], protected: [".github/workflows/**"] },
  pipelines: { product_work: { may_change: ["code", "tests"] }, gardening: { may_change: ["code", "tests"] }, hardening: { may_change: ["code", "tests", "guardrails:tighten"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: ["rule_removed"] },
};

function ctx(over: Partial<IntakeContext> = {}): IntakeContext {
  return {
    policy,
    triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
    cursor: 0,
    openItems: [],
    prItems: { "7": { work_item: "wi_PRODUCT", pipeline: "product_work" }, "8": { work_item: "wi_HARDEN", pipeline: "hardening" } },
    newId: () => "wi_NEW",
    ...over,
  };
}

const ev = (over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: 1, kind: "review_comment", at: "2026-11-22T10:00:00Z", actor: "philip", actor_association: "OWNER",
  body: "Please use apiClient here instead of fetch.", ref: "#7", pr: 7, url: "https://github.com/o/r/pull/7#c1", ...over,
});

describe("what counts as a correction", () => {
  it("is not an approval, a thanks or an acknowledgement", () => {
    for (const t of ["LGTM", "looks good to me", "Thanks!", "ship it", "👍", ""]) expect(isApprovalOnly(t)).toBe(true);
    expect(isApprovalOnly("looks good but please rename this to fetchInvoices")).toBe(false);
  });

  it("is a request for a change in a review comment", () => {
    for (const t of [
      "Please use apiClient here instead of fetch.",
      "This should be a transaction.",
      "Don't call the database from a component.",
      "no, that's wrong, the total includes tax",
    ]) expect(classifyCorrection(t, "review_comment").correction, t).toBe(true);
  });

  it("is not a question or a remark", () => {
    for (const t of ["Nice, how long does the export take?", "Interesting approach", "I wonder what happens on mobile"]) {
      expect(classifyCorrection(t, "review_comment").correction, t).toBe(false);
    }
  });

  it("is always one when a reviewer requests changes, or a person pushes a fix", () => {
    expect(classifyCorrection("see inline", "change_request").correction).toBe(true);
    expect(classifyCorrection("", "human_push").correction).toBe(true);
    expect(classifyCorrection("LGTM", "change_request").correction).toBe(false);
  });

  it("holds a message to an agent to the stricter chat bar", () => {
    expect(classifyCorrection("no, don't mock the database, use the real one", "local_session").correction).toBe(true);
    expect(classifyCorrection("can you also add a loading state", "local_session").correction).toBe(false);
  });

  it("redacts secrets and cuts long text", () => {
    const r = recordOf({ at: "t", by: "p", kind: "review_comment", text: `token ghp_${"a".repeat(36)} ${"x".repeat(900)}` });
    expect(r.text).not.toContain("ghp_");
    expect(r.text.length).toBeLessThanOrEqual(600);
  });
});

describe("intake turns a correction on a factory PR into hardening, with no label", () => {
  it("makes a hardening work item that links back to the words and the run", () => {
    const d = runIntake([ev()], ctx()).decisions[0]!;
    expect(d.outcome).toBe("correction_captured");
    expect(d.workItem).toMatchObject({ pipeline: "hardening", trigger_class: "self", status: "queued", pr: null, parent: "wi_PRODUCT", source: { kind: "correction", ref: "#7" } });
    expect(d.workItem!.body).toContain("https://github.com/o/r/pull/7#c1");
    expect(d.workItem!.body).toContain("apiClient");
    expect(d.correction).toMatchObject({ kind: "review_comment", by: "philip" });
    expect(d.correctedItem).toBe("wi_PRODUCT");
  });

  it("treats a change request and a pushed fix the same way", () => {
    const changes = runIntake([ev({ id: 1, kind: "pr_review", review_state: "CHANGES_REQUESTED", body: "This breaks the export." })], ctx()).decisions[0]!;
    expect(changes.outcome).toBe("correction_captured");
    expect(changes.correction?.kind).toBe("change_request");
    const push = runIntake([ev({ id: 1, kind: "human_push", body: "fix the total", files: ["lib/total.ts"], url: "https://github.com/o/r/compare/a...b" })], ctx()).decisions[0]!;
    expect(push.outcome).toBe("correction_captured");
    expect(push.correction?.kind).toBe("human_push");
    expect(push.workItem!.body).toContain("lib/total.ts");
  });

  it("does not harden on hardening: a comment on a hardening PR reviews that PR", () => {
    const d = runIntake([ev({ pr: 8, ref: "#8" })], ctx()).decisions[0]!;
    expect(d.outcome).toBe("revision_of_existing_run");
    expect(d.workItem).toBeNull();
    expect(d.reason).toContain("does not raise a new correction");
  });

  it("does the same for a change request or a push on a hardening PR", () => {
    for (const e of [ev({ kind: "pr_review", review_state: "CHANGES_REQUESTED", pr: 8 }), ev({ kind: "human_push", pr: 8 })]) {
      expect(runIntake([e], ctx()).decisions[0]!.workItem).toBeNull();
    }
  });

  it("ignores approvals and plain remarks", () => {
    expect(runIntake([ev({ body: "LGTM" })], ctx()).decisions[0]!.workItem).toBeNull();
    expect(runIntake([ev({ kind: "pr_review", review_state: "COMMENTED", body: "Thanks!" })], ctx()).decisions[0]!.outcome).toBe("not_a_correction");
  });

  it("ignores a stranger: a correction goes to an agent", () => {
    const d = runIntake([ev({ actor: "rando", actor_association: "NONE" })], ctx()).decisions[0]!;
    expect(d.outcome).toBe("ignored_untrusted_correction");
    expect(d.workItem).toBeNull();
  });

  it("ignores the factory's own bot", () => {
    expect(runIntake([ev({ actor: "factory[bot]", actor_association: "NONE", actor_is_bot: true })], ctx()).decisions[0]!.outcome).toBe("ignored_bot");
  });

  it("is nothing on a PR the factory did not open", () => {
    expect(runIntake([ev({ pr: 99 })], ctx()).decisions[0]!.workItem).toBeNull();
    expect(runIntake([ev({ kind: "human_push", pr: 99 })], ctx()).decisions[0]!.outcome).toBe("ignored_not_factory_pr");
  });

  it("folds the same correction said twice into one work item", () => {
    const first = runIntake([ev()], ctx()).decisions[0]!;
    const open = [{ work_item: "wi_NEW", fingerprint: first.workItem!.fingerprint, status: "queued", pipeline: "hardening" as const }];
    const second = runIntake([ev({ id: 2 })], ctx({ openItems: open })).decisions[0]!;
    expect(second.workItem).toBeNull();
    expect(second.outcome).toBe("context_for_open_item");
    expect(second.openItem).toBe("wi_NEW");
  });

  it("keeps a comment a plain revision when intake could not look up the PR", () => {
    const { prItems: _unused, ...rest } = ctx();
    expect(runIntake([ev()], rest).decisions[0]!.outcome).toBe("revision_of_existing_run");
  });

  it("makes titles and bodies a reader can follow", () => {
    const r = recordOf({ at: "t", by: "philip", kind: "review_comment", text: "Please use apiClient.\nNot fetch." });
    expect(workItemTitle(r, 7)).toBe("Correction on #7: Please use apiClient.");
    expect(workItemBody(r, { pr: 7, parent: "wi_P" })).toContain("> Not fetch.");
  });
});

describe("the GitHub events that carry a correction", () => {
  const pull = { number: 7, head: { repo: { full_name: "o/r" } }, base: { repo: { full_name: "o/r" } } };
  it("reads a submitted change request", () => {
    const e = normalizeEvent("pull_request_review", { action: "submitted", pull_request: pull, review: { state: "changes_requested", body: "No.", user: { login: "p" }, author_association: "OWNER", html_url: "u" } }, "2026-11-22T10:00:00Z");
    expect(e).toMatchObject({ kind: "pr_review", review_state: "CHANGES_REQUESTED", pr: 7, url: "u", actor: "p" });
  });
  it("skips an approval and an empty comment review", () => {
    expect(normalizeEvent("pull_request_review", { action: "submitted", pull_request: pull, review: { state: "approved", user: { login: "p" } } }, "t")).toBeNull();
    expect(normalizeEvent("pull_request_review", { action: "submitted", pull_request: pull, review: { state: "commented", body: "", user: { login: "p" } } }, "t")).toBeNull();
  });
  it("reads a push to a PR branch, and carries the comment's link", () => {
    expect(normalizeEvent("pull_request_target", { action: "synchronize", pull_request: pull, sender: { login: "p", type: "User" } }, "2026-11-22T10:00:00Z")).toMatchObject({ kind: "human_push", pr: 7, actor: "p" });
    expect(normalizeEvent("pull_request_target", { action: "opened", pull_request: pull }, "t")).toBeNull();
    const c = normalizeEvent("pull_request_review_comment", { action: "created", pull_request: pull, comment: { body: "use x", user: { login: "p" }, html_url: "https://c" } }, "t");
    expect(c).toMatchObject({ kind: "review_comment", url: "https://c" });
  });
});

describe("recording a correction on the run it corrects", () => {
  function fakeStore(docs: Record<string, unknown>) {
    return { get: async (path: string) => docs[path] ?? null } as never;
  }
  const record = recordOf({ at: "2026-11-22T10:00:00Z", by: "philip", kind: "review_comment", text: "use apiClient" });

  it("appends to the item's last run, once", async () => {
    const store = fakeStore({
      "work-items/wi_PRODUCT.json": { runs: ["run_A", "run_B"] },
      "runs/run_B.json": { id: "run_B" },
    });
    const decision = { outcome: "correction_captured", correction: record, correctedItem: "wi_PRODUCT" };
    const out = await correctionChanges(store, [decision, decision]);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("runs/run_B.json");
    expect(JSON.parse(out[0]!.content as string).human_corrections).toEqual([record]);
  });

  it("does not add what the run already has", async () => {
    const store = fakeStore({ "work-items/wi_PRODUCT.json": { runs: ["run_B"] }, "runs/run_B.json": { id: "run_B", human_corrections: [record] } });
    expect(await correctionChanges(store, [{ outcome: "correction_captured", correction: record, correctedItem: "wi_PRODUCT" }])).toEqual([]);
  });

  it("writes nothing when the item has no run", async () => {
    expect(await correctionChanges(fakeStore({ "work-items/wi_PRODUCT.json": { runs: [] } }), [{ outcome: "correction_captured", correction: record, correctedItem: "wi_PRODUCT" }])).toEqual([]);
  });

  it("finds the pipeline behind a merged PR from its work item", async () => {
    const store = fakeStore({ "work-items/wi_OLD.json": { pipeline: "hardening" } });
    const got = await prItemsFor(store, { open: [{ work_item: "wi_OPEN", pipeline: "product_work", pr: 3 }], recent: [{ work_item: "wi_OLD", pr: 4 }] }, [ev({ pr: 3 }), ev({ pr: 4 }), ev({ pr: 5 })]);
    expect(got).toEqual({ "3": { work_item: "wi_OPEN", pipeline: "product_work" }, "4": { work_item: "wi_OLD", pipeline: "hardening" } });
  });
});

describe("corrections said to an agent on someone's machine", () => {
  const msg = (prompt: string) => parseHookInput(JSON.stringify({ session_id: "s1", prompt, hook_event_name: "UserPromptSubmit" }));

  it("sends a correction, redacted, with a stable key", () => {
    const a = captureLocal(msg("no, don't mock the database, use the real one. key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "philip", "2026-11-22T10:00:00Z");
    expect(a.send).toBe(true);
    expect(a.body).not.toContain("sk-ant");
    expect(a.title).toContain("Correction:");
    expect(captureLocal(msg("no, don't mock the database, use the real one. key sk-ant-api03-abcdefghijklmnopqrstuvwxyz"), "philip", "later").key).toBe(a.key);
  });

  it("sends nothing for an ordinary request, a command, or garbage", () => {
    expect(captureLocal(msg("add a loading spinner to the export button"), "p", "t").send).toBe(false);
    expect(captureLocal(msg("/clear"), "p", "t").send).toBe(false);
    expect(captureLocal(parseHookInput("not json"), "p", "t").send).toBe(false);
    expect(captureLocal(null, "p", "t").send).toBe(false);
  });

  it("remembers what it sent", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bsf-seen-")), "seen.json");
    expect(alreadySent("k1", path)).toBe(false);
    markSent("k1", path);
    expect(alreadySent("k1", path)).toBe(true);
  });

  it("installs once, keeps the person's other settings, and comes out cleanly", () => {
    const existing = { permissions: { allow: ["Bash(ls)"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other" }] }], Stop: [] } };
    const cmd = hookCommand("o/r");
    const on = withHook(existing, cmd)!;
    expect((on["hooks"] as { UserPromptSubmit: unknown[] }).UserPromptSubmit).toHaveLength(2);
    expect(on["permissions"]).toEqual(existing.permissions);
    expect(withHook(on, cmd)).toBeNull();
    const off = withoutHook(on)!;
    expect(off).toEqual(existing);
    expect(withoutHook(off)).toBeNull();
    expect(withoutHook(withHook({}, cmd))).toEqual({});
  });
});

