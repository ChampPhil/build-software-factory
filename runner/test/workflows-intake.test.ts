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
