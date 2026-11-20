/**
 * Applying the frozen sandbox's choices to the role sources before a recompile.
 *
 * A role's network is a compile-time literal in gh-aw, so the documentation
 * hosts the setup agent found for this repo's stack reach the spec role only
 * by editing its source and compiling again. This does the edit; the
 * recompile workflow compiles and opens the PR.
 */

/** Hostnames only, so the file cannot smuggle anything else into the list. */
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function parseHosts(text: string): { readonly hosts: readonly string[]; readonly rejected: readonly string[] } {
  const hosts = new Set<string>();
  const rejected: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().toLowerCase();
    if (line === "" || line.startsWith("#")) continue;
    if (HOST.test(line)) hosts.add(line);
    else rejected.push(raw.trim());
  }
  return { hosts: [...hosts].sort(), rejected };
}

/**
 * Add hosts to the `network.allowed` list in a gh-aw workflow's frontmatter,
 * keeping every comment and line already there. Returns the new text and the
 * hosts actually added; unchanged text when there is nothing to add.
 */
export function addAllowedHosts(source: string, hosts: readonly string[]): { readonly text: string; readonly added: readonly string[] } {
  const end = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || end === -1) throw new Error("no gh-aw frontmatter");
  const fm = source.slice(0, end);
  const m = /\nnetwork:\n(?:[ \t]*#[^\n]*\n)*  allowed:\n((?:[ \t]*(?:- [^\n]*|#[^\n]*)\n)*)/.exec(fm + "\n");
  if (m?.[1] === undefined) throw new Error("no network.allowed list to add to");
  const existing = new Set([...m[1].matchAll(/^\s*- "?([^"\n]+)"?\s*$/gm)].map((x) => (x[1] ?? "").trim()));
  const added = hosts.filter((h) => !existing.has(h));
  if (added.length === 0) return { text: source, added };
  const insertAt = m.index + m[0].length;
  const block = `    # Added from .factory/sandbox/research-domains.txt: this repo's own stack.\n${added.map((h) => `    - ${h}`).join("\n")}\n`;
  const newFm = (fm + "\n").slice(0, insertAt) + block + (fm + "\n").slice(insertAt);
  return { text: newFm.replace(/\n$/, "") + source.slice(end), added };
}
