import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCoverageGate } from "../src/commands/gates-run.js";
import type { Coverage } from "../src/lib/types.js";

function repoWithCoverage(filePct: number, totalPct: number): string {
  const root = mkdtempSync(join(tmpdir(), "bsf-cov-"));
  mkdirSync(join(root, "coverage"), { recursive: true });
  const line = (pct: number) => ({ total: 100, covered: pct, skipped: 0, pct });
  writeFileSync(
    join(root, "coverage/coverage-summary.json"),
    JSON.stringify({
      total: { lines: line(totalPct), statements: line(totalPct), functions: line(totalPct), branches: line(totalPct) },
      [join(root, "server/log.js")]: { lines: line(filePct), statements: line(filePct), functions: line(filePct), branches: line(filePct) },
    }),
  );
  return root;
}

const current: Coverage = {
  schema: "coverage/1", high_pct: 80, floor_pct: 79, diff_min_pct: 80, skips: { count: 0, cap: 0 },
} as unknown as Coverage;

describe("diff coverage by pipeline (fix 20)", () => {
  it("passes a gardening change at 51.4% diff coverage when total coverage holds", async () => {
    const root = repoWithCoverage(51.4, 80);
    const r = await runCoverageGate({ root, current, changedFiles: ["server/log.js"], pipeline: "gardening" });
    expect(r.conclusion).toBe("success");
    expect(r.summary).toContain("Diff coverage is not required for a behaviour-preserving change");
  });

  it("passes a hardening change the same way", async () => {
    const root = repoWithCoverage(0, 80);
    expect((await runCoverageGate({ root, current, changedFiles: ["server/log.js"], pipeline: "hardening" })).conclusion).toBe("success");
  });

  it("fails the same numbers on product work", async () => {
    const root = repoWithCoverage(51.4, 80);
    const r = await runCoverageGate({ root, current, changedFiles: ["server/log.js"], pipeline: "product_work" });
    expect(r.conclusion).toBe("failure");
    expect(r.failures.join(" ")).toContain("diff coverage");
  });

  it("still holds a gardening change to the total floor", async () => {
    const root = repoWithCoverage(51.4, 60);
    expect((await runCoverageGate({ root, current, changedFiles: ["server/log.js"], pipeline: "gardening" })).conclusion).toBe("failure");
  });
});
