import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { RuleCounts } from "../commands/gates.js";

const exec = promisify(execFile);

/**
 * Running the repo's own tools and reading their output.
 *
 * The gates never ask an agent whether the checks passed; they run the tools
 * themselves and parse the results. Counts come out **per rule per file**,
 * because that is what the ratchet compares: a fix in one file must not pay
 * for a new violation in another.
 */

export interface ToolRunResult {
  readonly tool: string;
  readonly counts: RuleCounts;
  /** Every violation, for the check-run output a reviewer reads. */
  readonly findings: readonly Finding[];
  /** True when the tool could not run at all, as opposed to finding nothing. */
  readonly unavailable: boolean;
  readonly detail: string;
}

export interface Finding {
  readonly rule: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
  readonly severity: "error" | "warning";
}

function addCount(counts: Record<string, Record<string, number>>, rule: string, file: string): void {
  const byFile = (counts[rule] ??= {});
  byFile[file] = (byFile[file] ?? 0) + 1;
}

/** Tool output carries absolute paths; the ratchet keys on repo-relative ones. */
function rel(root: string, file: string): string {
  const p = isAbsolute(file) ? relative(root, file) : file;
  return p.split("\\").join("/");
}

/* ------------------------------------------------------------------- eslint */

interface EslintFileResult {
  filePath: string;
  messages: {
    ruleId: string | null;
    severity: number;
    message: string;
    line?: number;
    suppressions?: { kind: string; justification?: string }[];
  }[];
  suppressedMessages?: {
    ruleId: string | null;
    message: string;
    line?: number;
    suppressions?: { kind: string; justification?: string }[];
  }[];
}

export async function runEslint(root: string, paths: readonly string[] = ["."]): Promise<ToolRunResult> {
  const bin = join(root, "node_modules", "eslint", "bin", "eslint.js");
  if (!existsSync(bin)) {
    return { tool: "eslint", counts: {}, findings: [], unavailable: true, detail: "eslint is not installed" };
  }

  let stdout: string;
  try {
    const res = await exec(
      process.execPath,
      [bin, ...paths, "--format", "json"],
      { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    );
    stdout = String(res.stdout);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    // eslint exits 1 when it finds problems, which is the ordinary case.
    if (typeof e.stdout === "string" && e.stdout.trim().startsWith("[")) {
      stdout = e.stdout;
    } else {
      return {
        tool: "eslint", counts: {}, findings: [], unavailable: true,
        detail: (e.stderr ?? e.message ?? "eslint failed").toString().slice(0, 4000),
      };
    }
  }

  const results = JSON.parse(stdout) as EslintFileResult[];
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];

  for (const file of results) {
    const path = rel(root, file.filePath);
    for (const m of file.messages) {
      if (m.ruleId === null) continue; // a parse error, reported separately
      addCount(counts, m.ruleId, path);
      findings.push({
        rule: m.ruleId,
        file: path,
        ...(m.line === undefined ? {} : { line: m.line }),
        message: m.message,
        severity: m.severity >= 2 ? "error" : "warning",
      });
    }
  }
  return { tool: "eslint", counts, findings, unavailable: false, detail: "" };
}

/**
 * Suppressions eslint applied, from its own baseline file or from inline
 * comments. The gates count these: a suppression added without a reason is a
 * weakening, and the total is capped.
 */
