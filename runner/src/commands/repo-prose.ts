/**
 * The repo's own prose: the conventions its owners write down for agents.
 *
 * Every role reads `.factory/definition/context/`, which the factory writes and
 * owns. For a long time that was *all* a role read, and the effect was absurd:
 * a repo with an `AGENTS.md` stating its house style had that file ignored by
 * every build, while the factory consulted its own paraphrase of the same thing
 * written once at setup. The owners maintain `AGENTS.md`. They do not maintain
 * the paraphrase. So the paraphrase went stale and the builder kept producing
 * changes a reviewer would reject on sight.
 *
 * These files are the primary source, and the factory's context is a supplement
 * for the things that have no home in the codebase.
 *
 * Nothing is recorded at setup. An index written once is a second thing to keep
 * current, and it is wrong the moment someone adds a `CONVENTIONS.md`. The names
 * below are resolved on every run instead, so a file added today is read today.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Policy } from "../lib/types.js";

/**
 * Loaded into **every** agent run, by the harness or by the role's own
 * instructions. A line added here is paid for on every run, for as long as the
 * repo exists, which is why these are the files the budget applies to.
 */
export const ALWAYS: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "CONVENTIONS.md",
  ".cursorrules",
  ".windsurfrules",
];

/**
 * Read when the work touches what they cover, not on every run. No budget:
 * a long contributing guide costs nothing until something needs it.
 */
export const ON_DEMAND: readonly string[] = [
  "CONTRIBUTING.md",
  "STYLEGUIDE.md",
  "STYLE.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "docs/conventions.md",
  "docs/style-guide.md",
];

/** Directories of agent instructions, each file read on demand. */
export const ON_DEMAND_DIRS: readonly string[] = [".claude/skills", ".cursor/rules", ".agents"];

/**
 * Never prose, whoever asks.
 *
 * `.factory/` is the text that governs the roles — the policy that says what a
 * pipeline may change, the guardrails every change is gated on, the role
 * instructions themselves. A hardener that may write there can edit its own
 * constraints, and it would arrive looking like a helpful paragraph. `.github/`
 * is how anything runs at all.
 */
const NEVER = [/^\.factory(\/|$)/, /^\.github\/workflows(\/|$)/, /^\.git(\/|$)/];

export function eligible(path: string): boolean {
  const p = path.split(sep).join("/");
  return !NEVER.some((re) => re.test(p));
}

/**
 * How many bytes of always-loaded prose is reasonable.
 *
 * 16 KiB is about four thousand words in one file, which is already more than
 * anyone reads carefully. The number matters less than having one: the failure
 * it prevents is a hardening pipeline that appends a line per correction until
 * the file it keeps adding to is the thing degrading every run.
 *
 * The cap fails growth. A file the owners already wrote, left the same size,
 * is not a defect, even when it is over the cap. A pull request that makes
 * such a file larger, and leaves it over the cap, fails.
 */
export const DEFAULT_BUDGET_BYTES = 16_384;

export interface ProseDoc {
  /** Repo-relative, forward slashes on every platform. */
  readonly path: string;
  readonly bytes: number;
  /** `always`: in every run's context, and under budget. `on_demand`: read when relevant. */
  readonly load: "always" | "on_demand";
  /** `convention`: found by a name agents already read. `declared`: the policy names it. */
  readonly source: "convention" | "declared";
}

export interface ProseScan {
  readonly docs: readonly ProseDoc[];
  /** The policy declares it; the checkout does not have it. A pointer that has gone stale. */
  readonly missing: readonly string[];
  /** Declared and refused: under `.factory/`, `.github/workflows/` or `.git/`. */
  readonly refused: readonly string[];
}

interface ProsePolicy {
  readonly targets?: readonly string[];
  readonly budget_bytes?: number;
}

/** The policy's `prose` block, if the repo has set one. */
export function prosePolicy(policy: Policy | null | undefined): ProsePolicy {
  const raw = (policy as { readonly prose?: ProsePolicy } | null | undefined)?.prose;
  return raw ?? {};
}

export function budgetBytes(policy: Policy | null | undefined): number {
  const n = prosePolicy(policy).budget_bytes;
  return typeof n === "number" && n > 0 ? n : DEFAULT_BUDGET_BYTES;
}

