import { describe, it, expect, vi } from "vitest";
import { landBlockers, landAmendment } from "../src/commands/sandbox-land.js";
import type { SandboxManifest } from "../src/commands/sandbox.js";
import type { Ledger } from "../src/lib/store.js";

const main: SandboxManifest = {
  schema: "sandbox/1",
  tier: "renders",
  commands: { install: "npm ci", build: null, run: "npm start", test: null },
  app_url: "http://localhost:3000",
  env: [{ name: "STRIPE_KEY", kind: "test_mode", secret: "STRIPE_TEST", why: "w" }],
  services: [],
  dependencies: [{ name: "db", kind: "database", stand_in: "service", probe: { path: "/", signed_in: false }, proven: true, why: "w" }],
};
const files = [".factory/sandbox/manifest.json", ".factory/sandbox/stubs/sign-in/mint.mjs"];
const better: SandboxManifest = {
  ...main,
  sign_in: { command: "node .factory/sandbox/stubs/sign-in/mint.mjs", why: "w" },
  dependencies: [
    ...(main.dependencies ?? []),
    { name: "sign-in", kind: "sign_in", stand_in: "session", probe: { path: "/teams/a", signed_in: true }, proven: true, why: "w" },
  ],
};

describe("an amendment merges itself only when it cannot widen what the sandbox reaches", () => {
  it("merges a repair that only adds what was missing", () => {
    expect(landBlockers({ mode: "automatic", files, main, candidate: better })).toEqual([]);
  });

  it("waits for a person on every way it could widen or weaken the sandbox", () => {
    const b = (candidate: SandboxManifest, f = files, mode: "automatic" | "reviewed" = "automatic") =>
      landBlockers({ mode, files: f, main, candidate }).join(" | ");
    expect(b(better, [...files, ".github/workflows/x.yml"])).toMatch(/outside .factory\/sandbox/);
    expect(b({ ...better, egress: ["api.stripe.com"] } as SandboxManifest)).toMatch(/new hosts: api.stripe.com/);
    expect(b({ ...better, env: [...better.env, { name: "K", kind: "test_mode", secret: "GOOGLE_TEST", why: "w" }] })).toMatch(/secrets.*GOOGLE_TEST/);
    expect(b({ ...better, tier: "build_and_test" })).toMatch(/below main's renders/);
    expect(b({ ...better, dependencies: [] })).toMatch(/no longer proves.*db/);
    expect(b(better, files, "reviewed")).toMatch(/sandbox_repairs: reviewed/);
    expect(landBlockers({ mode: "automatic", files, main: null, candidate: better })).toHaveLength(1);
  });
});

describe("landing", () => {
  const ledger: Ledger = {
    schema: "ledger/1", updated_at: "x", merge_queue: [], recent: [],
    open: [
      { work_item: "wi_A", pipeline: "product_work", status: "in_review", pr: 22 },
      { work_item: "wi_B", pipeline: "gardening", status: "in_review", pr: 24 },
      { work_item: "wi_C", pipeline: "gardening", status: "in_review", pr: 30 },
    ],
  };
  function gh(files: string[], mergeFails = false) {
    const calls: [string, string, unknown][] = [];
    return {
      repo: "o/r",
      calls,
      pullFiles: vi.fn(async () => files.map((filename) => ({ filename }))),
      send: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push([method, path, body]);
        if (mergeFails && path.endsWith("/merge")) throw new Error("405 Protected branch");
        return {};
      }),
    };
  }
  const store = { data: { readJson: async () => ({ needs: "n", reported_at: "x", reports: 1 }) }, put: vi.fn(async () => "sha") };

  it("merges, marks the reports repaired, and verifies the stuck changes again", async () => {
    const g = gh(files);
    const r = await landAmendment({
      gh: g as never, store: store as never, ledger, pr: 40, now: "2026-11-22T00:00:00Z", log: () => {},
      input: { mode: "automatic", main, candidate: better }, verifyLabel: "factory:verify",
      amend: { reports: [{ key: "k1", work_item: "wi_A" }, { key: "k2", work_item: "wi_B" }, { key: "k3", work_item: "wi_A" }] },
    });
    expect(r.merged).toBe(true);
    expect(r.reverified).toEqual([22, 24]);
    expect(g.calls.some(([m, p]) => m === "PUT" && p.endsWith("/pulls/40/merge"))).toBe(true);
    expect(g.calls.filter(([m, p]) => m === "POST" && p.endsWith("/labels")).map(([, p]) => p)).toEqual(["repos/o/r/issues/22/labels", "repos/o/r/issues/24/labels"]);
    expect(store.put).toHaveBeenCalled();
  });

  it("leaves it for a person, saying why, when it may not merge itself or GitHub refuses", async () => {
    const g = gh([...files, "package.json"]);
    const r = await landAmendment({
      gh: g as never, store: store as never, ledger, pr: 41, now: "x", log: () => {},
      input: { mode: "automatic", main, candidate: better }, verifyLabel: "factory:verify", amend: { reports: [] },
    });
    expect(r.merged).toBe(false);
    expect(g.calls.find(([, p]) => p.endsWith("/comments"))?.[2]).toMatchObject({ body: expect.stringMatching(/package.json/) });
    const g2 = gh(files, true);
    const r2 = await landAmendment({
      gh: g2 as never, store: store as never, ledger, pr: 42, now: "x", log: () => {},
      input: { mode: "automatic", main, candidate: better }, verifyLabel: "factory:verify", amend: { reports: [] },
    });
    expect(r2.merged).toBe(false);
    expect(r2.blockers[0]).toMatch(/Protected branch/);
  });
});
