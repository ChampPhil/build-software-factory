import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Cross-artifact consistency — the twelfth analysis kind (doc 01).
 *
 * Every other kind reads one artifact: a file's text, its syntax tree, its
 * types, the import graph. This one compares two artifacts that are supposed
 * to agree and do not — and that is a class of bug no linter catches, because
 * each file is individually fine.
 *
 * The checks here were chosen because each one has bitten a real repository
 * and each is decidable without running anything:
 *
 * - a variable the code reads from the environment that the example file does
 *   not mention, so a new checkout starts and fails at runtime;
 * - a command the README tells people to run that the manifest does not
 *   define, so the documented first step does not work;
 * - a dependency the manifest declares that the lockfile does not carry, so
 *   an install reproduces something other than what was reviewed.
 *
 * Each finding names both artifacts, because a mismatch is never a fault in
 * one of them alone and the fix depends on which one is right.
 */

export interface ConsistencyFinding {
  readonly check:
    | "env_undocumented"
    | "env_unused"
    | "env_no_example"
    | "documented_script_missing"
    | "dependency_unlocked";
  /** The two files that disagree. */
  readonly between: readonly [string, string];
  readonly detail: string;
}

export interface ConsistencyInput {
  readonly root: string;
  /** Source files to scan, repo-relative. */
  readonly files: readonly string[];
  readonly read?: (path: string) => string;
}

/** Variables read from the environment, with where each was read. */
export function envVarsUsed(source: string): readonly string[] {
  const found = new Set<string>();
  const patterns = [
    // process.env.NAME / process.env["NAME"]
    /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
    /process\.env\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\]/g,
    // os.environ["NAME"] / os.getenv("NAME") / os.environ.get("NAME")
    /os\.environ(?:\.get)?\[?\s*\(?\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
    /os\.getenv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
    // os.Getenv("NAME") in Go
    /os\.Getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
    // ${{ secrets.NAME }} and ${{ vars.NAME }} in workflows
    /\$\{\{\s*(?:secrets|vars)\.([A-Z][A-Z0-9_]{2,})\s*\}\}/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) {
      const name = m[1];
      if (name !== undefined) found.add(name);
    }
  }
  return [...found].sort();
}

/** Names declared in a dotenv-style file, values ignored. */
export function envVarsDeclared(text: string): readonly string[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

/** Commands a README tells people to run, from its fenced shell blocks. */
export function documentedScripts(markdown: string, runner: "npm" | "yarn" | "pnpm" = "npm"): readonly string[] {
  const scripts = new Set<string>();
  // Only inside fenced blocks: prose mentioning `npm run build` in a sentence
  // is not an instruction to run it, and treating it as one produced noise.
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    const body = block[1] ?? "";
    for (const m of body.matchAll(new RegExp(`\\b${runner}\\s+run\\s+([a-z0-9:_-]+)`, "g"))) {
      const name = m[1];
      if (name !== undefined) scripts.add(name);
    }
  }
  return [...scripts].sort();
}

const IGNORED_ENV = new Set([
  // Set by the platform, never written down by a project.
  "NODE_ENV", "CI", "HOME", "PATH", "PWD", "USER", "SHELL", "TZ", "LANG", "TERM",
  "PORT", "HOSTNAME", "DEBUG", "NODE_OPTIONS", "GITHUB_TOKEN", "GITHUB_OUTPUT",
  "GITHUB_ENV", "GITHUB_REPOSITORY", "GITHUB_SHA", "GITHUB_REF", "GITHUB_ACTOR",
  "GITHUB_EVENT_NAME", "GITHUB_WORKSPACE", "RUNNER_OS", "RUNNER_TEMP",
]);

