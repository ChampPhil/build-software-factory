import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanAssetHosts } from "../src/commands/asset-hosts.js";

/**
 * The first live install's PRs all carried a screenshot of a blank page. The
 * app was a p5.js game that loaded p5 from cdnjs; the sandbox proof allowlist
 * covered package registries but no asset CDN, so the proxy refused the host,
 * the browser reported ERR_CERT_AUTHORITY_INVALID, and the canvas never drew.
 * The verifier's checks passed on console output and its pictures showed
 * nothing — which reads as an agent that never bothered to look at the app.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "assets-"));
  writeFileSync(
    join(root, "index.html"),
    [
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">',
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/p5.js/1.9.0/p5.js"></script>',
      '<script src="utils/guard.js"></script>',
      "<!-- notes at https://github.com/someone/repo -->",
      '<a href="https://example.com/docs">docs</a>',
    ].join("\n"),
  );
  writeFileSync(join(root, "site.css"), "@font-face { src: url(https://use.typekit.net/abc.css); }\n");
  mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(root, "node_modules/pkg/index.html"), '<script src="https://never.example.net/x.js"></script>');
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test/fixture.html"), '<script src="https://also-never.example.net/x.js"></script>');
});

describe("scanning a repo for the hosts its pages load", () => {
  it("finds a library front-loaded from a CDN, which is what most hand-written pages do", () => {
    expect(scanAssetHosts(root).hosts).toContain("cdnjs.cloudflare.com");
    expect(scanAssetHosts(root).hosts).toContain("fonts.googleapis.com");
  });

  it("reads CSS url() too, so a web font is not missed", () => {
    expect(scanAssetHosts(root).hosts).toContain("use.typekit.net");
  });

  it("says where each host came from, so the call can be checked", () => {
    expect(scanAssetHosts(root).where["cdnjs.cloudflare.com"]).toBe("index.html");
  });

  it("ignores a host that is only mentioned, not loaded", () => {
    // Widening the sandbox's egress on the strength of a comment or a link in
    // prose would be worse than the blank page it is trying to fix.
    const hosts = scanAssetHosts(root).hosts;
    expect(hosts).not.toContain("github.com");
    expect(hosts).not.toContain("example.com");
  });

  it("does not read dependencies or test fixtures", () => {
    const hosts = scanAssetHosts(root).hosts;
    expect(hosts).not.toContain("never.example.net");
    expect(hosts).not.toContain("also-never.example.net");
  });
});
