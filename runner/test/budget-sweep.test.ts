import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleHolds, runOfKey } from "../src/commands/budget-sweep.js";
import type { BudgetDoc } from "../src/commands/budget.js";

const NOW = "2026-11-22T03:00:00Z";
const hold = (key: string, started_at: string) => ({
  key, pipeline: "product_work", role: "verifier", model: "claude-haiku-5-5",
  agent_ceiling_usd: 2.5, detection_ceiling_usd: 0.66, started_at,
});
const doc = (inflight: ReturnType<typeof hold>[]): BudgetDoc => ({
  schema: "budget/2", month: "2026-11", spent_usd: {}, inflight, settled: [], updated_at: NOW,
});

function measureDir(key: string, agent: number): string {
  const d = mkdtempSync(join(tmpdir(), "m-"));
  writeFileSync(join(d, "measure.json"), JSON.stringify({ schema: "budget-measure/1", key, model: "claude-haiku-5-5", pipeline: "product_work", agent_usd: agent, detection_artifact: "det" }));
  return d;
}

describe("a hold whose step ended but never settled", () => {
  it("reads its run and attempt from the key", () => {
    expect(runOfKey("44976160929-1-agent-verification-host")).toEqual({ run: 44976160929, attempt: 1 });
    expect(runOfKey("manual")).toBeNull();
  });

  it("is settled from the step's own measure once its run has ended: trinsports' phantom $15.60", async () => {
    const det = mkdtempSync(join(tmpdir(), "d-"));
    writeFileSync(join(det, "detection_usage.json"), JSON.stringify({ model: "claude-haiku-5-5", input_tokens: 4, output_tokens: 385, cache_read_input_tokens: 51190, cache_creation_input_tokens: 52142, ai_credits: 0.722255 }));
    const out = await staleHolds(doc([hold("44976160929-1-agent-verification-host", "2026-11-22T02:30:57Z")]), NOW, 4 * 3600, {
      runStatus: async () => ({ status: "completed", updated_at: "2026-11-22T02:38:00Z" }),
      artifact: async (_run, name) => (name === "det" ? det : measureDir("44976160929-1-agent-verification-host", 0.1693)),
      log: () => {},
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.agentUsd).toBe(0.1693);
    expect(out[0]?.detectionUsd).toBeGreaterThan(0.007);
  });

  it("is left alone while its run is going, and charged at the ceiling when nothing was measured", async () => {
    const running = await staleHolds(doc([hold("1-1-x", "2026-11-22T02:50:00Z")]), NOW, 4 * 3600, {
      runStatus: async () => ({ status: "in_progress", updated_at: NOW }), artifact: async () => null, log: () => {},
    });
    expect(running).toEqual([]);
    const lost = await staleHolds(doc([hold("1-1-x", "2026-11-21T20:00:00Z")]), NOW, 4 * 3600, {
      runStatus: async () => null, artifact: async () => null, log: () => {},
    });
    expect(lost[0]).toMatchObject({ agentUsd: null, detectionUsd: null });
    expect(lost[0]?.why).toMatch(/ceiling/);
  });

  it("waits out its own settle job's grace period after the run ends", async () => {
    const out = await staleHolds(doc([hold("1-1-x", "2026-11-22T02:50:00Z")]), NOW, 4 * 3600, {
      runStatus: async () => ({ status: "completed", updated_at: "2026-11-22T02:55:00Z" }), artifact: async () => null, log: () => {},
    });
    expect(out).toEqual([]);
  });
});
