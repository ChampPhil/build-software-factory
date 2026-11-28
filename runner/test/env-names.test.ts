import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeWebsiteProblem, namesFromBootLog, stubWithoutFake, thinnerTest, vendorLoginWaiting } from "../src/commands/boot-checks.js";
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
    expect(once.names.map((n) => n.name)).toEqual(twice.names.map((n) => n.name));
    expect(once.names.some((n) => n.name === "CLERK_SECRET_KEY")).toBe(true);
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
    expect(fakeWebsiteProblem(manifest)).toContain("fake website");
  });
});
