import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redact, type Correction } from "./mine.js";

const exec = promisify(execFile);

/**
 * The mining sources that are already in the repository: reverts, fix commits
 * and the prose rules a team has written down (doc 05, phase 1).
 *
 * These need no consent step and no memex — they are the team's own shared
 * history, not anybody's private conversations — so they run first and work
 * even when nothing else does. On a repo that has never been touched by an
 * agent, they are the only mining that will find anything at all.
 */

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    return String(stdout);
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ reverts */

export interface RevertFinding {
  readonly commit: string;
  readonly subject: string;
  readonly reverted: string | null;
  readonly at: string;
  readonly files: readonly string[];
}

/**
 * Every revert, and what it reverted.
 *
 * A revert is the strongest correction a repository records: somebody decided
 * the change should not have landed. `git revert` writes "This reverts commit
 * <sha>" into the message, which is what makes the pair recoverable.
 */
export async function findReverts(root: string, days = 365): Promise<readonly RevertFinding[]> {
  const log = await git(root, [
    "log",
    `--since=${days} days ago`,
    "--format=%H%x1f%s%x1f%aI%x1f%b%x1e",
  ]);
  if (log === "") return [];

  const out: RevertFinding[] = [];
  for (const entry of log.split("\u001e")) {
    const parts = entry.replace(/^\n/, "").split("\u001f");
    if (parts.length < 3) continue;
    const [sha, subject, at, body] = parts as [string, string, string, string?];
    if (!/^revert\b|^revert:/i.test(subject) && !/\bthis reverts commit\b/i.test(body ?? "")) continue;

    const reverted = /this reverts commit ([0-9a-f]{7,40})/i.exec(body ?? "")?.[1] ?? null;
    const files = (await git(root, ["show", "--name-only", "--format=", sha]))
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    out.push({ commit: sha, subject: redact(subject), reverted, at, files });
  }
  return out;
}

/* -------------------------------------------------------------- fix commits */

export interface FixFinding {
  readonly commit: string;
  readonly subject: string;
  readonly at: string;
  readonly files: readonly string[];
  /** The commit whose code this fix touched, within the window. */
  readonly fixes: readonly string[];
}

const FIX_SUBJECT = /^(fix|hotfix|bugfix|patch)\b|^fix[(:]|\bregression\b/i;

/**
 * A fix touching code that changed in the previous fourteen days.
 *
 * The window is what makes this a signal rather than a list of every bug fix
 * ever made: a fix to code written a year ago is maintenance, while a fix to
 * code written last week is something that got through review and should not
 * have.
 */
export async function findFixCommits(root: string, days = 180, window = 14): Promise<readonly FixFinding[]> {
  const log = await git(root, ["log", `--since=${days} days ago`, "--format=%H%x1f%s%x1f%aI"]);
  if (log === "") return [];

  const commits = log
    .split("\n")
    .map((l) => l.split("\u001f"))
    .filter((p): p is [string, string, string] => p.length === 3);

  const out: FixFinding[] = [];
  for (const [sha, subject, at] of commits) {
    if (!FIX_SUBJECT.test(subject)) continue;
    const files = (await git(root, ["show", "--name-only", "--format=", sha]))
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    if (files.length === 0) continue;

    // Which commits last touched these files before this one, and how recently.
    const fixes = new Set<string>();
    for (const file of files.slice(0, 20)) {
      const before = await git(root, [
        "log",
        "-2",
        "--format=%H%x1f%aI",
        `${sha}^`,
        "--",
        file,
      ]);
      for (const line of before.split("\n")) {
        const [other, otherAt] = line.split("\u001f");
        if (other === undefined || otherAt === undefined) continue;
        const gap = (Date.parse(at) - Date.parse(otherAt)) / 86_400_000;
        if (gap >= 0 && gap <= window) fixes.add(other);
      }
    }
    if (fixes.size === 0) continue;
    out.push({ commit: sha, subject: redact(subject), at, files, fixes: [...fixes] });
  }
  return out;
}

/* -------------------------------------------------------------- prose rules */

export interface ProseRule {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** The files teams put their conventions in. */
export const PROSE_FILES: readonly string[] = [
  "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "CONVENTIONS.md", "STYLE.md",
  "docs/style.md", "docs/conventions.md", "docs/CONTRIBUTING.md", ".cursorrules",
];

/** A sentence that states a rule rather than describing something. */
const RULE_SHAPE = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bmust( not)?\b/i,
  /\bdo not\b|\bdon'?t\b/i,
  // Loose between the verb and the comparison, because real prose puts a
  // phrase there: "prefer the existing helper over a new one".
  /\buse\b.{0,40}?\binstead of\b/i,
  /\bprefer\b.{0,40}?\b(over|to|instead of)\b/i,
  /\bavoid\b/i,
  /\brequired\b.*\bbefore\b/i,
];

/**
 * Rule-like sentences from the repo's own documents.
 *
 * Generated blocks are skipped: `next dev` and other tools maintain regions in
 * `AGENTS.md` marked with `BEGIN:`/`END:` comments, and mining those would
 * file a framework's instructions as the team's conventions (doc 05).
 */
export function findProseRules(root: string, files: readonly string[] = PROSE_FILES): readonly ProseRule[] {
  const out: ProseRule[] = [];
  for (const rel of files) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    let text: string;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue;
    }

    for (const block of readableBlocks(text)) {
      for (const sentence of sentences(block.text)) {
        if (sentence.length < 12 || sentence.length > 300) continue;
        if (!RULE_SHAPE.some((re) => re.test(sentence))) continue;
        out.push({ file: rel, line: block.line, text: redact(sentence) });
      }
    }
  }
  return out;
}


