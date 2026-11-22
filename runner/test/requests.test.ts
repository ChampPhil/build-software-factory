import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractGoal } from "../src/commands/request-text.js";
import { acknowledgement } from "../src/commands/acknowledge.js";
import { runIntake, type IncomingEvent, type IntakeContext, type IntakeDecision } from "../src/commands/intake.js";
import { parseYaml } from "../src/lib/yaml.js";
import type { Policy } from "../src/lib/types.js";

describe("the goal in a request", () => {
  it("reads the Goal section a form or the dashboard wrote, and stops at the next heading", () => {
    expect(extractGoal("### What do you want?\n\nExport\n\n### Goal\n\nUsers can download a CSV.\n\n### Notes\n\nx")).toBe("Users can download a CSV.");
    expect(extractGoal("## Goal\nOne line")).toBe("One line");
  });
  it("treats an unfilled field as no goal", () => {
    expect(extractGoal("### Goal\n\n_No response_")).toBeNull();
    expect(extractGoal("### Goal\n\n")).toBeNull();
    expect(extractGoal("nothing here")).toBeNull();
    expect(extractGoal(null)).toBeNull();
  });
  it("caps a very long goal", () => {
    expect(extractGoal(`### Goal\n\n${"a".repeat(900)}`)!.length).toBe(500);
  });
});

const policy = {
  schema: "policy/1",
  trust: { associations: ["OWNER", "MEMBER", "COLLABORATOR"], accept_label: "factory:accept", integration_bots: [] },
} as unknown as Policy;

const ctx = (): IntakeContext => ({
  policy, cursor: 0, openItems: [], recentlyMerged: [],
  triggers: { issues: true, comments: true, ci_failure_on_main: true, dashboard_dispatch: true },
  newId: (e) => `wi_${e.id}`,
});

const issue = (over: Partial<IncomingEvent> = {}): IncomingEvent => ({
  id: 1, kind: "issue_opened", at: "2026-11-22T10:00:00Z", actor: "philip", actor_association: "OWNER", actor_is_bot: false,
  title: "CSV export", body: "### What do you want?\n\nExport\n\n### Goal\n\nUsers can download a CSV.", ref: "#5", labels: [], ...over,
});

const decide = (e: IncomingEvent): IntakeDecision => runIntake([e], ctx()).decisions[0]!;

describe("how intake reads a request", () => {
  it("keeps the goal on the work item", () => {
    expect(decide(issue()).workItem?.goal).toBe("Users can download a CSV.");
  });
  it("does not keep a goal from someone it will not act for", () => {
    const d = decide(issue({ actor_association: "NONE" }));
    expect(d.outcome).toBe("waiting_trust");
    expect(d.workItem?.goal).toBeUndefined();
  });
  it("sends a tidy request to gardening and a plain one to product work", () => {
    expect(decide(issue({ labels: ["factory:tidy"] })).workItem?.pipeline).toBe("gardening");
    expect(decide(issue()).workItem?.pipeline).toBe("product_work");
  });
  it("sends a harden request to hardening", () => {
    expect(decide(issue({ labels: ["factory:harden"] })).workItem?.pipeline).toBe("hardening");
  });
});

describe("the acknowledgement", () => {
  it("says which kind of work it is and what it will check, and promises a question before code", () => {
    const a = acknowledgement(decide(issue()), "factory:accept");
    expect(a?.issue).toBe(5);
    expect(a?.body).toContain("change to the product");
    expect(a?.body).toContain("Users can download a CSV.");
    expect(a?.body).toContain("one question here before it writes any code");
  });
  it("explains an untrusted author's wait and what unblocks it", () => {
    const a = acknowledgement(decide(issue({ actor_association: "NONE" })), "factory:accept");
    expect(a?.body).toContain("`factory:accept`");
  });
  it("says nothing for a request that did not come from an issue", () => {
    expect(acknowledgement(decide({ ...issue({ kind: "dashboard_dispatch" }), ref: null as unknown as string }), "factory:accept")).toBeNull();
  });
  it("thanks a person for answering a question", () => {
    const c = { ...ctx(), openItems: [{ work_item: "wi_a", status: "needs_info", pipeline: "product_work" as const, source_ref: "#5" }] };
    const d = runIntake([{ ...issue({ kind: "issue_comment", id: 2, body: "The settings page" }) }], c).decisions[0]!;
    expect(d.outcome).toBe("answers_open_item");
    expect(acknowledgement(d, "factory:accept")?.body).toContain("answers the question");
  });
});

describe("the issue forms", () => {
  const dir = join(__dirname, "../../templates/issue-forms");
  const forms = readdirSync(dir).filter((f) => f.endsWith(".yml") && f !== "config.yml");

  it("are the four kinds of work", () => {
    expect(forms.sort()).toEqual(["bug.yml", "feature.yml", "harden.yml", "tidy.yml"]);
  });

  for (const f of ["bug.yml", "feature.yml", "harden.yml", "tidy.yml"]) {
    it(`${f} has a required description and an optional goal, and the labels a form must apply`, () => {
      const form = parseYaml(readFileSync(join(dir, f), "utf8")) as {
        name: string; description: string; labels?: string[];
        body: { id: string; type: string; validations?: { required: boolean }; attributes: { label: string } }[];
      };
      expect(form.name).not.toBe("");
      expect(form.description).not.toBe("");
      expect(form.body[0]!.validations?.required).toBe(true);
      const goal = form.body.find((b) => b.id === "goal")!;
      // The label must read "Goal": GitHub turns it into the heading intake looks for.
      expect(goal.attributes.label).toBe("Goal");
      expect(goal.validations?.required).toBe(false);
      if (f === "harden.yml") expect(form.labels).toEqual(["factory:harden"]);
      if (f === "tidy.yml") expect(form.labels).toEqual(["factory:tidy"]);
      if (f === "feature.yml" || f === "bug.yml") expect(form.labels).toBeUndefined();
    });
  }
});
