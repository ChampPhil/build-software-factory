import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseHosts, addAllowedHosts } from "../src/commands/recompile.js";

const SPEC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../templates/workflows/factory-role-spec.md"), "utf8");
const allowed = (text: string): string[] =>
  (parse(text.split("\n---\n")[0]?.replace(/^---\n/, "") ?? "") as { network: { allowed: string[] } }).network.allowed;

describe("applying research hosts to the spec role", () => {
  it("adds the repo's stack to the real spec template, keeping everything else", () => {
    const { text, added } = addAllowedHosts(SPEC, ["nextjs.org", "react.dev", "nodejs.org"]);
    // nodejs.org is already a default, so only the two new ones are added.
    expect(added).toEqual(["nextjs.org", "react.dev"]);
    expect(allowed(text)).toEqual(expect.arrayContaining(["api.anthropic.com", "github", "nextjs.org", "react.dev"]));
    // The prompt body is untouched.
    expect(text.split("\n---\n")[1]).toBe(SPEC.split("\n---\n")[1]);
  });

  it("is a no-op when every host is already there", () => {
    expect(addAllowedHosts(SPEC, ["github", "nodejs.org"]).text).toBe(SPEC);
  });

  it("accepts hostnames and nothing else", () => {
    const { hosts, rejected } = parseHosts("nextjs.org\n# comment\n\nReact.dev\n*\nhttps://x.org\nevil.com\\n- injected\n");
    expect(hosts).toEqual(["nextjs.org", "react.dev"]);
    expect(rejected).toEqual(["*", "https://x.org", "evil.com\\n- injected"]);
  });
});