export function checkConsistency(input: ConsistencyInput): readonly ConsistencyFinding[] {
  const read = input.read ?? ((p: string) => readFileSync(join(input.root, p), "utf8"));
  const exists = (p: string): boolean =>
    input.read === undefined ? existsSync(join(input.root, p)) : safe(() => input.read?.(p)) !== null;

  const findings: ConsistencyFinding[] = [];

  /* ------------------------------------ environment variables vs the example */

  const exampleFile = [".env.example", ".env.sample", ".env.template"].find(exists);

  const usedIn = new Map<string, string>();
  for (const file of input.files) {
    const text = safe(() => read(file));
    if (text === null) continue;
    for (const name of envVarsUsed(text)) {
      if (!usedIn.has(name) && !IGNORED_ENV.has(name)) usedIn.set(name, file);
    }
  }

  if (exampleFile === undefined) {
    // The commonest form of this inconsistency by far: a repo whose code
    // needs a dozen variables and whose checkout documents none of them.
    // Reported once rather than per variable — it is one missing file.
    const MIN_TO_REPORT = 3;
    if (usedIn.size >= MIN_TO_REPORT) {
      const names = [...usedIn.keys()].sort();
      findings.push({
        check: "env_no_example",
        // Repo-level, so naming one arbitrary source file would mislead.
        between: ["the source files scanned", ".env.example"],
        detail:
          `${usedIn.size} environment variable(s) are read and there is no .env.example to name them: ` +
          `${names.slice(0, 8).join(", ")}${names.length > 8 ? `, and ${names.length - 8} more` : ""}. ` +
          `A fresh checkout has no way to know what it needs.`,
      });
    }
  }

  if (exampleFile !== undefined) {
    const declared = new Set(envVarsDeclared(read(exampleFile)));

    for (const [name, where] of usedIn) {
      if (declared.has(name)) continue;
      findings.push({
        check: "env_undocumented",
        between: [where, exampleFile],
        detail:
          `${where} reads ${name} from the environment, and ${exampleFile} does not mention it, ` +
          `so a fresh checkout starts without it`,
      });
    }

    for (const name of declared) {
      if (usedIn.has(name) || IGNORED_ENV.has(name)) continue;
      findings.push({
        check: "env_unused",
        between: [exampleFile, "the source files scanned"],
        detail:
          `${exampleFile} asks for ${name}, which nothing scanned reads — either it is dead, ` +
          `or it is read somewhere this scan did not look`,
      });
    }
  }

  /* --------------------------------------- documented commands vs the manifest */

  const readme = ["README.md", "readme.md", "Readme.md"].find(exists);
  const manifest = exists("package.json") ? "package.json" : null;
  if (readme !== undefined && manifest !== null) {
    const pkg = safeJson(() => read(manifest)) as { scripts?: Record<string, unknown> } | null;
    // A manifest that does not parse tells us nothing about what it defines.
    // Treating it as empty would report every documented command as missing,
    // which is a confident claim built on a file we could not read.
    const scripts = pkg === null ? null : new Set(Object.keys(pkg.scripts ?? {}));
    for (const name of scripts === null ? [] : documentedScripts(read(readme))) {
      if (scripts?.has(name) === true) continue;
      findings.push({
        check: "documented_script_missing",
        between: [readme, manifest],
        detail: `${readme} says to run \`npm run ${name}\`, which ${manifest} does not define`,
      });
    }
  }

  /* --------------------------------------------- manifest vs the lockfile */

  if (manifest !== null && exists("package-lock.json")) {
    const pkg = safeJson(() => read(manifest)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } | null;
    const lock = safeJson(() => read("package-lock.json")) as {
      packages?: Record<string, unknown>;
    } | null;

    if (pkg !== null && lock?.packages !== undefined) {
      const locked = new Set(
        Object.keys(lock.packages)
          .filter((k) => k.startsWith("node_modules/"))
          .map((k) => k.slice("node_modules/".length)),
      );
      const declared = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const name of Object.keys(declared)) {
        if (locked.has(name)) continue;
        findings.push({
          check: "dependency_unlocked",
          between: [manifest, "package-lock.json"],
          detail:
            `${manifest} declares ${name}, which package-lock.json does not carry, so an install ` +
            `resolves it fresh rather than reproducing what was reviewed`,
        });
      }
    }
  }

  return findings;
}

function safe<T>(fn: () => T): T | null {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

function safeJson(fn: () => string): unknown {
  const text = safe(fn);
  if (text === null) return null;
  return safe(() => JSON.parse(text));
}

/** For the CLI: a repo-relative path, for a finding's message. */
export function rel(root: string, path: string): string {
  return relative(root, path) || path;
}
