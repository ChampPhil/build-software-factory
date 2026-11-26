import { parse as parseYaml, parseDocument, isMap } from "yaml";
import catalogue from "./settings.json";

/**
 * The settings a person can change on the Factory page.
 *
 * The catalogue (settings.json) is a copy of the runner's, and these
 * functions mirror the runner's `lib/settings.ts`; a runner test runs both
 * over the same inputs and fails if they ever disagree. Nobody types a file
 * name or a key: a control changes a value, and this turns it into the edited
 * file, keeping every comment.
 */

export type SettingKind = "number" | "integer" | "boolean" | "cron_hour";

export interface Setting {
  readonly id: string;
  readonly path: string;
  readonly kind: SettingKind;
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  readonly label: string;
  readonly help: string;
}

export const SETTINGS: readonly Setting[] = (catalogue as { settings: Setting[] }).settings;
export const FACTORY_YAML = ".factory/definition/factory.yaml";
export const GARDEN_WORKFLOW = ".github/workflows/factory-garden.yml";
export const SETTINGS_LABEL = "factory:settings";

export type SettingValue = number | boolean | null;
export type SettingChanges = Readonly<Record<string, number | boolean>>;

export interface SettingsProblem {
  readonly id: string | null;
  readonly message: string;
}

export function settingById(id: string): Setting | undefined {
  return SETTINGS.find((s) => s.id === id);
}

export function cronHour(cron: unknown): number | null {
  if (typeof cron !== "string") return null;
  const m = /^\s*0\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron);
  if (m === null) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

export const hourToCron = (hour: number): string => `0 ${hour} * * *`;

function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function problemWith(s: Setting, v: unknown): string | null {
  if (s.kind === "boolean") return typeof v === "boolean" ? null : `${s.label} must be on or off.`;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${s.label} must be a number.`;
  if ((s.kind === "integer" || s.kind === "cron_hour") && !Number.isInteger(v)) return `${s.label} must be a whole number.`;
  if (s.min !== undefined && v < s.min) return `${s.label} must be at least ${s.min}.`;
  if (s.max !== undefined && v > s.max) return `${s.label} must be at most ${s.max}.`;
  return null;
}

export function validateChanges(changes: SettingChanges): readonly SettingsProblem[] {
  const out: SettingsProblem[] = [];
  for (const [id, v] of Object.entries(changes)) {
    const s = settingById(id);
    if (s === undefined) { out.push({ id, message: `${id} is not a setting that can be changed here.` }); continue; }
    const p = problemWith(s, v);
    if (p !== null) out.push({ id, message: p });
  }
  return out;
}

export function sharesProblem(doc: unknown): string | null {
  const shares = (doc as { budget?: { shares?: Record<string, unknown> } })?.budget?.shares;
  if (shares === undefined) return null;
  const total = Object.values(shares).reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0);
  return total === 100 ? null : `The budget shares add up to ${total}, not 100.`;
}

export function readSettings(yamlText: string): Readonly<Record<string, SettingValue>> {
  const doc = parseYaml(yamlText) as unknown;
  const out: Record<string, SettingValue> = {};
  for (const s of SETTINGS) {
    const v = getPath(doc, s.path);
    if (s.kind === "cron_hour") out[s.id] = cronHour(v);
    else out[s.id] = typeof v === "number" || typeof v === "boolean" ? v : null;
  }
  return out;
}

export interface ApplyResult {
  readonly yaml: string;
  readonly cron: string | null;
  readonly problems: readonly SettingsProblem[];
}

export function applySettings(yamlText: string, changes: SettingChanges): ApplyResult {
  const problems = [...validateChanges(changes)];
  if (problems.length > 0) return { yaml: yamlText, cron: null, problems };
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return { yaml: yamlText, cron: null, problems: [{ id: null, message: "The factory's settings could not be read." }] };
  }
  let cron: string | null = null;
  for (const [id, v] of Object.entries(changes)) {
    const s = settingById(id)!;
    if (s.kind === "cron_hour") {
      cron = hourToCron(v as number);
      doc.setIn(s.path.split("."), cron);
    } else {
      doc.setIn(s.path.split("."), v);
    }
  }
  const out = doc.toString({ lineWidth: 0 });
  const shares = sharesProblem(parseYaml(out));
  if (shares !== null) return { yaml: yamlText, cron: null, problems: [{ id: null, message: shares }] };
  return { yaml: out, cron, problems: [] };
}

export function replaceCron(workflowText: string, cron: string): string | null {
  const re = /^(\s*-\s*cron:\s*)"[^"]*"(\s*)$/m;
  const matches = workflowText.match(new RegExp(re.source, "gm"));
  if (matches === null || matches.length !== 1) return null;
  return workflowText.replace(re, `$1"${cron}"$2`);
}

/** Only what differs from the current values; unchanged controls are not sent. */
export function changesFrom(current: Readonly<Record<string, SettingValue>>, draft: Readonly<Record<string, SettingValue>>): SettingChanges {
  const out: Record<string, number | boolean> = {};
  for (const s of SETTINGS) {
    const d = draft[s.id];
    if (d === null || d === undefined) continue;
    if (d !== current[s.id]) out[s.id] = d;
  }
  return out;
}

export function describeValue(s: Setting, v: SettingValue): string {
  if (v === null) return "not set";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (s.unit === "usd") return `$${v}`;
  if (s.unit === "percent") return `${v}%`;
  if (s.unit === "utc_hour") return `${String(v).padStart(2, "0")}:00 UTC`;
  return String(v);
}

/**
 * What setup recorded about enforcement in factory.yaml (`enforcement.branch_protection`),
 * for the first load, before a rollup has written `health.enforcement`.
 * "off" means the plan cannot require checks; "auto" means setup has not decided.
 */
export function storedEnforcement(yaml: string | null | undefined): "branch_protection" | "audit" | null {
  const m = /^enforcement:\s*\n(?:[ \t]+.*\n)*?[ \t]+branch_protection:[ \t]*(\w+)/m.exec(yaml ?? "");
  if (m?.[1] === "on") return "branch_protection";
  if (m?.[1] === "off") return "audit";
  return null;
}
