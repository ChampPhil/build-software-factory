import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as dash from "../lib/settings.js";
import * as runner from "../../runner/src/lib/settings.js";

const template = readFileSync(new URL("../../templates/definition/factory.yaml", import.meta.url), "utf8");
const garden = readFileSync(new URL("../../templates/workflows/factory-garden.yml", import.meta.url), "utf8");

describe("the dashboard's settings logic matches the runner's", () => {
  const matrix: Record<string, number | boolean>[] = [
    { monthly_budget: 50 }, { monthly_budget: 0 }, { monthly_budget: 12.5 },
    { share_product_work: 50, share_gardening: 30, share_review: 20 }, { share_gardening: 40 },
    { auto_merge_product_work: true, auto_merge_hardening: true }, { auto_merge_gardening: 1 },
    { gardening_prs: 3 }, { gardening_prs: 11 }, { gardening_prs: 1.5 },
    { gardening_hour: 0 }, { gardening_hour: 23 }, { gardening_hour: 24 },
    { models_spec: 1 }, {},
  ];

  it.each(matrix.map((m) => [JSON.stringify(m), m] as const))("gives the same file and the same refusals for %s", (_n, changes) => {
    const a = dash.applySettings(template, changes);
    const b = runner.applySettings(template, changes);
    expect(a.yaml).toBe(b.yaml);
    expect(a.cron).toBe(b.cron);
    expect(a.problems.map((p) => p.message)).toEqual(b.problems.map((p) => p.message));
  });

  it("reads the same current values, and the same cron", () => {
    expect(dash.readSettings(template)).toEqual(runner.readSettings(template));
    expect(dash.replaceCron(garden, "0 4 * * *")).toBe(runner.replaceCron(garden, "0 4 * * *"));
    expect(dash.SETTINGS).toEqual(runner.CATALOGUE.settings);
    expect(dash.SETTINGS_LABEL).toBe(runner.SETTINGS_LABEL);
    expect(dash.FACTORY_YAML).toBe(runner.FACTORY_YAML);
    expect(dash.GARDEN_WORKFLOW).toBe(runner.GARDEN_WORKFLOW);
  });
});

describe("the controls' view of settings", () => {
  const current = dash.readSettings(template);

  it("sends only what differs from the current values", () => {
    expect(dash.changesFrom(current, { ...current, monthly_budget: 60 })).toEqual({ monthly_budget: 60 });
    expect(dash.changesFrom(current, current)).toEqual({});
    expect(dash.changesFrom(current, { ...current, gardening_hour: null })).toEqual({});
  });

  it("describes each kind of value in words", () => {
    const by = (id: string) => dash.settingById(id)!;
    expect(dash.describeValue(by("monthly_budget"), 35)).toBe("$35");
    expect(dash.describeValue(by("share_gardening"), 25)).toBe("25%");
    expect(dash.describeValue(by("auto_merge_gardening"), false)).toBe("off");
    expect(dash.describeValue(by("gardening_hour"), 6)).toBe("06:00 UTC");
    expect(dash.describeValue(by("gardening_prs"), null)).toBe("not set");
  });
});

import { storedEnforcement } from "../lib/settings";
describe("enforcement recorded at setup", () => {
  const yaml = (v: string) => `a: 1\nenforcement:\n  merge_queue: auto\n  branch_protection: ${v}\n`;
  it("off is audit, on is branch protection, auto is unknown", () => {
    expect(storedEnforcement(yaml("off"))).toBe("audit");
    expect(storedEnforcement(yaml("on"))).toBe("branch_protection");
    expect(storedEnforcement(yaml("auto"))).toBeNull();
    expect(storedEnforcement(null)).toBeNull();
  });
});
