import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishSetupStep } from "../src/commands/setup-publish.js";

describe("publishing a setup step onto the branch", () => {
  it("copies the journey list and skips an env file", () => {
    const from = mkdtempSync(join(tmpdir(), "bsf-pub-from-"));
    const into = mkdtempSync(join(tmpdir(), "bsf-pub-into-"));
    mkdirSync(join(from, "context"));
    writeFileSync(join(from, "context", "journeys.md"), "sign in\n");
    writeFileSync(join(from, ".env"), "SECRET=nope\n");
    expect(publishSetupStep(from, into)).toEqual(["context/journeys.md"]);
    expect(readFileSync(join(into, "context", "journeys.md"), "utf8")).toBe("sign in\n");
  });

  it("refuses a recipe that pastes a password and copies nothing", () => {
    const from = mkdtempSync(join(tmpdir(), "bsf-pub-from-"));
    const into = mkdtempSync(join(tmpdir(), "bsf-pub-into-"));
    writeFileSync(join(from, "manifest.json"), JSON.stringify({
      env: [{ name: "STRIPE", kind: "self", value: "sk_test_4eC39HqLyjWDarjtT1zdp7dc", why: "x" }],
    }));
    writeFileSync(join(from, "journeys.md"), "keep\n");
    expect(() => publishSetupStep(from, into)).toThrow(/STRIPE/);
  });
});
