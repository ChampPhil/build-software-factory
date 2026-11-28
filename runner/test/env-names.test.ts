import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeWebsiteProblem, namesFromBootLog, stubWithoutFake, thinnerTest, vendorLoginWaiting } from "../src/commands/boot-checks.js";
import { envCommand } from "../src/commands/env-command.js";
import { scanConfigNames } from "../src/commands/env-names.js";
import { buildWait, emptyDecisions } from "../src/commands/env-state.js";
import { looksLikePastedSecret } from "../src/lib/placeholders.js";
import type { SandboxManifest } from "../src/commands/sandbox.js";

describe("the configuration scan", () => {
  it("reads the same names from the same tree, and does not pause on a computed name", () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-scan-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), 'const key = process.env.CLERK_SECRET_KEY;\nconst dyn = process.env[name];\n');
    writeFileSync(join(root, ".env.example"), "CLERK_SECRET_KEY=\nUSER=\n");
    const once = scanConfigNames(root);
    const twice = scanConfigNames(root);
    const namesOf = (scan: { names: ReadonlyMap<string, string> }): string[] => [...scan.names.keys()].sort();
    expect(namesOf(once)).toEqual(namesOf(twice));
    expect(once.names.has("CLERK_SECRET_KEY")).toBe(true);
    expect(once.dynamic.length).toBe(1);
    const wait = buildWait(once, emptyDecisions(), new Set(["CLERK_SECRET_KEY"]), []);
    expect(wait.names.find((n) => n.name === "CLERK_SECRET_KEY")?.decision).toBe("use");
    expect(wait.names.some((n) => n.name === "USER")).toBe(true);
    expect(wait.waiting).toBe(1);
    expect(wait.names.some((n) => n.name === "PATH")).toBe(false);
  });
});

describe("the boot checks", () => {
  it("refuses a thinner test and a vendor login page", () => {
    expect(thinnerTest(["npm test", "pytest"], "npm test && pytest")).toBeNull();
    expect(thinnerTest(["pytest"], "pytest tests/one -k owned")).not.toBeNull();
    expect(vendorLoginWaiting('<div data-clerk-component="SignIn">')).toBe(true);
    expect(vendorLoginWaiting("<p>hello</p>")).toBe(false);
    expect(looksLikePastedSecret("/api/backend/customer-workspaces/owned")).toBe(false);
  });

  it("sends a missing name back to the screen and does not invent it", () => {
    const named = namesFromBootLog("Error: CLERK_SECRET_KEY is not set");
    expect(named.missing).toContain("CLERK_SECRET_KEY");
    const manifest = {
      tier: "renders",
      commands: { run: null, test: "pytest" },
      app_url: null,
      stubs: [{ name: "clerk" }],
    } as unknown as SandboxManifest;
    expect(stubWithoutFake(manifest, [])).toContain("fake");
    expect(stubWithoutFake(manifest, null)).toBeNull();
    const invented = { ...manifest, commands: { ...manifest.commands, run: "python -m http.server 3000" } };
    expect(fakeWebsiteProblem(invented)).toContain("fake website");
    expect(fakeWebsiteProblem(manifest)).toBeNull();
  });
});

describe("bsf env apply", () => {
  it("exits 0 after the choices are saved, even when other names are still waiting", async () => {
    const root = mkdtempSync(join(tmpdir(), "bsf-apply-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "const a = process.env.CLERK_SECRET_KEY;\nconst b = process.env.OTHER_KEY;\n");
    const prev = process.env["DECISIONS"];
    const resume = process.env["RESUME"];
    process.env["DECISIONS"] = JSON.stringify({ use: ["CLERK_SECRET_KEY"] });
    process.env["RESUME"] = "false";
    try {
      const code = await envCommand("apply", { root });
      expect(code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env["DECISIONS"];
      else process.env["DECISIONS"] = prev;
      if (resume === undefined) delete process.env["RESUME"];
      else process.env["RESUME"] = resume;
    }
  });
});