function size(root: string, rel: string): number | null {
  try {
    const s = statSync(join(root, rel));
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function filesUnder(root: string, dir: string, depth = 0): string[] {
  if (depth > 3) return [];
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const rel = `${dir}/${name}`;
    let s;
    try {
      s = statSync(join(root, rel));
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...filesUnder(root, rel, depth + 1));
    else if (s.isFile() && /\.(md|mdc|txt)$/i.test(name)) out.push(rel);
  }
  return out;
}

/**
 * Resolve the repo's prose: the names agents already read, plus anything
 * the policy declares, minus anything that is not the owners' to hand over.
 *
 * A path a repo declares is trusted to be what it says it is — a file the owners
 * keep — but it is still refused under `.factory/`, because declaring it there
 * would be the escalation this function exists to prevent.
 */
export function scanProse(root: string, policy?: Policy | null): ProseScan {
  const docs: ProseDoc[] = [];
  const seen = new Set<string>();
  const add = (rel: string, load: ProseDoc["load"], source: ProseDoc["source"]): void => {
    if (seen.has(rel)) return;
    const bytes = size(root, rel);
    if (bytes === null) return;
    seen.add(rel);
    docs.push({ path: rel, bytes, load, source });
  };

  for (const name of ALWAYS) add(name, "always", "convention");
  for (const name of ON_DEMAND) add(name, "on_demand", "convention");
  for (const dir of ON_DEMAND_DIRS) {
    for (const f of filesUnder(root, dir)) add(f, "on_demand", "convention");
  }

  const missing: string[] = [];
  const refused: string[] = [];
  for (const raw of prosePolicy(policy).targets ?? []) {
    const rel = relative(root, join(root, raw)).split(sep).join("/");
    if (rel === "" || rel.startsWith("..")) {
      refused.push(raw);
      continue;
    }
    if (!eligible(rel)) {
      refused.push(rel);
      continue;
    }
    if (seen.has(rel)) continue;
    const bytes = size(root, rel);
    if (bytes === null) {
      // A directory is legal to declare; a path that is nothing is a stale pointer.
      const inside = filesUnder(root, rel);
      if (inside.length === 0) missing.push(rel);
      for (const f of inside) add(f, "on_demand", "declared");
      continue;
    }
    // A declared file is always-loaded: the repo named it as its house style.
    add(rel, "always", "declared");
  }

  return {
    docs: docs.sort((a, b) => a.path.localeCompare(b.path)),
    missing: missing.sort(),
    refused: refused.sort(),
  };
}

/**
 * Is this path the repo's own prose? Decided from the path alone.
 *
 * The gates judge a pull request from its list of changed files, with no
 * checkout to stat, so this cannot be `scanProse`. It answers a different
 * question too: `scanProse` asks what exists to read, this asks whether a file
 * someone just edited is prose, which holds for a file they have only now
 * created.
 */
export function isProsePath(path: string, policy?: Policy | null): boolean {
  const p = path.replace(/^\.\//, "").split(sep).join("/");
  if (!eligible(p)) return false;
  if (ALWAYS.includes(p) || ON_DEMAND.includes(p)) return true;
  if (ON_DEMAND_DIRS.some((d) => p.startsWith(`${d}/`))) return true;
  for (const raw of prosePolicy(policy).targets ?? []) {
    const t = raw.replace(/^\.?\//, "").replace(/\/$/, "").split(sep).join("/");
    if (t === "") continue;
    if (p === t || p.startsWith(`${t}/`)) return true;
  }
  return false;
}

/**
 * The heading a prose hardening PR has to carry, and the instances under it.
 *
 * The other three hardening levers prove themselves: a rule fails on the bad
 * example and passes on the good one, a test goes red then green, a refactor
 * makes the wrong shape impossible to write. Prose proves nothing. You cannot
 * run a paragraph against a counter-example, so there is no way to tell a
 * practice the whole team wants from one person's passing remark except by
 * counting how often it has actually come up.
 *
 * Two is the bar. One instance is taste, and a factory that turns taste into a
 * standing instruction on every run has started overfitting to whoever
 * commented most recently — and the practice it writes is then inherited by
 * everyone who works in the repo.
 */
export const PROSE_EVIDENCE_HEADING = /^#{1,6}\s*why a practice\b/i;
export const PROSE_EVIDENCE_MINIMUM = 2;

export interface ProseEvidence {
  readonly found: boolean;
  readonly instances: number;
}

/** Count the instances a pull request body offers for writing a practice down. */
export function proseEvidence(body: string | null | undefined): ProseEvidence {
  if (typeof body !== "string" || body.trim() === "") return { found: false, instances: 0 };
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => PROSE_EVIDENCE_HEADING.test(l));
  if (start < 0) return { found: false, instances: 0 };
  let instances = 0;
  for (const line of lines.slice(start + 1)) {
    // The section runs to the next heading of any level.
    if (/^#{1,6}\s/.test(line)) break;
    if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) instances += 1;
  }
  return { found: true, instances };
}

/** The always-loaded docs, which are the ones the budget is about. */
export const alwaysLoaded = (scan: ProseScan): readonly ProseDoc[] => scan.docs.filter((d) => d.load === "always");

export interface BudgetVerdict {
  readonly ok: boolean;
  readonly over: readonly {
    readonly path: string;
    readonly bytes: number;
    /** Payload bytes on the base. 0 means the file was not there. */
    readonly before: number;
    /** Payload bytes in this checkout, carriage returns stripped. */
    readonly now: number;
    readonly budget: number;
  }[];
}

/**
 * Fail when one always-loaded file is over the cap and this change made it larger.
 *
 * scan: the files in the checkout.
 * budget: the cap in bytes of the file on disk.
 * prior: payload bytes of each file on the base commit. A missing path counts
 * as 0, so a new file is growth.
 * current: payload bytes in the checkout. A missing path uses the on-disk
 * size, which is what a test that only wrote the file is measuring.
 *
 * Per file, not in total. A total would let one file grow without limit as
 * long as another shrank. Carriage returns are stripped before the two
 * payloads are compared, so a checkout that stores the same text with
 * different line endings has not grown the file.
 */
export function budgetVerdict(
  scan: ProseScan,
  budget = DEFAULT_BUDGET_BYTES,
  prior: Readonly<Record<string, number>> = {},
  current: Readonly<Record<string, number>> = {},
): BudgetVerdict {
  const over = alwaysLoaded(scan)
    .filter((d) => {
      const before = prior[d.path] ?? 0;
      const now = current[d.path] ?? d.bytes;
      return d.bytes > budget && now > before;
    })
    .map((d) => ({
      path: d.path,
      bytes: d.bytes,
      before: prior[d.path] ?? 0,
      now: current[d.path] ?? d.bytes,
      budget,
    }));
  return { ok: over.length === 0, over };
}

/**
 * Payload bytes of a file in the checkout, with carriage returns removed.
 *
 * root: the checkout.
 * rel: a repo-relative path.
 * Returns 0 when the file is not there.
 */
export function prosePayload(root: string, rel: string): number {
  try {
    return payloadBytes(readFileSync(join(root, rel)));
  } catch {
    return 0;
  }
}

/**
 * Payload bytes of each path on the base commit.
 *
 * root: the checkout.
 * paths: repo-relative paths.
 * base: a git ref such as origin/main. When omitted, the pull request's base,
 * then origin/HEAD, then main.
 * Returns a count per path. A path missing on the base is 0. When git cannot
 * answer, every path is 0, which treats the file as new.
 */
export function proseBaseSizes(
  root: string,
  paths: readonly string[],
  base?: string,
): Readonly<Record<string, number>> {
  const rev = resolveProseBase(root, base);
  const out: Record<string, number> = {};
  for (const p of paths) out[p] = rev === null ? 0 : blobPayload(root, rev, p);
  return out;
}

/** Bytes of text, ignoring carriage returns so line endings are not growth. */
function payloadBytes(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 13) n++;
  return n;
}

/**
 * The commit this checkout branched from.
 *
 * root: the checkout.
 * base: an explicit ref. When omitted, GITHUB_BASE_REF, then origin/HEAD,
 * then main or master.
 * Returns the merge-base sha, or null when git has no such commit.
 */
function resolveProseBase(root: string, base?: string): string | null {
  const fromEnv = process.env["GITHUB_BASE_REF"];
  const requested = base !== undefined && base !== ""
    ? base
    : fromEnv !== undefined && fromEnv !== ""
      ? `origin/${fromEnv}`
      : "origin/HEAD";
  const seen = new Set<string>();
  for (const candidate of [requested, "origin/main", "main", "origin/master", "master"]) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const found = gitText(root, ["merge-base", "HEAD", candidate]);
    if (found !== null && found.trim() !== "") return found.trim();
  }
  return null;
}

