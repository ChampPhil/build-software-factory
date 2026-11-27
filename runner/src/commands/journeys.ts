/**
 * The journey list: the few things a person does in the app, kept apart
 * from the folder map.
 *
 * Purpose
 * -------
 * Computer 0 writes this list before anyone builds the private copy of the
 * app. Later, a cheap look compares the product to the list. A path a person
 * can now take that the list cannot reach is one gap. The sandbox changes
 * only for that one gap, as a pull request. A new field on a screen the list
 * already reaches is not a gap.
 *
 * Key terms
 * ---------
 * Journey: one thing a person does, with how they get there, what proves it
 * worked, and (once the sandbox exists) how an agent tests it.
 * Folder map: `feature-map.md`, a list of code directories. It is not this
 * list, and this file does not read it.
 * Gap: one URL path that no journey's "how a person gets there" text
 * mentions. The look reports at most one.
 * Reach text: the "How a person gets there" line. If it already names the
 * path, the path is not new.
 *
 * Exports
 * -------
 * JOURNEYS_PATH, parseJourneys, pagePaths, lookForGap, JourneysCommand via
 * the cli.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Where Computer 0 writes the list, and where every later look reads it. */
export const JOURNEYS_PATH = ".factory/definition/context/journeys.md";

export interface Journey {
  /** The heading, in the person's words. */
  readonly title: string;
  /** How a person gets there. A path named here is already reachable. */
  readonly reaches: string;
  /** What on the screen or in the data proves the journey worked. */
  readonly proves: string;
  /** How the sandbox lets an agent test it. Computer A fills this in. */
  readonly tests: string;
}

const REACH = /^how a person gets there:\s*(.*)$/i;
const PROVES = /^what proves it:\s*(.*)$/i;
const TESTS = /^how the sandbox tests it:\s*(.*)$/i;

/**
 * Read the journey list.
 *
 * A heading is a journey. The three labeled lines under it are the reach,
 * the proof, and the sandbox note. A missing line is an empty string, so a
 * list Computer 0 has not finished is still readable.
 *
 * root: the repository checkout.
 */
export function parseJourneys(markdown: string): readonly Journey[] {
  const out: Journey[] = [];
  let current: { title: string; reaches: string; proves: string; tests: string } | null = null;
  const flush = (): void => {
    if (current !== null) out.push(current);
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading !== null) {
      flush();
      current = { title: heading[1]!.trim(), reaches: "", proves: "", tests: "" };
      continue;
    }
    if (current === null) continue;
    const reach = REACH.exec(line);
    const proves = PROVES.exec(line);
    const tests = TESTS.exec(line);
    if (reach !== null) current = { ...current, reaches: reach[1]!.trim() };
    else if (proves !== null) current = { ...current, proves: proves[1]!.trim() };
    else if (tests !== null) current = { ...current, tests: tests[1]!.trim() };
  }
  flush();
  return out;
}

/** Paths that are never a journey by themselves. */
const SKIP_SEGMENT = new Set(["api", "assets", "static", "health", "favicon", "_next", "public"]);

/**
 * Page URLs this checkout exposes, from the files a person would open.
 *
 * A Next.js `app/billing/page.tsx` is `/billing`. A `pages/teams/[id].tsx`
 * is `/teams`. Dynamic pieces are dropped. API routes and the denylist are
 * not pages. The result is sorted and unique.
 *
 * root: the repository checkout.
 */
export function pagePaths(root: string): readonly string[] {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git" || name === ".factory" || name === ".github") continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = relative(root, abs).split(sep).join("/");
      const app = /^app\/(.*\/)?page\.(tsx|jsx|ts|js)$/.exec(rel);
      const pages = /^pages\/(.+)\.(tsx|jsx|ts|js)$/.exec(rel);
      if (app !== null) {
        const parts = (app[1] ?? "").split("/").filter((p) => p !== "" && !p.startsWith("[") && !p.startsWith("("));
        add(found, parts);
      } else if (pages !== null && !pages[1]!.startsWith("api/") && pages[1] !== "_app" && pages[1] !== "_document") {
        const parts = pages[1]!.replace(/\/index$/, "").split("/").filter((p) => p !== "" && !p.startsWith("["));
        add(found, parts);
      }
    }
  };
  walk(root);
  return [...found].sort();
}

function add(found: Set<string>, parts: readonly string[]): void {
  const kept = parts.filter((p) => !SKIP_SEGMENT.has(p));
  if (kept.length === 0) return;
  found.add(`/${kept.join("/")}`);
}

/**
 * The one path the journey list cannot reach, or null when every given page
 * is already named.
 *
 * No journey file, or a file with no journeys, is not a gap. The look does
 * not invent the first list, and it does not treat a page the list left out
 * on purpose as new. The caller passes only pages that appeared after the
 * list was written. A path is covered when any journey's title or reach
 * text contains it.
 *
 * markdown: the journey file, or null when it has not been written.
 * pages: the page URLs to consider, already filtered to the ones that are new.
 */
export function lookForGap(markdown: string | null, pages: readonly string[]): string | null {
  if (markdown === null) return null;
  const journeys = parseJourneys(markdown);
  if (journeys.length === 0) return null;
  const covered = journeys.map((j) => `${j.title} ${j.reaches}`.toLowerCase()).join("\n");
  for (const path of pages) {
    if (!covered.includes(path.toLowerCase())) return path;
  }
  return null;
}

/**
 * Page URLs whose files changed after the journey list was last committed.
 *
 * A page that already existed when Computer 0 wrote the list was left off
 * on purpose. Only a file added or edited since that commit can be a new
 * path. No git history, or a journey file that has never been committed,
 * means there is nothing new to report.
 *
 * root: the repository checkout.
 */
export function pagesSinceJourneyList(root: string): readonly string[] {
  const file = JOURNEYS_PATH;
  try {
    const when = execFileSync("git", ["log", "-1", "--format=%H", "--", file], { cwd: root, encoding: "utf8" }).trim();
    if (when === "") return [];
    const names = execFileSync("git", ["diff", "--name-only", when, "HEAD", "--", "app", "pages"], { cwd: root, encoding: "utf8" });
    const changed = new Set(names.split(/\r?\n/).filter((n) => n !== ""));
    if (changed.size === 0) return [];
    return pagePaths(root).filter((path) => [...changed].some((filePath) => filePath.replace(/\\/g, "/").includes(path.slice(1).split("/")[0] ?? "")));
  } catch {
    return [];
  }
}

/**
 * Read the journey file. Null when setup has not written it.
 *
 * root: the repository checkout.
 */
export function readJourneysFile(root: string): string | null {
  const path = join(root, JOURNEYS_PATH);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
