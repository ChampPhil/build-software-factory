import { describe, it, expect } from "vitest";
import { runIntake, type IncomingEvent, type IntakeContext } from "../src/commands/intake.js";
import { acknowledgement } from "../src/commands/acknowledge.js";
import type { Policy } from "../src/lib/types.js";

const policy: Policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: ["linear[bot]"] },
  paths: { definition: [".factory/definition/**"], guardrails: [], tests: [], protected: [] },
  pipelines: { product_work: { may_change: ["code"] }, gardening: { may_change: ["code"] }, hardening: { may_change: ["code"] }, definition: { may_change: ["definition"], requires: "trusted_human_approval" } },
  tests: { declared_edits: "required" },
  weakening: { requires: "trusted_human_approval", detects: [] },
};
const ctx = (): IntakeContext => ({
  policy, triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
  cursor: 0, openItems: [], recentlyMerged: [], newId: (e) => `wi_${e.id}`,
});
const ev = (over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: 1, kind: "issue_opened", at: "2026-11-22T10:00:00Z", actor: "philip", actor_association: "OWNER",
  title: "[Settings] use a cheaper model for triage", body: "### What should change?\n\nuse a cheaper model", ref: "#30", labels: ["factory:ask"], ...over,
});

describe("asking the factory for a change to its setup", () => {
  it("is kept on the issue: no work item, no run, no pipeline", () => {
    const d = runIntake([ev()], ctx()).decisions[0]!;
    expect(d.outcome).toBe("settings_request");
    expect(d.workItem).toBeNull();
  });

  it("says what happens next, and never mentions a file", () => {
    const d = runIntake([ev()], ctx()).decisions[0]!;
    const ack = acknowledgement(d, "factory:accept")!;
    expect(ack.issue).toBe(30);
    expect(ack.body).toMatch(/no agent will work on it/);
    expect(ack.body).toMatch(/Factory page/);
    expect(ack.body).not.toMatch(/\.ya?ml/i);
  });

  it("is ignored from someone the factory does not act for, who gets no reply", () => {
    const d = runIntake([ev({ actor: "stranger", actor_association: "NONE" })], ctx()).decisions[0]!;
    expect(d.outcome).toBe("ignored_untrusted_ask");
    expect(acknowledgement(d, "factory:accept")).toBeNull();
  });

  it("is ignored from a bot, even an integration's", () => {
    const d = runIntake([ev({ actor: "linear[bot]", actor_association: "NONE", actor_is_bot: true })], ctx()).decisions[0]!;
    expect(d.workItem).toBeNull();
    expect(d.outcome).not.toBe("settings_request");
  });

  it("also works when a maintainer adds the label to an existing issue", () => {
    const d = runIntake([ev({ kind: "issue_labeled", labels: ["factory:ask"], label_added: "factory:ask", labeled_by: "teammate", actor: "stranger", actor_association: "NONE" })], ctx()).decisions[0]!;
    expect(d.outcome).toBe("settings_request");
  });

  it("an ordinary issue is unaffected", () => {
    const d = runIntake([ev({ labels: [], title: "Export is empty" })], ctx()).decisions[0]!;
    expect(d.outcome).toBe("queued");
  });
});
