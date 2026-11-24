/**
 * The hosts a repo's own front end loads at runtime.
 *
 * The sandbox's egress allowlist covers package registries, so dependencies
 * install — but an app that pulls a library straight from a CDN in its HTML
 * gets no such help. In the first live install, a p5.js game loaded p5 from
 * cdnjs, the sandbox proxy refused the host, the browser reported
 * ERR_CERT_AUTHORITY_INVALID, and the canvas never rendered. Every screenshot
 * the factory attached to every PR was a blank page, politely captioned as
 * such, while the checks themselves passed on console output. The proof looked
 * worthless because the app under it was never running.
 *
 * Front-loading a CDN is what most hand-written pages do, so this is found by
 * reading the repo rather than by hoping the setup agent notices.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * Markup and styles only. A host in a `fetch()` or a comment is a different
 * question — it may be a doc link, an example, or a third party the sandbox is
 * meant to stub — and widening egress on a guess is worse than a blank page.
 */
const READ = new Set([".html", ".htm", ".css", ".scss", ".vue", ".svelte", ".ejs", ".hbs", ".njk", ".erb", ".php", ".twig", ".astro"]);
const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", "target", ".next", ".factory", "coverage", "__pycache__", ".venv", "test", "tests", "e2e", "__tests__", "fixtures", "docs"]);

/**
 * An https host in an asset position: `src="…"`, `href="…"` and CSS `url(…)`.
 * That is where a page names something it must load to render.
 */
const ASSET =
  /(?:\bsrc\s*=\s*|\bhref\s*=\s*|\burl\s*\(\s*)["']?https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)(?::\d+)?[/"')\s]/gi;

/**
 * Hosts that are never an app asset, so adding them to a sandbox allowlist
 * buys nothing and widens egress for no reason.
 */
const NOT_ASSETS = [
  /^(www\.)?github\.com$/,
  /^(.*\.)?githubusercontent\.com$/,
  /^(www\.)?example\.(com|org|net)$/,
  /^localhost$/,
  /^(.*\.)?w3\.org$/,
  /^(.*\.)?schema\.org$/,
  /^(.*\.)?npmjs\.(com|org)$/,
  /^(www\.)?wikipedia\.org$/,
  /^(.*\.)?mozilla\.org$/,
  /^(.*\.)?anthropic\.com$/,
];

function files(root: string, depth = 0): string[] {
  if (depth > 8) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith(".") === true) {
      if (SKIP.has(name) || name !== ".well-known") continue;
    }
    const p = join(root, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) out.push(...files(p, depth + 1));
    else if (READ.has(extname(name).toLowerCase()) && s.size < 2_000_000) out.push(p);
  }
  return out;
}

export interface AssetHostScan {
  readonly hosts: readonly string[];
  /** Which file each host was first seen in, so a reviewer can check the call. */
  readonly where: Readonly<Record<string, string>>;
  readonly filesRead: number;
}

/** Scan a checkout for the external hosts its own pages load. */
export function scanAssetHosts(root: string): AssetHostScan {
  const where: Record<string, string> = {};
  const list = files(root);
  for (const f of list) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(ASSET)) {
      const host = (m[1] ?? "").toLowerCase();
      if (host === "" || NOT_ASSETS.some((re) => re.test(host))) continue;
      where[host] ??= f.startsWith(root) ? f.slice(root.length).replace(/^[/\\]/, "") : f;
    }
  }
  return { hosts: Object.keys(where).sort(), where, filesRead: list.length };
}
