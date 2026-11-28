import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootProblems, isMachineOnly, signedInJourneyProblem, thinnerTest } from "../src/commands/boot-checks.js";
import type { SandboxManifest } from "../src/commands/sandbox.js";

function manifest(over: Partial<SandboxManifest> = {}): SandboxManifest {
  return {
    schema: "sandbox/1",
    tier: "build_and_test",
    commands: { install: null, build: null, run: null, test: "npm test", seed: null },
    env: [],
    services: [],
    ...over,
  };
}

describe("boot checks", () => {
  it("treats localhost and a home path as the person's computer", () => {
    expect(isMachineOnly("postgres://localhost:5432/app")).toBe(true);
    expect(isMachineOnly("/Users/me/data")).toBe(true);
    expect(isMachineOnly("sk_test_example")).toBe(false);
  });

  it("rejects a thinner test and a database the person can reach", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-boot-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    expect(thinnerTest("vitest", "npx vitest src/one.test.ts")).toMatch(/thinner/);
    expect(thinnerTest("vitest", "npm test")).toBeNull();
    const problems = bootProblems(manifest({
      commands: { install: null, build: null, run: null, test: "pytest config/one", seed: null },
      env: [{ name: "DATABASE_URL", kind: "test_mode", secret: "DATABASE_URL", why: "the store" }],
    }), root, { DATABASE_URL: "postgres://localhost:5432/app" });
    expect(problems.some((p) => p.includes("DATABASE_URL"))).toBe(true);
    expect(problems.some((p) => p.includes("thinner"))).toBe(true);
    expect(problems.join("\n")).not.toContain("localhost");
  });

  it("requires a marker when this boot starts a store", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-boot-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const problems = bootProblems(manifest({
      commands: { install: null, build: null, run: null, test: "npm test", seed: "node seed.js" },
      services: [{ name: "db", image: "postgres:16", port: 5432, why: "the store" }],
      env: [{ name: "DATABASE_URL", kind: "service", value: "postgres://127.0.0.1:5432/app", why: "this boot" }],
    }), root, {});
    expect(problems.some((p) => p.includes("marker"))).toBe(true);
  });

  it("asks for a signed-in journey when the app has sign-in", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-boot-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@clerk/nextjs": "1" } }));
    expect(signedInJourneyProblem("open the home page", root)).toMatch(/sign-in/);
    expect(signedInJourneyProblem("sign in and open the home page", root)).toBeNull();
  });
});
