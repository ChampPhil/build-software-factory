import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvDecisions, scanConfigNames, undecidedNames } from "../src/commands/env-names.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "bsf-env-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.ts"), [
    "const db = process.env.DATABASE_URL;",
    "const home = process.env.HOME;",
    "const key = process.env[name];",
    "export const mode = process.env.NODE_ENV;",
  ].join("\n"));
  writeFileSync(join(root, ".env.example"), "CLERK_SECRET_KEY=\n# comment\nOPENAI_API_KEY=\n");
  return root;
}

describe("configuration names the code reads", () => {
  it("finds literal names and a dynamic file, and skips machine names", () => {
    const scan = scanConfigNames(repo());
    expect(scan.names.get("DATABASE_URL")).toMatch(/src\/app\.ts:1$/);
    expect(scan.names.get("CLERK_SECRET_KEY")).toMatch(/\.env\.example:1$/);
    expect(scan.names.has("HOME")).toBe(true);
    expect(scan.dynamic.length).toBe(1);
    const open = undecidedNames(scan, new Set(["CLERK_SECRET_KEY"]));
    expect(open.map((n) => n.name)).toEqual(["DATABASE_URL", "OPENAI_API_KEY"]);
  });

  it("treats a fake or ignored name as decided", () => {
    const root = repo();
    mkdirSync(join(root, ".factory"));
    writeFileSync(join(root, ".factory", "env-decisions.json"), JSON.stringify({ fake: ["OPENAI_API_KEY"], ignore: ["DATABASE_URL", "CLERK_SECRET_KEY"] }));
    const decisions = readEnvDecisions(root);
    const open = undecidedNames(scanConfigNames(root), new Set([...decisions.fake, ...decisions.ignore]));
    expect(open).toEqual([]);
  });
});
