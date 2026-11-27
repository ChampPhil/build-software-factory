import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestsGate, testCommandDropsTests, manifestDropsTests, missingManifestTests } from "../src/commands/tests-gate.js";
import { closedEnv, RUNTIME_ENV } from "../src/commands/sandbox.js";

const gh = { repo: "o/r" } as never;

describe("the tests gate", () => {
  it("runs the manifest's test command through a shell, as written", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const r = await runTestsGate({ gh, commit: "abc", existingCheck: null, command: "test -n \"$GREETING\" && echo ok", root, env: { PATH: process.env["PATH"] ?? "", GREETING: "hi" } });
    expect(r.conclusion).toBe("success");
  });

  it("runs it in the closed environment, not the runner's", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    process.env["BSF_LEAK_PROBE"] = "from-the-runner";
    mkdirSync(join(root, ".factory/sandbox"), { recursive: true });
    writeFileSync(join(root, RUNTIME_ENV), "PORT='3000'\n");
    const env = closedEnv(root);
    expect(env?.["PORT"]).toBe("3000");
    expect(env?.["BSF_LEAK_PROBE"]).toBeUndefined();
    const r = await runTestsGate({ gh, commit: "abc", existingCheck: null, command: 'test -z "$BSF_LEAK_PROBE"', root, ...(env === null ? {} : { env }) });
    expect(r.conclusion).toBe("success");
    delete process.env["BSF_LEAK_PROBE"];
  });

  it("has no closed environment where the sandbox was not started", () => {
    expect(closedEnv(mkdtempSync(join(tmpdir(), "tg-")))).toBeNull();
  });

  it("fails a sandbox whose test command deselects tests, and does not read a passing check", async () => {
    const root = mkdtempSync(join(tmpdir(), "tg-"));
    const gh = { repo: "o/r", get: () => { throw new Error("the existing check must not be read"); } } as never;
    const dropped = await runTestsGate({
      gh, commit: "abc", existingCheck: "ci", command: "pytest -k unit", root,
    });
    expect(dropped.conclusion).toBe("failure");
    expect(dropped.summary).toMatch(/-k/);
    const deselect = await runTestsGate({
      gh, commit: "abc", existingCheck: "ci", command: "pytest --deselect tests/test_slow.py", root,
    });
    expect(deselect.conclusion).toBe("failure");
    expect(testCommandDropsTests("npm test", { PYTEST_ADDOPTS: "--deselect tests/test_a.py" })).toMatch(/--deselect/);
    expect(testCommandDropsTests("pytest tests --ignore=node_modules")).toBeNull();
    expect(testCommandDropsTests("pytest --ignore=tests")).toMatch(/ignores test paths/);
    expect(testCommandDropsTests("pytest --ignore tests/unit")).toMatch(/tests\/unit/);
    expect(manifestDropsTests({ test: "npm test", coverage: "pytest -k smoke" })).toMatch(/-k/);
    expect(manifestDropsTests({ test: "npm test", coverage: "npm test" })).toBeNull();
  });

  it("does not fail a pull request for a missing manifest until setup has written one", () => {
    const waiting = missingManifestTests(false);
    expect(waiting.conclusion).toBe("neutral");
    expect(waiting.exitCode).toBe(0);
    expect(waiting.summary).toMatch(/default branch/);
    const after = missingManifestTests(true);
    expect(after.conclusion).toBe("failure");
    expect(after.exitCode).toBe(1);
  });
});
