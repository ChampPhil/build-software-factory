import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestsGate } from "../src/commands/tests-gate.js";
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
});
