/**
 * Which files are the UI. Setup records this in the sandbox manifest, and the
 * PR report asks it whether a change needs a video, so that a server-only
 * change is never refused for "touching the UI" on the spec agent's say-so.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const UI_DEPS = ["react", "vue", "svelte", "next", "vite", "@angular/core"];
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".factory"]);

/** A glob (`**`, `*`) as a regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** Every directory whose package.json depends on a UI framework, plus any .html file. */
export function detectUiPaths(root: string): string[] {
  const out = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, "utf8")) as { dependencies?: object; devDependencies?: object };
        const deps = Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) });
        if (deps.some((d) => UI_DEPS.includes(d))) {
          const rel = relative(root, dir).split("\\").join("/");
          out.add(rel === "" ? "**" : `${rel}/**`);
        }
      } catch {
        /* an unreadable package.json says nothing about the UI */
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name.endsWith(".html")) {
        const rel = relative(root, join(dir, e.name)).split("\\").join("/");
        out.add(rel);
      }
    }
  };
  walk(root, 0);
  return [...out].sort();
}