export function eslintSuppressions(root: string): Readonly<Record<string, number>> {
  const file = join(root, "eslint-suppressions.json");
  if (!existsSync(file)) return {};
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, { count: number }>>;
    const out: Record<string, number> = {};
    for (const [path, rules] of Object.entries(doc)) {
      for (const [rule, entry] of Object.entries(rules)) {
        const key = `eslint:${rule}`;
        out[key] = (out[key] ?? 0) + (entry?.count ?? 0);
        void path;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/* --------------------------------------------------------------------- ruff */

interface RuffFinding {
  code: string | null;
  message: string;
  filename: string;
  location?: { row?: number };
}

export async function runRuff(root: string, paths: readonly string[] = ["."]): Promise<ToolRunResult> {
  let stdout: string;
  try {
    const res = await exec("ruff", ["check", "--no-cache", "--output-format", "json", ...paths], {
      cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    });
    stdout = String(res.stdout);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    if (typeof e.stdout === "string" && e.stdout.trim().startsWith("[")) {
      stdout = e.stdout;
    } else {
      return {
        tool: "ruff", counts: {}, findings: [], unavailable: true,
        detail: (e.stderr ?? e.message ?? "ruff failed").toString().slice(0, 4000),
      };
    }
  }

  const hits = JSON.parse(stdout) as RuffFinding[];
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];
  for (const h of hits) {
    const rule = h.code ?? "ruff";
    const path = rel(root, h.filename);
    addCount(counts, rule, path);
    findings.push({
      rule, file: path,
      ...(h.location?.row === undefined ? {} : { line: h.location.row }),
      message: h.message, severity: "error",
    });
  }
  return { tool: "ruff", counts, findings, unavailable: false, detail: "" };
}

/* ------------------------------------------------- more languages' linters */

/**
 * Runs a tool and returns its stdout even when it exits non-zero, which most
 * linters do when they find something. `null` means it could not run at all.
 */
async function capture(
  cmd: string,
  args: readonly string[],
  root: string,
  looksValid: (stdout: string) => boolean,
): Promise<{ stdout: string } | { unavailable: string }> {
  try {
    const res = await exec(cmd, [...args], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return { stdout: String(res.stdout) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (typeof e.stdout === "string" && looksValid(e.stdout)) return { stdout: e.stdout };
    // `||`, not `??`: a tool that is not installed has an empty stderr.
    return { unavailable: (e.stderr || e.message || `${cmd} failed`).toString().slice(0, 4000) };
  }
}

/** clippy, for Rust: one JSON message per line from cargo. */
export async function runClippy(root: string): Promise<ToolRunResult> {
  const r = await capture("cargo", ["clippy", "--quiet", "--message-format=json", "--", "-W", "clippy::all"], root,
    (o) => o.includes('"reason"'));
  if ("unavailable" in r) return { tool: "clippy", counts: {}, findings: [], unavailable: true, detail: r.unavailable };
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let msg: { reason?: string; message?: { code?: { code?: string } | null; message?: string; level?: string; spans?: { file_name?: string; line_start?: number; is_primary?: boolean }[] } };
    try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
    if (msg.reason !== "compiler-message" || msg.message?.level === "note") continue;
    const span = msg.message?.spans?.find((s) => s.is_primary === true) ?? msg.message?.spans?.[0];
    if (span?.file_name === undefined) continue;
    const rule = msg.message?.code?.code ?? "rustc";
    const file = rel(root, span.file_name);
    addCount(counts, rule, file);
    findings.push({ rule, file, ...(span.line_start === undefined ? {} : { line: span.line_start }), message: msg.message?.message ?? "", severity: "error" });
  }
  return { tool: "clippy", counts, findings, unavailable: false, detail: "" };
}

/** go vet: `file:line:col: message`, keyed by analyzer where it says one. */
export async function runGoVet(root: string): Promise<ToolRunResult> {
  let out: string;
  try {
    const res = await exec("go", ["vet", "./..."], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    out = `${String(res.stdout)}\n${String(res.stderr)}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: unknown };
    const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    // go vet exits 1 with findings on stderr; anything else is a failure to run.
    if (!/\.go:\d+:\d+: /.test(text)) {
      return { tool: "go-vet", counts: {}, findings: [], unavailable: true, detail: (e.stderr ?? e.message ?? "go vet failed").toString().slice(0, 4000) };
    }
    out = text;
  }
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];
  for (const line of out.split("\n")) {
    const m = /^(?:vet: )?([^:\s][^:]*\.go):(\d+):\d+: (.*)$/.exec(line.trim());
    if (m?.[1] === undefined) continue;
    // go vet prints `./pkg/file.go`; the other tools print `pkg/file.go`, and
    // the baselines are keyed by path, so they must agree.
    const file = rel(root, m[1].replace(/^\.\//, ""));
    const rule = "go-vet";
    addCount(counts, rule, file);
    findings.push({ rule, file, line: Number(m[2]), message: m[3] ?? "", severity: "error" });
  }
  return { tool: "go-vet", counts, findings, unavailable: false, detail: "" };
}

/** RuboCop, for Ruby. */
export async function runRubocop(root: string): Promise<ToolRunResult> {
  const r = await capture("rubocop", ["--format", "json", "--force-exclusion"], root, (o) => o.trim().startsWith("{"));
  if ("unavailable" in r) return { tool: "rubocop", counts: {}, findings: [], unavailable: true, detail: r.unavailable };
  const doc = JSON.parse(r.stdout) as { files?: { path?: string; offenses?: { cop_name?: string; message?: string; location?: { line?: number } }[] }[] };
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];
  for (const f of doc.files ?? []) {
    for (const o of f.offenses ?? []) {
      const rule = o.cop_name ?? "rubocop";
      const file = rel(root, f.path ?? "");
      addCount(counts, rule, file);
      findings.push({ rule, file, ...(o.location?.line === undefined ? {} : { line: o.location.line }), message: o.message ?? "", severity: "error" });
    }
  }
  return { tool: "rubocop", counts, findings, unavailable: false, detail: "" };
}

/**
 * semgrep, over the repo's own guardrail rules. Language-independent, which
 * is what makes it the place a declared practice becomes a checked rule for
 * any codebase, whatever linter it does or does not use.
 */
export async function runSemgrep(root: string, configDir: string): Promise<ToolRunResult> {
  const r = await capture("semgrep", ["--config", configDir, "--json", "--quiet", "--metrics=off", "."], root,
    (o) => o.trim().startsWith("{"));
  if ("unavailable" in r) return { tool: "semgrep", counts: {}, findings: [], unavailable: true, detail: r.unavailable };
  const doc = JSON.parse(r.stdout) as { results?: { check_id?: string; path?: string; start?: { line?: number }; extra?: { message?: string } }[] };
  const counts: Record<string, Record<string, number>> = {};
  const findings: Finding[] = [];
  for (const h of doc.results ?? []) {
    const rule = (h.check_id ?? "semgrep").split(".").pop() ?? "semgrep";
    const file = rel(root, h.path ?? "");
    addCount(counts, rule, file);
    findings.push({ rule, file, ...(h.start?.line === undefined ? {} : { line: h.start.line }), message: h.extra?.message ?? "", severity: "error" });
  }
  return { tool: "semgrep", counts, findings, unavailable: false, detail: "" };
}

/* ----------------------------------------------------------------- coverage */

export interface CoverageNumbers {
  readonly total_pct: number;
  /** Per-file line coverage, so diff coverage can be worked out for changed files. */
  readonly by_file: Readonly<Record<string, { covered: number; total: number }>>;
}

/**
 * Reads whatever coverage report the repo already produces. Preferring the
 * repo's own output over re-instrumenting means the number the gate uses is
 * the number the team sees.
 */
export function readCoverage(root: string): CoverageNumbers | null {
  const summary = join(root, "coverage", "coverage-summary.json");
  if (existsSync(summary)) return fromIstanbulSummary(root, summary);
  const lcov = join(root, "coverage", "lcov.info");
  if (existsSync(lcov)) return fromLcov(root, lcov);
  const py = join(root, "coverage.xml");
  if (existsSync(py)) return fromCoberturaish(root, py);
  return null;
}

function fromIstanbulSummary(root: string, file: string): CoverageNumbers | null {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      { lines?: { pct?: number; covered?: number; total?: number } }
    >;
    const byFile: Record<string, { covered: number; total: number }> = {};
    for (const [key, entry] of Object.entries(doc)) {
      if (key === "total") continue;
      const lines = entry.lines ?? {};
      byFile[rel(root, key)] = { covered: lines.covered ?? 0, total: lines.total ?? 0 };
    }
    const total = doc["total"]?.lines?.pct;
    return { total_pct: typeof total === "number" ? total : overall(byFile), by_file: byFile };
  } catch {
    return null;
  }
}

function fromLcov(root: string, file: string): CoverageNumbers | null {
  try {
    const text = readFileSync(file, "utf8");
    const byFile: Record<string, { covered: number; total: number }> = {};
    let current: string | null = null;
    let found = 0;
    let hit = 0;
    for (const line of text.split("\n")) {
      if (line.startsWith("SF:")) {
        current = rel(root, line.slice(3).trim());
        found = 0;
        hit = 0;
      } else if (line.startsWith("LF:")) {
        found = Number(line.slice(3));
      } else if (line.startsWith("LH:")) {
        hit = Number(line.slice(3));
      } else if (line.startsWith("end_of_record") && current !== null) {
        byFile[current] = { covered: hit, total: found };
        current = null;
      }
    }
    return { total_pct: overall(byFile), by_file: byFile };
  } catch {
    return null;
  }
}

function fromCoberturaish(root: string, file: string): CoverageNumbers | null {
  try {
    const text = readFileSync(file, "utf8");
    const byFile: Record<string, { covered: number; total: number }> = {};
    // Deliberately a small regex read rather than an XML dependency: all that
    // is needed is each class's filename and its line hits.
    const classRe = /<class[^>]*filename="([^"]+)"[\s\S]*?<\/class>/g;
    for (const m of text.matchAll(classRe)) {
      const path = rel(root, m[1] ?? "");
      const block = m[0];
      let covered = 0;
      let total = 0;
      for (const line of block.matchAll(/<line[^>]*hits="(\d+)"[^>]*\/>/g)) {
        total++;
        if (Number(line[1]) > 0) covered++;
      }
      byFile[path] = { covered, total };
    }
    if (Object.keys(byFile).length === 0) return null;
    return { total_pct: overall(byFile), by_file: byFile };
  } catch {
    return null;
  }
}

function overall(byFile: Readonly<Record<string, { covered: number; total: number }>>): number {
  let covered = 0;
  let total = 0;
  for (const v of Object.values(byFile)) {
    covered += v.covered;
    total += v.total;
  }
  if (total === 0) return 0;
  return Math.round((covered / total) * 1000) / 10;
}

/**
 * Coverage of the changed files only — the main check, because a repo with a
 * low total can still require new code to be covered.
 */
export function diffCoverage(
  coverage: CoverageNumbers,
  changedFiles: readonly string[],
): number | null {
  let covered = 0;
  let total = 0;
  for (const file of changedFiles) {
    const entry = coverage.by_file[file];
    if (entry === undefined) continue;
    covered += entry.covered;
    total += entry.total;
  }
  // No changed file appears in the report: there is nothing to measure, which
  // is different from measuring zero.
  if (total === 0) return null;
  return Math.round((covered / total) * 1000) / 10;
}

/** Skipped tests, counted so the cap can be enforced. */
export async function countSkips(root: string): Promise<number> {
  const patterns = [
    /\b(?:it|test|describe)\.skip\s*\(/g,
    /\b(?:it|test|describe)\.todo\s*\(/g,
    /@pytest\.mark\.skip/g,
    /\bt\.Skip\s*\(/g,
  ];
  let count = 0;
  const files = await listSourceFiles(root);
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const re of patterns) count += [...text.matchAll(re)].length;
  }
  return count;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv",
  "__pycache__", ".next", "coverage", ".bsf-rule-check",
]);

async function listSourceFiles(root: string): Promise<string[]> {
  const { readdirSync } = await import("node:fs");
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go)$/.test(e.name)) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}
