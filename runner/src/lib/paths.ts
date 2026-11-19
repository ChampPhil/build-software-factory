import { minimatch } from "minimatch";

/**
 * Path matching for policy rules.
 *
 * Policy patterns are globs (doc 09). A pattern may carry a `#` fragment
 * naming a section inside a config file, for example
 * `pyproject.toml#tool.ruff`; the fragment documents which part of the file is
 * a guardrail, and for path matching only the file part is used.
 */
export function patternPath(pattern: string): string {
  const hash = pattern.indexOf("#");
  return hash === -1 ? pattern : pattern.slice(0, hash);
}

/** The section a pattern names, if any (`tool.ruff` for `pyproject.toml#tool.ruff`). */
export function patternSection(pattern: string): string | undefined {
  const hash = pattern.indexOf("#");
  return hash === -1 ? undefined : pattern.slice(hash + 1);
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Does one repo-relative file path match one policy pattern? */
export function matchesPattern(file: string, pattern: string): boolean {
  const f = normalize(file);
  const raw = normalize(patternPath(pattern));
  if (raw === "") return false;
  if (minimatch(f, raw, { dot: true })) return true;
  // A directory pattern covers everything beneath it, whether or not the
  // policy author remembered the trailing `/**`.
  if (!raw.includes("*")) {
    const dir = raw.endsWith("/") ? raw : `${raw}/`;
    if (f.startsWith(dir)) return true;
    if (f === raw) return true;
  }
  return false;
}

/** Does a file match any pattern in the list? */
export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matchesPattern(file, p));
}

/** Every file in the list that matches any pattern. */
export function filesMatching(files: readonly string[], patterns: readonly string[]): string[] {
  return files.filter((f) => matchesAny(f, patterns));
}
