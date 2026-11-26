import { describe, expect, it } from "vitest";
import { failedFactoryAudit, type AuditWorkflowRun } from "../lib/audit";

const run = (over: Partial<AuditWorkflowRun> & Pick<AuditWorkflowRun, "id" | "conclusion" | "created_at">): AuditWorkflowRun => ({
  name: "factory-audit",
  path: ".github/workflows/factory-audit.yml",
  status: "completed",
  html_url: `https://github.com/acme/widgets/actions/runs/${over.id}`,
  ...over,
});

describe("a failed factory audit on the briefing", () => {
  it("returns the failed run", () => {
    const failed = run({ id: 2, conclusion: "failure", created_at: "2026-11-02T00:00:00Z" });
    expect(failedFactoryAudit([failed])).toBe(failed);
  });

  it("stays visible until a later audit run is green", () => {
    const failed = run({ id: 2, conclusion: "failure", created_at: "2026-11-02T00:00:00Z" });
    const green = run({ id: 3, conclusion: "success", created_at: "2026-11-03T00:00:00Z" });
    expect(failedFactoryAudit([failed, green])).toBeNull();
    expect(failedFactoryAudit([green, failed])).toBeNull();
  });

  it("keeps the failure while a newer audit run has not finished", () => {
    const failed = run({ id: 2, conclusion: "failure", created_at: "2026-11-02T00:00:00Z" });
    const going = run({ id: 4, conclusion: null, status: "in_progress", created_at: "2026-11-04T00:00:00Z" });
    expect(failedFactoryAudit([going, failed])).toBe(failed);
  });

  it("ignores other workflows", () => {
    const other = run({ id: 1, name: "factory-garden", path: ".github/workflows/factory-garden.yml", conclusion: "failure", created_at: "2026-11-01T00:00:00Z" });
    expect(failedFactoryAudit([other])).toBeNull();
  });

  it("shows a newer failure after an older success", () => {
    const green = run({ id: 1, conclusion: "success", created_at: "2026-11-01T00:00:00Z" });
    const failed = run({ id: 5, conclusion: "failure", created_at: "2026-11-05T00:00:00Z" });
    expect(failedFactoryAudit([green, failed])).toBe(failed);
  });
});
