import { describe, it, expect } from "vitest";
import { uselessProof } from "../src/commands/pr-report.js";

/**
 * Every PR in the first live install carried a screenshot of a page whose
 * library the sandbox proxy had refused, captioned — accurately — "the canvas
 * is not rendered because p5 did not load". Nothing failed: the checks passed
 * on console output. The PR simply arrived wearing evidence of nothing, and a
 * reviewer looks at a picture before they read a word.
 */

const blocks = (caption: string, file = "check1-after.png") => [
  { role: "verifier", report: { blocks: [{ type: "file" as const, file, caption }] } },
];

describe("proof that shows nothing", () => {
  it("is rejected when its own caption admits the app did not render", () => {
    const p = uselessProof(blocks("Check 1 after the change: the app at http://localhost:8787/ (screenshot; the canvas is not rendered because p5 did not load)"));
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("not proof");
    expect(p[0]).toContain("scan-asset-hosts");
  });

  for (const caption of [
    "the page is blank because the bundle failed to load",
    "screenshot; styles did not load",
    "blank screen — ERR_CERT_AUTHORITY_INVALID on the CDN",
    "couldn't render the canvas",
  ]) {
    it(`catches "${caption.slice(0, 40)}…"`, () => {
      expect(uselessProof(blocks(caption))).toHaveLength(1);
    });
  }

  it("leaves real proof alone", () => {
    expect(uselessProof(blocks("Check 2: the bobber sinks when the line is cast, at 00:14"))).toEqual([]);
    expect(uselessProof(blocks("Before: two guard.js tags in index.html"))).toEqual([]);
  });

  it("says nothing about a log block, which is text and speaks for itself", () => {
    const p = uselessProof([
      { role: "verifier", report: { blocks: [{ type: "file", file: "console.txt", caption: "p5 did not load" }] } },
    ]);
    expect(p).toEqual([]);
  });
});
