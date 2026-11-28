/**
 * The configuration names a repository's code reads.
 *
 * Purpose:
 *     Before any factory job spends a model run, the factory has to know
 *     whether the person has decided every setting the app reads. This file
 *     finds those names by reading the source the same way every time. It
 *     does not start the app, and it does not read secret values.
 *
 * Key terms:
 *     - Configuration name: a setting the code looks up by a fixed name,
 *       such as process.env.DATABASE_URL or os.environ["CLERK_SECRET_KEY"].
 *     - Decision: what the person already chose for a name. A name present
 *       as a key in FACTORY_SANDBOX_ENV is "use it". A name listed under
 *       fake or ignore in .factory/env-decisions.json was marked on the
 *       screen.
 *     - Built-in skip: machine names such as PATH and HOME, plus the
 *       factory's own names. The list is a start. A name it misses is
 *       cleared when the person chooses "ignore this key".
 *     - Dynamic read: the code looks up a name computed while the program
 *       runs. The file is reported. It does not pause the factory, because
 *       pausing would stop every repo that loads config in a loop.
 *
 * Exports:
 *     - scanConfigNames: the names, where each was found, and dynamic files.
 *     - readEnvDecisions: the fake and ignore lists from the decisions file.
 *     - undecidedNames: names with no use, fake, or ignore decision yet.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next",
  ".factory", "coverage", "__pycache__", ".venv", "venv",
]);

const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".php"]);

/** Names that are the machine or the factory, not the app's settings. */
const BUILTIN_SKIP = new Set([
  "PATH", "HOME", "CI", "NODE_ENV", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "TMP", "TEMP", "TMPDIR", "PWD", "SHELL", "TERM", "LANG", "LC_ALL",
  "ANTHROPIC_API_KEY", "FACTORY_SANDBOX_ENV", "FACTORY_APP_PRIVATE_KEY",
]);

const LITERAL = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
  /os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /ENV(?:\.fetch)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /os\.Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
  /System\.getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g,
];

const DYNAMIC = [
  /process\.env\s*\[(?!['"])/,
  /os\.environ(?:\.get)?\(\s*(?!['"])/,
  /os\.environ\[\s*(?!['"])/,
];

const EXAMPLE = new Set([".env.example", ".env.sample", ".env.template"]);

export interface ConfigNameScan {
  /** Name to the first file:line that reads it. */
  readonly names: ReadonlyMap<string, string>;
  /** Files that read a computed name. These do not pause the factory. */
  readonly dynamic: readonly string[];
  readonly filesRead: number;
}

export interface EnvDecisions {
  readonly fake: readonly string[];
  readonly ignore: readonly string[];
}

/**
 * Walk the repo and collect configuration names.
 *
 * root: the repository root. Dependencies, git data, build output, and
 * .factory are not read.
 * Returns the literal names, where each was first seen, and files with a
 * computed lookup.
 */
export function scanConfigNames(root: string): ConfigNameScan {
  const names = new Map<string, string>();
  const dynamic: string[] = [];
  let filesRead = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (name.startsWith(".")) continue;
        walk(p, depth + 1);
        continue;
      }
      if (s.size > 1_000_000) continue;
      const rel = relative(root, p).replace(/\\/g, "/");
      if (EXAMPLE.has(name) || CODE_EXT.has(extname(name).toLowerCase())) {
        filesRead += 1;
        readOne(p, rel, names, dynamic);
      }
    }
  };
  walk(root, 0);
  return { names, dynamic, filesRead };
}

/**
 * Read one source file for literal configuration names.
 *
 * path: absolute path of the file.
 * rel: path relative to the repo, using forward slashes.
 * names: map filled with the first place each name was seen.
 * dynamic: list filled when the file looks up a computed name.
 */
function readOne(path: string, rel: string, names: Map<string, string>, dynamic: string[]): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (EXAMPLE.has(base)) {
    text.split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m?.[1] !== undefined && !line.trim().startsWith("#") && !names.has(m[1])) names.set(m[1], `${rel}:${i + 1}`);
    });
    return;
  }
  if (DYNAMIC.some((r) => r.test(text))) dynamic.push(rel);
  text.split(/\r?\n/).forEach((line, i) => {
    for (const re of LITERAL) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const found = m[1];
        if (found !== undefined && !names.has(found)) names.set(found, `${rel}:${i + 1}`);
      }
    }
  });
}

/**
 * Load the screen's saved choices.
 *
 * root: the repository root. A missing or unreadable file means nothing has
 * been marked fake or ignored yet.
 * Returns the two lists.
 */
export function readEnvDecisions(root: string): EnvDecisions {
  const path = join(root, ".factory", "env-decisions.json");
  if (!existsSync(path)) return { fake: [], ignore: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { fake?: unknown; ignore?: unknown };
    const list = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return { fake: list(raw.fake), ignore: list(raw.ignore) };
  } catch {
    return { fake: [], ignore: [] };
  }
}

/**
 * Names the code reads that the person has not decided.
 *
 * scan: the result of scanConfigNames.
 * decided: names already in FACTORY_SANDBOX_ENV, plus fake and ignore.
 * Returns the undecided names in alphabetical order, each with where it was found.
 */
export function undecidedNames(scan: ConfigNameScan, decided: ReadonlySet<string>): readonly { name: string; where: string }[] {
  const out: { name: string; where: string }[] = [];
  for (const [name, where] of scan.names) {
    if (BUILTIN_SKIP.has(name) || name.startsWith("GITHUB_") || name.startsWith("RUNNER_") || name.startsWith("FACTORY_") || name.startsWith("GH_AW_")) continue;
    if (decided.has(name)) continue;
    out.push({ name, where });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
