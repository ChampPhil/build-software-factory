/**
 * The journey look and the scratch layer.
 *
 * A page the journey list does not mention is one gap. A page the list
 * already names is not. Scratch notes stay out of the recipe and the proof
 * says what the run added.
 */

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lookForGap, pagePaths, parseJourneys } from "../src/commands/journeys.js";
import { clearScratch, noteScratch, scratchProof } from "../src/commands/scratch.js";

describe("journey list", () => {
  it("reads the three lines under each heading", () => {
    const parsed = parseJourneys(`# Journeys\n\n## See the roster\nHow a person gets there: open /teams\nWhat proves it: the roster heading\nHow the sandbox tests it: signed in as the seed user\n`);
    expect(parsed).toEqual([
      { title: "See the roster", reaches: "open /teams", proves: "the roster heading", tests: "signed in as the seed user" },
    ]);
  });

  it("reports one uncovered page and ignores a page the list already names", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-journeys-"));
    mkdirSync(join(root, "app/billing"), { recursive: true });
    mkdirSync(join(root, "app/teams"), { recursive: true });
    writeFileSync(join(root, "app/billing/page.tsx"), "export default function Page() { return null }\n");
    writeFileSync(join(root, "app/teams/page.tsx"), "export default function Page() { return null }\n");
    expect(pagePaths(root)).toEqual(["/billing", "/teams"]);
    const list = "## Teams\nHow a person gets there: open /teams\nWhat proves it: the name\n";
    expect(lookForGap(list, ["/billing", "/teams"])).toBe("/billing");
    expect(lookForGap(`${list}\n## Billing\nHow a person gets there: open /billing\n`, ["/billing"])).toBeNull();
    expect(lookForGap(null, ["/billing"])).toBeNull();
  });
});

describe("scratch layer", () => {
  it("records a note beside the recipe and clears it into a proof line", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-scratch-"));
    mkdirSync(join(root, ".factory/sandbox"), { recursive: true });
    writeFileSync(join(root, ".factory/sandbox/manifest.json"), "{}\n");
    noteScratch(root, "created Stripe test customer cus_run", "2026-11-27T00:00:00Z");
    expect(readFileSync(join(root, ".factory/sandbox/manifest.json"), "utf8")).toBe("{}\n");
    const cleared = clearScratch(root);
    expect(cleared.cleanup).toBe("best-effort");
    expect(cleared.proof).toBe(scratchProof(["created Stripe test customer cus_run"]));
    expect(clearScratch(root).proof).toBe("This run used the seed alone.");
  });
});
