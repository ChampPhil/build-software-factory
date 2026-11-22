import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATALOGUE, FACTORY_YAML, GARDEN_WORKFLOW, applySettings, readSettings, replaceCron, type SettingChanges,
} from "../lib/settings.js";

/**
 * `bsf settings` — read or change the settings a person may change.
 *
 * This is what the setup skill's agent runs when someone asks, in words, for a
 * change the dashboard has no control for yet: it never edits the settings
 * file by hand. The same functions the dashboard uses check the value, keep the
 * file's comments and move the cleanup workflow's schedule with it.
 */

export interface SettingsRunResult {
  readonly ok: boolean;
  readonly lines: readonly string[];
  readonly changed: readonly string[];
}

/** `monthly_budget=50` → 50, `auto_merge_gardening=on` → true. Anything else is refused by the caller. */
export function parseAssignments(raw: string): { readonly changes: SettingChanges; readonly problems: readonly string[] } {
  const changes: Record<string, number | boolean> = {};
  const problems: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const m = /^([a-z_]+)=(.+)$/.exec(part);
    if (m === null) { problems.push(`"${part}" is not id=value.`); continue; }
    const v = m[2]!.trim().toLowerCase();
    if (["on", "true", "yes"].includes(v)) changes[m[1]!] = true;
    else if (["off", "false", "no"].includes(v)) changes[m[1]!] = false;
    else if (v !== "" && Number.isFinite(Number(v))) changes[m[1]!] = Number(v);
    else problems.push(`"${m[2]}" is not a number or on/off.`);
  }
  return { changes, problems };
}

function show(v: number | boolean | null, unit?: string): string {
  if (v === null) return "not set";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (unit === "usd") return `$${v}`;
  if (unit === "percent") return `${v}%`;
  if (unit === "utc_hour") return `${String(v).padStart(2, "0")}:00 UTC`;
  return String(v);
}

export function runSettings(opts: { readonly root: string; readonly set?: string }): SettingsRunResult {
  const file = join(opts.root, FACTORY_YAML);
  if (!existsSync(file)) {
    return { ok: false, lines: ["There is no factory in this folder yet."], changed: [] };
  }
  const text = readFileSync(file, "utf8");

  if (opts.set === undefined) {
    const cur = readSettings(text);
    return {
      ok: true,
      changed: [],
      lines: CATALOGUE.settings.map((s) => `${s.id.padEnd(26)} ${show(cur[s.id] ?? null, s.unit).padEnd(12)} ${s.label}`),
    };
  }

  const { changes, problems } = parseAssignments(opts.set);
  if (problems.length > 0) return { ok: false, lines: problems, changed: [] };
  const before = readSettings(text);
  const result = applySettings(text, changes);
  if (result.problems.length > 0) return { ok: false, lines: result.problems.map((p) => p.message), changed: [] };

  const workflowPath = join(opts.root, GARDEN_WORKFLOW);
  let workflow: string | null = null;
  if (result.cron !== null) {
    if (!existsSync(workflowPath)) return { ok: false, lines: ["The cleanup workflow is not installed, so its time cannot be changed."], changed: [] };
    workflow = replaceCron(readFileSync(workflowPath, "utf8"), result.cron);
    if (workflow === null) return { ok: false, lines: ["The cleanup workflow's schedule is not in a form that can be changed safely."], changed: [] };
  }

  writeFileSync(file, result.yaml);
  if (workflow !== null) writeFileSync(workflowPath, workflow);
  const after = readSettings(result.yaml);
  const changed = Object.keys(changes);
  return {
    ok: true,
    changed,
    lines: changed.map((id) => {
      const s = CATALOGUE.settings.find((x) => x.id === id)!;
      return `${s.label}: ${show(before[id] ?? null, s.unit)} -> ${show(after[id] ?? null, s.unit)}`;
    }),
  };
}
