import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { inlineScripts, hashSource, applyHashes, PLACEHOLDER } from "../scripts/csp-hashes.mjs";

const headers = readFileSync(join(__dirname, "../public/_headers"), "utf8");

describe("the content security policy", () => {
  it("allows scripts by hash, never 'unsafe-inline'", () => {
    const line = headers.split("\n").find((l) => l.includes("script-src")) ?? "";
    const scriptSrc = /script-src([^;]*)/.exec(line)?.[1] ?? "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).toContain(PLACEHOLDER);
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("keeps the rest of the policy tight", () => {
    expect(headers).toContain("connect-src 'self' https://api.github.com");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain("object-src 'none'");
    expect(headers).toContain("base-uri 'none'");
  });

  it("finds the inline scripts a browser would run and skips the rest", () => {
    const html =
      '<script src="/a.js"></script><script>self.x=1</script><script id="_R_">y()</script>' +
      '<script type="application/json">{"a":1}</script><script type="module">z()</script>';
    expect(inlineScripts(html)).toEqual(["self.x=1", "y()", "z()"]);
  });

  it("hashes the exact text, and refuses to leave the placeholder or unsafe-inline", () => {
    expect(hashSource("abc")).toBe("'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
    const filled = applyHashes(headers, new Set([hashSource("abc")]));
    expect(filled).toContain("script-src 'self' 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
    expect(filled).not.toContain(PLACEHOLDER);
    expect(() => applyHashes("nothing here", new Set())).toThrow();
    expect(() => applyHashes(`script-src 'self' 'unsafe-inline' ${PLACEHOLDER}`, new Set())).toThrow();
  });

  it("in a built site, covers every inline script on every page", () => {
    const out = join(__dirname, "../out");
    const built = join(out, "_headers");
    if (!existsSync(built)) return; // `npm run build` has not run; the e2e covers the build
    const policy = readFileSync(built, "utf8");
    expect(policy).not.toContain(PLACEHOLDER);
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith(".html") ? [join(d, n)] : []));
    const pages = walk(out);
    expect(pages.length).toBeGreaterThan(5);
    for (const p of pages) for (const body of inlineScripts(readFileSync(p, "utf8"))) expect(policy, p).toContain(hashSource(body));
  });
});
