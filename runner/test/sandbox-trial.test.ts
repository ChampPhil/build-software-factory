import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trialSandbox, reachedTier } from "../src/commands/sandbox.js";

function manifest(over: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "sandbox/1", tier: "renders", tier_reason: null,
    commands: { install: "true", build: "true", run: null, test: "true" },
    app_url: null, env: [], services: [], egress: [], stubs: [], dropped: [],
    capabilities: { exercised: ["x"], not_exercised: [] },
    episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
    frozen_at: "2026-11-20T00:00:00Z",
    ...over,
  };
}

function setup(m: Record<string, unknown>): { dir: string; path: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "bsf-trial-"));
  const path = join(dir, "candidate.json");
  writeFileSync(path, JSON.stringify(m));
  return { dir, path, out: join(dir, "trial.json") };
}

const SERVER = `node -e "require('http').createServer((q,r)=>r.end(process.env.GREETING||'none')).listen(43117)"`;

describe("a trial measures the tier; it does not take the manifest's word", () => {
  it("reaches renders when the app answers and a screenshot is taken", async () => {
    const { dir, path, out } = setup(
      manifest({
        commands: { install: "true", build: "true", run: SERVER, test: "true" },
        app_url: "http://127.0.0.1:43117/",
        env: [{ name: "GREETING", kind: "self", value: "hello", why: "w" }],
      }),
    );
    const r = await trialSandbox({ manifestPath: path, workspace: dir, out, screenshot: () => true, log: () => {} });
    expect(r.reached).toBe("renders");
    expect(r.app_status).toBe(200);
    expect(JSON.parse(readFileSync(out, "utf8")).reached).toBe("renders");
  });

  it("falls to static when the tests fail, and says which step", async () => {
    const { dir, path, out } = setup(manifest({ commands: { install: "true", build: "true", run: null, test: "echo boom; exit 1" } }));
    const r = await trialSandbox({ manifestPath: path, workspace: dir, out, log: () => {} });
    expect(r.reached).toBe("static");
    expect(r.summary).toContain("test failed");
    expect(r.steps.find((s) => s.step === "test")?.tail).toContain("boom");
  });

  it("is build_and_test when the app never answers, and says the claim was not met", async () => {
    const { dir, path, out } = setup(
      manifest({ commands: { install: "true", build: "true", run: "sleep 30", test: "true" }, app_url: "http://127.0.0.1:43118/" }),
    );
    const r = await trialSandbox({ manifestPath: path, workspace: dir, out, appWaitMs: 3000, screenshot: () => true, log: () => {} });
    expect(r.reached).toBe("build_and_test");
    expect(r.summary).toContain("run failed");
  });

  it("only gives the app the manifest's variables", async () => {
    process.env["HOST_ONLY"] = "leak";
    const { dir, path, out } = setup(manifest({ commands: { install: "env > seen.txt", build: null, run: null, test: null } }));
    await trialSandbox({ manifestPath: path, workspace: dir, out, log: () => {} });
    delete process.env["HOST_ONLY"];
    expect(readFileSync(join(dir, "seen.txt"), "utf8")).not.toContain("HOST_ONLY");
  });

  it("reports an invalid candidate rather than throwing, so the agent can read why", async () => {
    const { dir, path, out } = setup({ schema: "sandbox/1" });
    const r = await trialSandbox({ manifestPath: path, workspace: dir, out, log: () => {} });
    expect(r.reached).toBe("static");
    expect(r.summary).toContain("invalid");
  });
});

describe("reachedTier", () => {
  const ok = (step: "install" | "build" | "test", command: string | null = "x") => ({ step, command, ok: true, exit: 0, seconds: 0, tail: "" });
  it("needs something to have run before it claims build_and_test", () => {
    expect(reachedTier([ok("install", null), ok("build", null), ok("test", null)], false, false)).toBe("static");
    expect(reachedTier([ok("build")], false, false)).toBe("build_and_test");
  });
  it("needs both the app answering and a screenshot for renders", () => {
    expect(reachedTier([ok("build")], true, false)).toBe("build_and_test");
    expect(reachedTier([ok("build")], true, true)).toBe("renders");
  });
});

describe("freezing", () => {
  it("takes the best measured round, at the tier it reached rather than the one claimed", async () => {
    const a = setup(manifest({ commands: { install: "true", build: "true", run: null, test: "exit 1" } }));
    await trialSandbox({ manifestPath: a.path, workspace: a.dir, out: a.out, log: () => {} });
    const b = setup(manifest({ commands: { install: "true", build: "true", run: null, test: "true" } }));
    await trialSandbox({ manifestPath: b.path, workspace: b.dir, out: b.out, log: () => {} });
    const { freezeManifest } = await import("../src/commands/sandbox.js");
    const { manifest: m, chosen } = freezeManifest(
      [{ candidate: a.path, trial: a.out }, { candidate: b.path, trial: b.out }],
      "2026-11-20T12:00:00Z",
    );
    expect(chosen).toBe(1);
    // Claimed renders, but nothing started, so it lands as build_and_test.
    expect(m["tier"]).toBe("build_and_test");
    expect(String(m["tier_reason"])).toContain("measured");
    // Every trial is on the record, including the one that failed.
    const episode = m["episode"] as { observed: string }[];
    expect(episode.map((e) => e.observed).join(" ")).toContain("test failed");
  });
});
