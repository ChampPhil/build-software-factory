import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHub } from "../lib/github.js";
import { FactoryStore, LEDGER, json, workItemPath } from "../lib/store.js";
import type { Change } from "../lib/dataref.js";
import type { Baselines } from "../lib/types.js";
import { fingerprint } from "./intake.js";

const exec = promisify(execFile);

/**
 * `bsf garden` — the nightly scan and the night's picks (doc 06).
 *
 * The scan has three parts. Two are measurable without a model and are done
 * here: rules with counts above zero in the baselines, and behaviour merged in
 * the last fourteen days with no test alongside it. The third — principle
 * drift no rule catches — is the gardener role's job, and this command hands
 * it the measured part as context so it spends its run on what a script
 * cannot see.
 */

export type DriftKind = "baselined_violations" | "untested_recent_behaviour" | "principle_drift";

export interface DriftItem {
  readonly kind: DriftKind;
  /** One problem class per PR, so this is what the PR will be about. */
  readonly problem_class: string;
  readonly occurrences: number;
  readonly files: readonly string[];
  readonly detail: string;
}

export interface ScanResult {
  readonly items: readonly DriftItem[];
  readonly skipped: readonly { readonly problem_class: string; readonly reason: string }[];
}

/** Rules whose count is above zero, worst first. */
export function baselinedDrift(baselines: Baselines): readonly DriftItem[] {
  const byRule = new Map<string, { count: number; files: string[] }>();
  for (const [rule, perFile] of Object.entries(baselines.rules ?? {})) {
    for (const [file, count] of Object.entries(perFile)) {
      if (count <= 0) continue;
      const e = byRule.get(rule) ?? { count: 0, files: [] };
      e.count += count;
      e.files.push(file);
      byRule.set(rule, e);
    }
  }
  return [...byRule.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([rule, e]) => ({
      kind: "baselined_violations" as const,
      problem_class: rule,
      occurrences: e.count,
      // Capped at the per-PR file limit, so the item as filed is already
      // small enough to be one reviewable PR (doc 06: at most 20 files).
      files: e.files.slice(0, MAX_FILES_PER_PR),
      detail:
        `${e.count} baselined violation(s) of ${rule} across ${e.files.length} file(s)` +
        (e.files.length > MAX_FILES_PER_PR ? `; this PR takes the first ${MAX_FILES_PER_PR}` : ""),
    }));
}

export const MAX_FILES_PER_PR = 20;
const TEST_PATTERN = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[tj]sx?$|_test\.py$|^test_.*\.py$/i;

const isTest = (p: string): boolean => TEST_PATTERN.test(p) || TEST_FILE.test(p.split("/").pop() ?? "");

/**
 * Source files merged in the window whose merge commit added no test. Looking
 * per commit rather than per file is deliberate: a change with its tests in
 * the same commit is tested, whichever file holds them.
 */
