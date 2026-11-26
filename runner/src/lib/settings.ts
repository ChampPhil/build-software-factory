import { parse as parseYaml, parseDocument, isMap, type Document } from "yaml";

/**
 * The settings a person may change, and how a change is made.
 *
 * Nobody edits `factory.yaml`. The dashboard (and the setup skill, through
 * `bsf settings`) change it with these functions, which keep the file's
 * comments, refuse a value out of range, and report exactly which keys moved.
 * The policy check uses the same list: a settings pull request goes through
 * on its author's say-so only if every key it changed is here.
 *
 * `dashboard/lib/settings.json` is a copy of {@link CATALOGUE}; a test keeps
 * the two equal.
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

export const FACTORY_YAML = ".factory/definition/factory.yaml";
/** The one workflow file a settings change may touch, and only its cron line. */
export const GARDEN_WORKFLOW = ".github/workflows/factory-garden.yml";
export const SETTINGS_LABEL = "factory:settings";

export const CATALOGUE: { readonly schema: "settings/1"; readonly settings: readonly Setting[] } = {
  schema: "settings/1",
  settings: [
    { id: "monthly_budget", path: "budget.monthly_usd", kind: "number", min: 1, max: 100000, unit: "usd",
      label: "Monthly budget", help: "The most the factory spends on models in a month. A hard cap: agent steps stop before they could pass it." },
    { id: "share_product_work", path: "budget.shares.product_work", kind: "integer", min: 0, max: 100, unit: "percent",
      label: "Product work share", help: "Percent of the budget product work may use. The three shares add up to 100." },
    { id: "share_gardening", path: "budget.shares.gardening", kind: "integer", min: 0, max: 100, unit: "percent",
      label: "Gardening share", help: "Percent of the budget the nightly cleanup may use." },
    { id: "share_review", path: "budget.shares.review_and_benchmarks", kind: "integer", min: 0, max: 100, unit: "percent",
      label: "Review share", help: "Percent of the budget the scheduled review may use." },
    { id: "auto_merge_product_work", path: "pipelines.product_work.auto_merge", kind: "boolean",
      label: "Merge product work by itself", help: "Off: a person approves each draft PR. Turn on only when its revert rate gives you reason to." },
    { id: "auto_merge_gardening", path: "pipelines.gardening.auto_merge", kind: "boolean",
      label: "Merge gardening by itself", help: "Off: a person approves each cleanup PR." },
    { id: "auto_merge_hardening", path: "pipelines.hardening.auto_merge", kind: "boolean",
      label: "Merge hardening by itself", help: "Off: a person approves each hardening PR." },
    { id: "auto_merge_definition_change", path: "pipelines.definition_change.auto_merge", kind: "boolean",
      label: "Merge a factory-definition change by itself", help: "Off: a person approves a change to the factory's own definition." },
    { id: "auto_merge_conflict_fix", path: "pipelines.conflict_fix.auto_merge", kind: "boolean",
      label: "Merge a conflict fix by itself", help: "Off: a person approves a pull request rebuilt after main moved." },
    { id: "gardening_prs", path: "pipelines.gardening.max_prs_per_run", kind: "integer", min: 1, max: 10, unit: "prs",
      label: "Cleanup PRs per night", help: "How many cleanup PRs the nightly gardening run may open." },
    { id: "gardening_hour", path: "pipelines.gardening.schedule", kind: "cron_hour", min: 0, max: 23, unit: "utc_hour",
      label: "Cleanup time", help: "The hour (UTC) the nightly cleanup starts. Changing it also changes the schedule in the cleanup workflow." },
  ],
};

export const SETTING_PATHS: readonly string[] = CATALOGUE.settings.map((s) => s.path);

export function settingById(id: string): Setting | undefined {
  return CATALOGUE.settings.find((s) => s.id === id);
}

/** What a person asked for: setting id → value. */
export type SettingChanges = Readonly<Record<string, number | boolean>>;

export interface SettingsProblem {
  readonly id: string | null;
  readonly message: string;
}

/** `0 6 * * *` → 6; anything not a plain daily-at-hour cron → null. */
export function cronHour(cron: unknown): number | null {
  if (typeof cron !== "string") return null;
  const m = /^\s*0\s+(\d{1,2})\s+\*\s+\*\s+\*\s*$/.exec(cron);
  if (m === null) return null;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : null;
}

export const hourToCron = (hour: number): string => `0 ${hour} * * *`;

function valid(s: Setting, v: unknown): string | null {
  if (s.kind === "boolean") return typeof v === "boolean" ? null : `${s.label} must be on or off.`;
  if (typeof v !== "number" || !Number.isFinite(v)) return `${s.label} must be a number.`;
  if ((s.kind === "integer" || s.kind === "cron_hour") && !Number.isInteger(v)) return `${s.label} must be a whole number.`;
  if (s.min !== undefined && v < s.min) return `${s.label} must be at least ${s.min}.`;
  if (s.max !== undefined && v > s.max) return `${s.label} must be at most ${s.max}.`;
  return null;
}

/** The three budget shares must add up to 100, wherever they came from. */
export function sharesProblem(doc: unknown): string | null {
  const shares = (doc as { budget?: { shares?: Record<string, unknown> } })?.budget?.shares;
  if (shares === undefined) return null;
  const total = Object.values(shares).reduce<number>((n, v) => n + (typeof v === "number" ? v : 0), 0);
  return total === 100 ? null : `The budget shares add up to ${total}, not 100.`;
}