interface Block {
  readonly line: number;
  readonly text: string;
}

/**
 * The prose worth reading, as blocks rather than lines.
 *
 * Markdown wraps sentences across lines, so a line-by-line scan yields
 * fragments like "pushes, weekly schedules, or manual main-branch runs, never
 * on PRs. CLI," — which is not a rule anybody can act on. Lines within a
 * paragraph or a list item are rejoined first.
 *
 * Headings are skipped even when they contain a rule word: "Critical Rules
 * (Always Applicable)" is a section title, not an instruction.
 */
export function readableBlocks(text: string): readonly Block[] {
  const out: Block[] = [];
  let buffer: string[] = [];
  let bufferLine = 0;
  let generated = false;
  let fence = false;

  const flush = (): void => {
    if (buffer.length > 0) {
      out.push({ line: bufferLine, text: buffer.join(" ").replace(/\s+/g, " ").trim() });
      buffer = [];
    }
  };

  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();

    if (/<!--\s*BEGIN[:_ ]/i.test(line) || /^#\s*BEGIN[:_ ]/i.test(line)) {
      flush();
      generated = true;
      continue;
    }
    if (/<!--\s*END[:_ ]/i.test(line) || /^#\s*END[:_ ]/i.test(line)) {
      generated = false;
      continue;
    }
    if (generated) continue;

    // Code blocks are examples, not rules.
    if (line.startsWith("```") || line.startsWith("~~~")) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;

    // A blank line, a heading or a table row ends the block.
    if (line === "" || /^#{1,6}\s/.test(line) || line.startsWith("|") || /^[-=]{3,}$/.test(line)) {
      flush();
      continue;
    }

    // A new list item or quote starts its own block.
    if (/^([-*+]\s+|\d+\.\s+|>\s*)/.test(line)) {
      flush();
      bufferLine = i + 1;
      buffer.push(line.replace(/^([-*+]\s+|\d+\.\s+|>\s*)/, ""));
      continue;
    }

    if (buffer.length === 0) bufferLine = i + 1;
    buffer.push(line);
  }
  flush();
  return out;
}

/** Split a block into sentences, keeping abbreviations and code spans whole. */
export function sentences(block: string): readonly string[] {
  return block
    // Only split on a full stop followed by a space and a capital, which
    // leaves "e.g." and "`next dev`." alone.
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/* ------------------------------------------------------------- as corrections */

export interface RepoMining {
  readonly reverts: readonly RevertFinding[];
  readonly fixes: readonly FixFinding[];
  readonly prose: readonly ProseRule[];
  readonly asCorrections: readonly Correction[];
}

/**
 * Everything the repository itself records, expressed in the same shape as a
 * mined session correction so one clustering pass covers all six sources.
 */
export async function mineRepo(root: string, days = 365): Promise<RepoMining> {
  const [reverts, fixes] = await Promise.all([findReverts(root, days), findFixCommits(root)]);
  const prose = findProseRules(root);

  const asCorrections: Correction[] = [
    ...reverts.map((r) => ({
      text: r.subject,
      source: "revert",
      session: r.commit.slice(0, 8),
      at: r.at,
      // A revert is a decision already taken, so it needs no classifier.
      confidence: 0.9,
      signals: ["revert"],
    })),
    // The subject alone, with no boilerplate prefix: the prefix's own words
    // are shared by every fix, so prefixing them clustered all 44 fixes in
    // gh-aw into one meaningless group.
    ...fixes.map((f) => ({
      text: f.subject,
      source: "fix_commit",
      session: f.commit.slice(0, 8),
      at: f.at,
      confidence: 0.6,
      signals: ["fix_within_window"],
    })),
    ...prose.map((p) => ({
      text: p.text,
      source: "prose_rule",
      session: `${p.file}:${p.line}`,
      at: null,
      // Someone wrote it down deliberately; it is a rule by construction.
      confidence: 0.8,
      signals: ["written_rule"],
    })),
  ];

  return { reverts, fixes, prose, asCorrections };
}