export async function untestedRecent(
  root: string,
  days: number,
  sourceGlobs: readonly string[] = [],
): Promise<readonly DriftItem[]> {
  let log: string;
  try {
    const { stdout } = await exec(
      "git",
      ["log", `--since=${days} days ago`, "--first-parent", "--format=%H", "--no-merges"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    log = String(stdout);
  } catch {
    // A shallow clone has no history to read; saying nothing beats guessing.
    return [];
  }

  const untested = new Map<string, string[]>();
  for (const sha of log.split("\n").map((s) => s.trim()).filter((s) => s !== "")) {
    let files: string[];
    try {
      const { stdout } = await exec("git", ["show", "--name-only", "--format=", sha], { cwd: root });
      files = String(stdout).split("\n").map((s) => s.trim()).filter((s) => s !== "");
    } catch {
      continue;
    }
    if (files.some(isTest)) continue;
    const source = files.filter((f) => !isTest(f) && looksLikeSource(f, sourceGlobs));
    if (source.length === 0) continue;
    for (const f of source) {
      const dir = f.split("/").slice(0, -1).join("/") || ".";
      const list = untested.get(dir);
      if (list === undefined) untested.set(dir, [f]);
      else list.push(f);
    }
  }

  return [...untested.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([dir, files]) => ({
      kind: "untested_recent_behaviour" as const,
      problem_class: `untested behaviour in ${dir}`,
      occurrences: files.length,
      files: [...new Set(files)].slice(0, MAX_FILES_PER_PR),
      detail: `${new Set(files).size} file(s) changed in the last ${days} days with no test in the same commit`,
    }));
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|kt|rs|cs|php|swift)$/i;

function looksLikeSource(path: string, globs: readonly string[]): boolean {
  if (globs.length > 0) return globs.some((g) => path.startsWith(g.replace(/\*+$/, "")));
  if (!SOURCE_EXT.test(path)) return false;
  // Generated and vendored trees are nobody's untested behaviour.
  return !/(^|\/)(node_modules|dist|build|vendor|\.next|coverage|migrations)\//.test(path);
}

export interface GardenOptions {
  readonly gh: GitHub;
  readonly now: string;
  readonly root: string;
  readonly baselines: Baselines;
  readonly maxPrs: number;
  readonly windowDays?: number;
  readonly sourceGlobs?: readonly string[];
  readonly extra?: readonly DriftItem[];
  /** Concurrency slots free right now; the rest stay queued for the rollup. */
  readonly freeSlots?: number;
  readonly ref?: string;
  readonly plan?: boolean;
}

export interface GardenReport {
  readonly scan: ScanResult;
  readonly picked: readonly DriftItem[];
  readonly filed: readonly string[];
  readonly dispatched: readonly string[];
}

/** Order: worst baselines, then untested behaviour, then principle drift. */
const ORDER: Readonly<Record<DriftKind, number>> = {
  baselined_violations: 0,
  untested_recent_behaviour: 1,
  principle_drift: 2,
};

export async function runGardenCommand(opts: GardenOptions): Promise<GardenReport> {
  const store = new FactoryStore(opts.gh);
  const ledger = await store.ledger(opts.now);

  // Anything an open PR already fixes is not tonight's work: re-filing it
  // would mean two PRs racing on the same files.
  const alreadyFixing = new Set(ledger.open.flatMap((o) => o.fixes ?? []));

  const found = [
    ...baselinedDrift(opts.baselines),
    ...(await untestedRecent(opts.root, opts.windowDays ?? 14, opts.sourceGlobs ?? [])),
    ...(opts.extra ?? []),
  ];

  const skipped: { problem_class: string; reason: string }[] = [];
  const eligible = found.filter((i) => {
    if (alreadyFixing.has(i.problem_class)) {
      skipped.push({ problem_class: i.problem_class, reason: "an open PR already fixes this" });
      return false;
    }
    return true;
  });

  const picked = eligible
    .slice()
    .sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.occurrences - a.occurrences)
    .slice(0, Math.max(0, opts.maxPrs));

  const changes: Change[] = [];
  const filed: string[] = [];
  const open = [...ledger.open];

  for (const [n, item] of picked.entries()) {
    const id = `wi-${opts.now.slice(0, 10)}-g${String(n + 1).padStart(2, "0")}`;
    const workItem = {
      schema: "work-item/1" as const,
      id,
      created_at: opts.now,
      source: { kind: "schedule_gardening", ref: null, actor: "factory", via: null },
      trigger_class: "scheduled" as const,
      pipeline: "gardening" as const,
      title: `Gardening: ${item.problem_class}`,
      body: `${item.detail}\n\nFiles:\n${item.files.map((f) => `- ${f}`).join("\n")}`,
      priority: "normal" as const,
      fingerprint: fingerprint({ title: item.problem_class, body: item.kind }),
      status: "queued" as const,
      runs: [],
      pr: null,
      parent: null,
      related: [],
      spec: null,
    };
    changes.push({ path: workItemPath(id), content: json(workItem) });
    open.push({
      work_item: id,
      pipeline: "gardening",
      status: "queued",
      fingerprint: workItem.fingerprint,
      priority: "normal",
      created_at: opts.now,
      // The ledger's `fixes` list is what stops the next night re-filing this.
      fixes: [item.problem_class],
    });
    filed.push(id);
  }

  if (changes.length > 0) {
    changes.push({ path: LEDGER, content: json({ ...ledger, updated_at: opts.now, open }) });
    await store.put(changes, `garden: file ${filed.length} item(s)`);
  }

  // Dispatch only into free slots. The rest stay queued, and the rollup
  // sweep dispatches them as runs finish — so the night's cap on PRs is not
  // also a burst of five concurrent runs.
  const slots = opts.freeSlots ?? filed.length;
  const dispatched: string[] = [];
  if (opts.plan !== true) {
    for (const id of filed.slice(0, Math.max(0, slots))) {
      await opts.gh.dispatchWorkflow("factory-run.yml", opts.ref ?? "main", { work_item: id });
      dispatched.push(id);
    }
  }

  return { scan: { items: found, skipped }, picked, filed, dispatched };
}
