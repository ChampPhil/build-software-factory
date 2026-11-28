/**
 * The configuration names a repository's code reads.
 *
 * Purpose:
 *     Before a factory job spends a model run, something has to list every
 *     setting the app looks up. This file does that by reading the source
 *     the same way every time. It does not start the app, and it does not
 *     read secret values. Running it again on the same files produces the
 *     same list.
 *
 * Key terms:
 *     - Configuration name: a setting the code looks up by a fixed name,
 *       such as process.env.DATABASE_URL or os.environ["CLERK_SECRET_KEY"].
 *     - Env example: a file such as .env.example. Its names are settings
 *       even when no source line reads them yet.
 *     - Built-in skip: PATH, HOME, CI, NODE_ENV, and the factory's own
 *       names. This is a starting list, not a complete one. A machine name
 *       it does not know, such as USER or TMPDIR, is left for the person
 *       to clear with "ignore this key".
 *     - Dynamic read: the code looks up a name that is computed while the
 *       program runs. The file is reported as unknown. It does not pause
 *       the factory, because a pause there would stop every repo that
 *       loads configuration in a loop.
 *     - Sign-in vendor: a library or a page that logs in on someone else's
 *       site, such as Clerk or Google. The screen shows it so the person
 *       can connect a test account or take that journey off the finish line.
 *
 * Exports:
 *     - scanConfigNames: the names, where each was found, dynamic files,
 *       and sign-in vendors.
 *     - isBuiltinSkip: whether a name is on the starting skip list.
 *     - BUILTIN_SKIP: the starting names.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next",
  ".factory", "coverage", "__pycache__", ".venv", "venv",
]);

const CODE_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".php"]);

/** Names that are the machine or the factory, not an app setting. A start, not a complete list. */
export const BUILTIN_SKIP = new Set(["PATH", "HOME", "CI", "NODE_ENV", "ANTHROPIC_API_KEY"]);

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

const EXAMPLE = /^\.env\.(example|sample|template)$/i;

/** A login that happens on someone else's site. */
export interface SignInVendor {
  /** A short name a person would recognise, such as Clerk. */
  readonly vendor: string;
  /** The file that showed the vendor. */
  readonly where: string;
}

export interface ConfigNameScan {
  /** Name to the first file:line that reads it. */
  readonly names: ReadonlyMap<string, string>;
  /** Files that read a computed name. These do not pause the factory. */
  readonly dynamic: readonly string[];
  /** Logins on someone else's site. */
  readonly signIn: readonly SignInVendor[];
  readonly filesRead: number;
}

/**
 * Whether a name is on the starting skip list.
 *
 * name: the configuration name.
 * Returns true for PATH, HOME, CI, NODE_ENV, and the factory's own names.
 */
export function isBuiltinSkip(name: string): boolean {
  if (BUILTIN_SKIP.has(name)) return true;
  return name.startsWith("GITHUB_") || name.startsWith("RUNNER_") || name.startsWith("FACTORY_") || name.startsWith("GH_AW_");
}

/**
 * Names the browser bundle reads, which have to be present when the app is built.
 *
 * name: a configuration name from the scan.
 * Returns true for the public prefixes the usual web tools inline at build time.
 */
export function isClientName(name: string): boolean {
  return name.startsWith("NEXT_PUBLIC_") || name.startsWith("VITE_") || name.startsWith("PUBLIC_") || name.startsWith("REACT_APP_");
}

const VENDORS: readonly { vendor: string; pattern: RegExp }[] = [
  { vendor: "Clerk", pattern: /@clerk\/|clerk-js|clerk\.com/ },
  { vendor: "Google", pattern: /accounts\.google\.com|google-auth|@react-oauth\/google/ },
  { vendor: "NextAuth", pattern: /next-auth|@auth\/core|@auth0\// },
];

/**
 * Walk the repo and collect configuration names.
 *
 * root: the repository root. Dependencies, git data, build output, and
 * .factory are not read. Dot directories such as .git and .claude are not
 * read either.
 * Returns the literal names, where each was first seen, files with a
 * computed lookup, and sign-in vendors. The order of names is the order
 * the files were visited; callers sort when they show the list.
 */
export function scanConfigNames(root: string): ConfigNameScan {
  const names = new Map<string, string>();
  const dynamic: string[] = [];
  const signIn: SignInVendor[] = [];
  const seenVendor = new Set<string>();
  let filesRead = 0;
  const noteVendor = (text: string, rel: string): void => {
    for (const v of VENDORS) {
      if (seenVendor.has(v.vendor) || !v.pattern.test(text)) continue;
      seenVendor.add(v.vendor);
      signIn.push({ vendor: v.vendor, where: rel });
    }
  };
  const walk = (dir: string, depth: number): void => {
    if (depth > 12) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      if (name.startsWith(".") && !EXAMPLE.test(name)) continue;
      const p = join(dir, name);
      let info;
      try {
        info = statSync(p);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (info.size > 1_000_000) continue;
      const rel = relative(root, p).replace(/\\/g, "/");
      if (name === "package.json" || EXAMPLE.test(name) || CODE_EXT.has(extname(name).toLowerCase())) {
        filesRead += 1;
        readOne(p, rel, names, dynamic, noteVendor);
      }
    }
  };
  const pkg = join(root, "package.json");
  if (existsSync(pkg)) noteVendor(safeRead(pkg), "package.json");
  walk(root, 0);
  dynamic.sort();
  return { names, dynamic, signIn, filesRead };
}

/**
 * Read one source file for literal configuration names.
 *
 * path: absolute path of the file.
 * rel: path relative to the repo, using forward slashes.
 * names: map filled with the first place each name was seen.
 * dynamic: list filled when the file looks up a computed name.
 * noteVendor: called with the file text so a sign-in library is recorded once.
 */
function readOne(
  path: string,
  rel: string,
  names: Map<string, string>,
  dynamic: string[],
  noteVendor: (text: string, rel: string) => void,
): void {
  const text = safeRead(path);
  if (text === "") return;
  noteVendor(text, rel);
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (EXAMPLE.test(base)) {
    text.split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m?.[1] !== undefined && !line.trim().startsWith("#") && !names.has(m[1])) names.set(m[1], `${rel}:${i + 1}`);
    });
    return;
  }
  if (base === "package.json") return;
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
 * Read a file as text, or an empty string when it cannot be read.
 *
 * path: absolute path.
 * Returns the text. A missing or binary file is an empty string.
 */
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
