import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { startSandbox, sandboxEnv, toEnvFile, loadManifest, parseDotenv, RUNTIME_ENV, type SandboxManifest } from "../src/commands/sandbox.js";

const base: SandboxManifest = {
  schema: "sandbox/1",
  tier: "renders",
  commands: { install: null, build: null, run: null, test: null },
  env: [],
  services: [],
};

function full(m: Partial<SandboxManifest>): Record<string, unknown> {
  return {
    ...base,
    tier_reason: null,
    egress: [],
    stubs: [],
    dropped: [],
    capabilities: { exercised: ["x"], not_exercised: [] },
    episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
    frozen_at: "2026-11-20T00:00:00Z",
    ...m,
  };
}

function repo(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "bsf-sbx-"));
  execFileSync("git", ["init", "-q", dir]);
  mkdirSync(join(dir, ".factory/sandbox"), { recursive: true });
  if (manifest !== undefined) writeFileSync(join(dir, ".factory/sandbox/manifest.json"), JSON.stringify(manifest));
  return dir;
}

afterEach(() => {
  delete process.env["BSF_TRUSTED_ROOT"];
  delete process.env["HOST_ONLY_SECRET"];
});

describe("the sandbox's environment is closed", () => {
  it("gives the install command exactly the manifest's variables, nothing from the runner", async () => {
    process.env["HOST_ONLY_SECRET"] = "would-be-a-real-credential";
    const dir = repo(
      full({
        env: [
          { name: "SITE_URL", kind: "self", value: "http://localhost:3000", why: "the app's own origin" },
          { name: "DATABASE_URL", kind: "service", value: "postgresql://x@127.0.0.1/sbx", why: "throwaway db" },
        ],
        commands: { install: "env > seen.txt", build: null, run: null, test: null },
      }),
    );
    await startSandbox({ root: dir, workspace: dir, log: () => {} });
    const seen = readFileSync(join(dir, "seen.txt"), "utf8");
    expect(seen).toContain("SITE_URL=http://localhost:3000");
    expect(seen).toContain("DATABASE_URL=postgresql://x@127.0.0.1/sbx");
    expect(seen).not.toContain("HOST_ONLY_SECRET");
  });

  it("writes the environment where the agent can source it, and keeps it out of every commit", async () => {
    const dir = repo(full({ env: [{ name: "A", kind: "self", value: "it's quoted", why: "w" }] }));
    await startSandbox({ root: dir, workspace: dir, log: () => {} });
    const file = join(dir, RUNTIME_ENV);
    expect(readFileSync(file, "utf8")).toBe(`export A='it'"'"'s quoted'\n`);
    expect(readFileSync(join(dir, ".git/info/exclude"), "utf8")).toContain(RUNTIME_ENV);
    // Sourcing it gives the value back intact.
    expect(execFileSync("bash", ["-c", `. '${file}'; printf %s "$A"`], { encoding: "utf8" })).toBe("it's quoted");
  });

  it("takes test-mode keys from the one secret, and refuses to start without them", () => {
    const m = { ...base, env: [{ name: "STRIPE_KEY", kind: "test_mode", secret: "STRIPE_TEST", why: "w" }] };
    expect(sandboxEnv(m, "STRIPE_TEST=sk_test_1\n").env).toEqual({ STRIPE_KEY: "sk_test_1" });
    expect(sandboxEnv(m, undefined).missing).toEqual(["STRIPE_KEY (from STRIPE_TEST in FACTORY_SANDBOX_ENV)"]);
  });

  it("fails an install that fails", async () => {
    const dir = repo(full({ commands: { install: "exit 3", build: null, run: null, test: null } }));
    await expect(startSandbox({ root: dir, workspace: dir, log: () => {} })).rejects.toThrow(/install failed \(exit 3\)/);
  });
});

describe("the manifest", () => {
  it("is the one in the checkout, even when the default branch has another", () => {
    const pr = repo(full({ commands: { install: null, build: null, run: null, test: "npm test" } }));
    const main = repo(full({ commands: { install: null, build: null, run: null, test: "true" } }));
    process.env["BSF_TRUSTED_ROOT"] = main;
    const loaded = loadManifest(pr);
    expect(loaded.kind === "ok" && loaded.manifest.commands.test).toBe("npm test");
  });

  it("is read when it exists only on the pull request head", () => {
    const pr = repo(full({ commands: { install: null, build: null, run: null, test: "npm test" } }));
    const main = repo(undefined);
    process.env["BSF_TRUSTED_ROOT"] = main;
    const loaded = loadManifest(pr);
    expect(loaded.kind === "ok" && loaded.manifest.commands.test).toBe("npm test");
  });

  it("distinguishes missing from invalid, and never treats invalid as absent", () => {
    expect(loadManifest(repo(undefined)).kind).toBe("missing");
    expect(loadManifest(repo({ schema: "sandbox/1" })).kind).toBe("invalid");
  });

  it("starting with no manifest says setup has not finished", async () => {
    const dir = repo(undefined);
    await expect(startSandbox({ root: dir, workspace: dir, log: () => {} })).rejects.toThrow(/setup has not finished/);
    expect(existsSync(join(dir, RUNTIME_ENV))).toBe(false);
  });
});

describe("helpers", () => {
  it("parses a dotenv blob", () => {
    expect(parseDotenv('# c\nA=1\nexport B="two"\nC=\'3\'\n')).toEqual({ A: "1", B: "two", C: "3" });
  });
  it("writes variables sorted, so the file is reproducible", () => {
    expect(toEnvFile({ B: "2", A: "1" })).toBe("export A='1'\nexport B='2'\n");
  });
});
