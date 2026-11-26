import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskLoader, resolveRead } from "../src/lib/config.js";

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "bsf-trusted-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

afterEach(() => {
  delete process.env["BSF_TRUSTED_ROOT"];
});

describe("a change cannot choose how it is judged", () => {
  it("reads the definition from the default branch and the sandbox from the checkout", async () => {
    // factory.yaml still comes from the default branch, so a pull request
    // cannot point existing_ci.test_check at a check that always passes.
    // The sandbox manifest is the checkout's: a fix to how tests run is the
    // one the gate reads. The trusted root's copy is not used for it.
    const pr = tree({
      ".factory/sandbox/manifest.json": '{"schema":"sandbox/1","commands":{"test":"npm test"}}',
      ".factory/definition/factory.yaml": "existing_ci: { test_check: always-green }",
      "src/app.ts": "the change",
    });
    const main = tree({
      ".factory/definition/factory.yaml": "existing_ci: { test_check: null }",
    });
    process.env["BSF_TRUSTED_ROOT"] = main;
    const disk = new DiskLoader(pr);
    expect(await disk.read(".factory/sandbox/manifest.json")).toContain("npm test");
    expect(await disk.read(".factory/definition/factory.yaml")).toContain("null");
    expect(await disk.read("src/app.ts")).toBe("the change");
  });

  it("is a no-op outside Actions, where the checkout is the only copy", () => {
    expect(resolveRead("/repo", ".factory/definition/policy.yaml")).toBe("/repo/.factory/definition/policy.yaml");
  });

  it("does not redirect guardrails, which a PR may legitimately lower", () => {
    process.env["BSF_TRUSTED_ROOT"] = "/main";
    expect(resolveRead("/pr", ".factory/guardrails/baselines.json")).toBe("/pr/.factory/guardrails/baselines.json");
  });
});
