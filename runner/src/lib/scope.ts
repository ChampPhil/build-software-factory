/**
 * Which files a piece of work changes, and whether two pieces collide.
 *
 * One rule for every pipeline. Gardening used it alone, so hardening and
 * corrections filed PRs over lines another open PR was already rewriting.
 */

/** The files an item changes; `null` means the whole repo. */
export type GardenScope = ReadonlySet<string> | null;

export function scopeOf(files: readonly string[]): GardenScope {
  const clean = files.map((f) => f.trim().replace(/^\.\//, "")).filter((f) => f !== "");
  return clean.length === 0 ? null : new Set(clean);
}

export function scopesOverlap(a: GardenScope, b: GardenScope): boolean {
  if (a === null || b === null) return true;
  for (const f of a) {
    if (b.has(f)) return true;
    // A folder named in one item covers the files under it in the other.
    for (const g of b) {
      const dir = (x: string) => (x.endsWith("/") ? x : `${x}/`);
      if (g.startsWith(dir(f)) || f.startsWith(dir(g))) return true;
    }
  }
  return false;
}

/**
 * Overlap where both sides name files. An item that names none is unknown,
 * not repo-wide, so a hardening or correction item with no files recorded
 * never blocks everything else (gardening keeps the stricter rule above).
 */
export function knownScopesOverlap(a: GardenScope, b: GardenScope): boolean {
  if (a === null || b === null) return false;
  return scopesOverlap(a, b);
}

/** Lower-case, whitespace collapsed: the form two corrections are compared in. */
export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Files named in a work item's body: a gardening "Files:" list or a "Files changed:" line. */
export function filesNamedIn(body: string): string[] {
  const out: string[] = [];
  const at = body.lastIndexOf("\nFiles:\n");
  if (at >= 0) {
    for (const l of body.slice(at + "\nFiles:\n".length).split("\n")) {
      const m = /^- (.+)$/.exec(l.trim());
      if (m?.[1] !== undefined) out.push(m[1].trim());
    }
  }
  const line = /^Files changed: (.+)$/m.exec(body)?.[1];
  if (line !== undefined) {
    for (const f of line.replace(/ and \d+ more$/, "").split(",")) if (f.trim() !== "") out.push(f.trim());
  }
  return out;
}
