import { describe, it, expect, beforeEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAssignments, runSettings } from "../src/commands/settings-run.js";

const T = new URL("../../templates/", import.meta.url).pathname;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bsf-set-"));
  mkdirSync(join(root, ".factory/definition"), { recursive: true });
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  cpSync(join(T, "definition/factory.yaml"), join(root, ".factory/definition/factory.yaml"));
  cpSync(join(T, "workflows/factory-garden.yml"), join(root, ".github/workflows/factory-garden.yml"));
});

describe("bsf settings", () => {
  it("lists every setting with its current value and a plain label", () => {
    const r = runSettings({ root });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(/monthly_budget\s+\$35\s+Monthly budget/);
    expect(r.lines.join("\n")).toMatch(/gardening_hour\s+06:00 UTC/);
  });

  it("changes a value, keeps the comments, and says what moved", () => {
    const r = runSettings({ root, set: "monthly_budget=50,auto_merge_gardening=on" });
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(["Monthly budget: $35 -> $50", "Merge gardening by itself: off -> on"]);
    const text = readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8");
    expect(text).toContain("a ceiling, not an");
    expect((parseYaml(text) as { budget: { monthly_usd: number } }).budget.monthly_usd).toBe(50);
  });

  it("moves the cleanup workflow's schedule with the setting", () => {
    expect(runSettings({ root, set: "gardening_hour=2" }).ok).toBe(true);
    expect(readFileSync(join(root, ".github/workflows/factory-garden.yml"), "utf8")).toContain('- cron: "0 2 * * *"');
    expect(readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8")).toContain('"0 2 * * *"');
  });

  it("changes nothing when any value is refused", () => {
    const before = readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8");
    const r = runSettings({ root, set: "monthly_budget=60,gardening_prs=99" });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/at most 10/);
    expect(readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8")).toBe(before);
    expect(runSettings({ root, set: "models_spec=1" }).ok).toBe(false);
    expect(runSettings({ root, set: "garbage" }).lines[0]).toMatch(/id=value/);
  });

  it("refuses to change the schedule when the workflow is missing or has no single cron line", () => {
    writeFileSync(join(root, ".github/workflows/factory-garden.yml"), "on:\n  workflow_dispatch:\n");
    const r = runSettings({ root, set: "gardening_hour=4" });
    expect(r.ok).toBe(false);
    expect(readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8")).toContain('"0 6 * * *"');
  });

  it("says so, without a path, when there is no factory", () => {
    expect(runSettings({ root: mkdtempSync(join(tmpdir(), "bsf-none-")) })).toMatchObject({ ok: false });
  });

  it("reads assignments", () => {
    expect(parseAssignments("a=1, b=off ,c=TRUE").changes).toEqual({ a: 1, b: false, c: true });
    expect(parseAssignments("a=x").problems).toHaveLength(1);
  });
});
