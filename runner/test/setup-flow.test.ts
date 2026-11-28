import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSetupStep } from "../src/commands/setup-flow.js";

/**
 * A throwaway checkout with a saved journey list and an incoming step.
 *
 * saved: the journey list already on the finish line.
 * incoming: the journey list the writer just produced.
 * Returns the two directories publishSetupStep reads.
 */
function dirs(saved: string, incoming: string): { from: string; into: string } {
  const root = mkdtempSync(join(tmpdir(), "setup-flow-"));
  const from = join(root, "from");
  const into = join(root, "into");
  mkdirSync(join(from, "context"), { recursive: true });
  mkdirSync(join(into, "context"), { recursive: true });
  writeFileSync(join(into, "context", "journeys.md"), saved);
  writeFileSync(join(from, "context", "journeys.md"), incoming);
  writeFileSync(join(from, "manifest.json"), JSON.stringify({ env: [{ name: "MODE", kind: "self", value: "test", why: "a flag" }] }));
  return { from, into };
}

const saved = "## Sign in and land on Home\n\nHow a person gets there: /sign-in\n";

describe("publishSetupStep", () => {
  it("keeps a finish-line journey the writer dropped, and still saves the recipe", () => {
    const { from, into } = dirs(saved, "## A shorter list\n\nHow a person gets there: /home\n");
    const result = publishSetupStep(from, into);
    expect(result.journeysKept).toMatch(/Sign in and land on Home/);
    expect(readFileSync(join(into, "context", "journeys.md"), "utf8")).toContain("## Sign in and land on Home");
    expect(readFileSync(join(into, "context", "journeys.md"), "utf8")).toContain("## A shorter list");
    expect(result.copied).toContain("manifest.json");
  });

  it("copies a journey list that keeps every heading", () => {
    const incoming = `${saved}\nHow the sandbox tests it: click Sign in\n`;
    const { from, into } = dirs(saved, incoming);
    const result = publishSetupStep(from, into);
    expect(result.journeysKept).toBeNull();
    expect(readFileSync(join(into, "context", "journeys.md"), "utf8")).toContain("How the sandbox tests it");
  });

  it("refuses a pasted password and copies nothing", () => {
    const { from, into } = dirs(saved, saved);
    writeFileSync(join(from, "manifest.json"), JSON.stringify({
      env: [{ name: "STRIPE", kind: "self", value: "sk_live_abc123", why: "x" }],
    }));
    expect(() => publishSetupStep(from, into)).toThrow(/pasted password|sk_live/);
    expect(readFileSync(join(into, "context", "journeys.md"), "utf8")).toBe(saved);
  });
});