export function validateChanges(changes: SettingChanges): readonly SettingsProblem[] {
  const out: SettingsProblem[] = [];
  for (const [id, v] of Object.entries(changes)) {
    const s = settingById(id);
    if (s === undefined) { out.push({ id, message: `${id} is not a setting that can be changed here.` }); continue; }
    const p = valid(s, v);
    if (p !== null) out.push({ id, message: p });
  }
  return out;
}

export function getPath(doc: unknown, path: string): unknown {
  let cur: unknown = doc;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Current values, as the controls show them. A cron that is not daily-at-an-hour reads as null. */
export function readSettings(yamlText: string): Readonly<Record<string, number | boolean | null>> {
  const doc = parseYaml(yamlText) as unknown;
  const out: Record<string, number | boolean | null> = {};
  for (const s of CATALOGUE.settings) {
    const v = getPath(doc, s.path);
    if (s.kind === "cron_hour") out[s.id] = cronHour(v);
    else out[s.id] = typeof v === "number" || typeof v === "boolean" ? v : null;
  }
  return out;
}

export interface ApplyResult {
  readonly yaml: string;
  /** The garden workflow's new cron, when the schedule changed. */
  readonly cron: string | null;
  readonly problems: readonly SettingsProblem[];
}

function setIn(doc: Document, path: string, value: unknown): void {
  doc.setIn(path.split("."), value);
}

/**
 * Apply changes to the text of `factory.yaml`, keeping its comments and layout.
 * Nothing is returned changed if any value is out of range or the shares stop
 * adding up to 100, so a half-valid change never reaches a pull request.
 */
export function applySettings(yamlText: string, changes: SettingChanges): ApplyResult {
  const problems = [...validateChanges(changes)];
  if (problems.length > 0) return { yaml: yamlText, cron: null, problems };
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    return { yaml: yamlText, cron: null, problems: [{ id: null, message: "The factory's settings file could not be read." }] };
  }
  let cron: string | null = null;
  for (const [id, v] of Object.entries(changes)) {
    const s = settingById(id)!;
    if (s.kind === "cron_hour") {
      cron = hourToCron(v as number);
      setIn(doc, s.path, cron);
    } else {
      setIn(doc, s.path, v);
    }
  }
  const out = doc.toString({ lineWidth: 0 });
  const shares = sharesProblem(parseYaml(out));
  if (shares !== null) return { yaml: yamlText, cron: null, problems: [{ id: null, message: shares }] };
  return { yaml: out, cron, problems: [] };
}

/** Every dotted key path whose value differs, down to scalars and arrays. */
export function changedPaths(a: unknown, b: unknown, prefix = ""): readonly string[] {
  const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => changedPaths(a[k], b[k], prefix === "" ? k : `${prefix}.${k}`));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

export interface SettingsDiff {
  /** Every key that changed between the two files. */
  readonly changed: readonly string[];
  /** Changed keys the catalogue does not allow. Empty means a settings-only change. */
  readonly outside: readonly string[];
  /** Values the catalogue refuses (out of range, shares not 100, bad cron). */
  readonly invalid: readonly string[];
}

/** What a PR did to `factory.yaml`, judged against the list. Both texts are data; nothing in them is run. */
export function diffSettings(baseYaml: string, headYaml: string): SettingsDiff {
  let base: unknown;
  let head: unknown;
  try {
    base = parseYaml(baseYaml);
    head = parseYaml(headYaml);
  } catch {
    return { changed: ["(unreadable)"], outside: ["(unreadable)"], invalid: [] };
  }
  const changed = changedPaths(base, head);
  const outside = changed.filter((p) => !SETTING_PATHS.includes(p));
  const invalid: string[] = [];
  for (const p of changed) {
    const s = CATALOGUE.settings.find((x) => x.path === p);
    if (s === undefined) continue;
    const v = getPath(head, p);
    const problem = s.kind === "cron_hour" ? (cronHour(v) === null ? `${s.label} must be a daily hour.` : null) : valid(s, v);
    if (problem !== null) invalid.push(problem);
  }
  const shares = changed.some((p) => p.startsWith("budget.shares")) ? sharesProblem(head) : null;
  if (shares !== null) invalid.push(shares);
  return { changed, outside, invalid };
}

/**
 * Whether a unified diff of the garden workflow changes only the cron line:
 * one removed and one added `- cron:` line, the new one a daily hour.
 */
export function onlyCronLineChanged(patch: string | undefined): boolean {
  if (patch === undefined) return false;
  const lines = patch.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (lines.length !== 2) return false;
  const removed = lines.find((l) => l.startsWith("-"));
  const added = lines.find((l) => l.startsWith("+"));
  if (removed === undefined || added === undefined) return false;
  const re = /^[+-]\s*-\s*cron:\s*"([^"]*)"\s*$/;
  const a = re.exec(added);
  return re.test(removed) && a !== null && cronHour(a[1]) !== null;
}

/** The garden workflow with its cron line replaced. Null when it has no single cron line to replace. */
export function replaceCron(workflowText: string, cron: string): string | null {
  const re = /^(\s*-\s*cron:\s*)"[^"]*"(\s*)$/m;
  const matches = workflowText.match(new RegExp(re.source, "gm"));
  if (matches === null || matches.length !== 1) return null;
  return workflowText.replace(re, `$1"${cron}"$2`);
}


