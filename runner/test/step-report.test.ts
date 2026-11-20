import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStepReport, readUsage } from "../src/commands/step-report.js";
import { assertValid } from "../src/lib/schema.js";

const base = {
  harness: "claude-code" as const,
  role: "builder",
  model: "claude-opus-5",
  exit: "ok" as const,
  durationSec: 42.6,
  filesChanged: ["src/a.ts"],
  transcript: "sessions/run-1/builder.jsonl",
};

describe("buildStepReport", () => {
  it("validates against the step-report schema", () => {
    assertValid("step-report", buildStepReport(base));
  });

  it("prefers the harness's own cost when it reported one", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(dir, "usage.json");
    writeFileSync(p, JSON.stringify({ input_tokens: 1000, output_tokens: 500, total_cost_usd: 0.1234 }));
    const r = buildStepReport({ ...base, usagePath: p });
    expect(r.cost_usd).toBe(0.1234);
    expect(r.cost_source).toBe("session_log");
  });

  it("falls back to the price table when the harness reported only tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(dir, "usage.json");
    writeFileSync(p, JSON.stringify({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    const r = buildStepReport({
      ...base,
      usagePath: p,
      priceTable: { "claude-opus-5": { in: 3, out: 15 } },
    });
    expect(r.cost_usd).toBe(18);
    expect(r.cost_source).toBe("price_table");
  });

  it("says the cost is unknown rather than estimating one", () => {
    // This number is averaged into the spend the budget pauses on, so a
    // guess here would quietly become a reason to stop doing product work.
    const r = buildStepReport(base);
    expect(r.cost_usd).toBe(0);
    expect(r.cost_source).toBe("unknown");
  });

  it("does not invent a price when the model is not in the table", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(dir, "usage.json");
    writeFileSync(p, JSON.stringify({ input_tokens: 10, output_tokens: 10 }));
    const r = buildStepReport({ ...base, usagePath: p, priceTable: { "some-other-model": { in: 3, out: 15 } } });
    expect(r.cost_source).toBe("unknown");
  });

  it("reads the nested usage shape some harnesses write", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(dir, "usage.json");
    writeFileSync(p, JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 }, cost: { total_usd: 0.5 } }));
    expect(readUsage(p)).toEqual({ tokensIn: 7, tokensOut: 3, costUsd: 0.5 });
  });

  it("treats a missing or unparseable usage file as no usage, not as zero cost measured", () => {
    expect(readUsage("/nonexistent/usage.json")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "usage-"));
    const p = join(dir, "usage.json");
    writeFileSync(p, "not json");
    expect(readUsage(p)).toBeNull();
  });
});
