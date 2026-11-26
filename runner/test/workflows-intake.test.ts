import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

function root(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "templates"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const wf = (name: string) => parse(readFileSync(join(root(), "templates/workflows", name), "utf8")) as Record<string, any>;

describe("factory-intake (fix 4)", () => {
  const intake = wf("factory-intake.yml");

  it("has no workflow-level concurrency: a pending run cannot cancel another's record", () => {
    expect(intake["concurrency"]).toBeUndefined();
  });

  it("records in a group of its own per run and never cancels", () => {
    const c = intake["jobs"]["record"]["concurrency"];
    expect(c["group"]).toContain("github.run_id");
    expect(c["cancel-in-progress"]).toBe(false);
  });

  it("processes one at a time after recording, queueing and never cancelling", () => {
    const j = intake["jobs"]["process"];
    expect(j["needs"]).toBe("record");
    expect(j["concurrency"]).toEqual({ group: "factory-intake", "cancel-in-progress": false });
    const run = j["steps"].map((s: any) => s.run ?? "").join("\n");
    expect(run).toContain("bsf intake --at");
  });

  it("records with --record-only", () => {
    const run = intake["jobs"]["record"]["steps"].map((s: any) => s.run ?? "").join("\n");
    expect(run).toContain("bsf intake --record-only");
  });
});

describe("bot noise (fix 5)", () => {
  it("intake ignores a bot's issue events but not a CI run or the dashboard's dispatch", () => {
    const i = wf("factory-intake.yml")["jobs"];
    for (const job of ["record", "process"]) {
      const cond = String(i[job]["if"]);
      expect(cond).toContain("github.event.sender.type != 'Bot'");
      expect(cond).toContain("workflow_run");
      expect(cond).toContain("workflow_dispatch");
    }
  });

  it("policy skips labels it does not judge", () => {
    const cond = String(wf("factory-policy.yml")["jobs"]["policy"]["if"]);
    expect(cond).toContain("factory:hardening");
    expect(cond).not.toContain("factory:cleared");
    expect(cond).not.toContain("factory:escalated");
  });

  it("merge ignores a check suite with no pull request", () => {
    const cond = String(wf("factory-merge.yml")["jobs"]["queue"]["if"]);
    expect(cond).toContain("check_suite.pull_requests");
  });
});

describe("factory-run routes on state (fix 7)", () => {
  const run = wf("factory-run.yml")["jobs"];
  it("exposes skip_triage and brainstorm_open from plan", () => {
    expect(run["plan"]["outputs"]["skip_triage"]).toBeDefined();
    expect(run["plan"]["outputs"]["brainstorm_open"]).toBeDefined();
  });
  it("a reply to an open conversation goes to brainstorm and spec waits for it", () => {
    expect(String(run["brainstorm"]["if"])).toContain("brainstorm_open == 'true'");
    expect(String(run["spec"]["if"])).toContain("brainstorm_open != 'true'");
  });
});