/** Payload bytes of one blob. 0 when the path is not in that commit. */
function blobPayload(root: string, rev: string, rel: string): number {
  try {
    const buf = execFileSync("git", ["cat-file", "blob", `${rev}:${rel}`], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
    return payloadBytes(buf);
  } catch {
    return 0;
  }
}

/** git output, or null when the command fails. stderr is discarded. */
function gitText(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * What a role is handed: the files to read, with the always-loaded ones first,
 * and nothing else. Not the contents — a role reads those itself, so that a
 * large file costs the role that needs it rather than every role.
 */
export function renderProse(scan: ProseScan): string {
  const lines: string[] = [];
  const always = alwaysLoaded(scan);
  const demand = scan.docs.filter((d) => d.load === "on_demand");

  if (scan.docs.length === 0) {
    lines.push("This repository writes down no conventions of its own.");
    lines.push("");
    lines.push("Use `.factory/definition/context/` and the code itself. Do not invent a");
    lines.push("house style; where the codebase is consistent, follow what it does.");
    return lines.join("\n");
  }

  lines.push("# The repository's own conventions");
  lines.push("");
  lines.push("These are written and maintained by the people who own this repository, and");
  lines.push("they are the primary statement of how work here is done.");
  lines.push("");
  lines.push("Where one of them disagrees with anything the factory has recorded about this");
  lines.push("repository, **these win**. The owners keep these current; the factory's own");
  lines.push("notes are a supplement for what has no home in the codebase.");
  lines.push("");

  if (always.length > 0) {
    lines.push("Read these now, in full:");
    lines.push("");
    for (const d of always) lines.push(`- \`${d.path}\` (${d.bytes} bytes)`);
    lines.push("");
  }
  if (demand.length > 0) {
    lines.push("Read these when the work touches what they cover:");
    lines.push("");
    for (const d of demand) lines.push(`- \`${d.path}\` (${d.bytes} bytes)`);
    lines.push("");
  }
  if (scan.missing.length > 0) {
    lines.push("Declared for this repo and not in the checkout, so something has moved:");
    lines.push("");
    for (const m of scan.missing) lines.push(`- \`${m}\``);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
