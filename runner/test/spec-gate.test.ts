import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { specProblems } from "../src/commands/spec-gate.js";

const root = (() => {
  const d = mkdtempSync(join(tmpdir(), "bsf-spec-"));
  mkdirSync(join(d, "lib"));
  writeFileSync(join(d, "lib/invoices.ts"), "a\nb\nc\n");
  return d;
})();
const base = { root, protectedPaths: [".github/workflows/**", ".factory/bin/**"] };

describe("a spec must show what it rests on", () => {
  it("passes a plan whose every finding cites something real", () => {
    expect(
      specProblems({
        ...base,
        spec: {
          files: ["lib/invoices.ts"],
          research: [
            { claim: "sent and paid invoices are the exportable ones", source: "lib/invoices.ts:2" },
            { claim: "Intl.NumberFormat formats currency", source: "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat" },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("rejects a plan with no research", () => {
    expect(specProblems({ ...base, spec: { research: [] } }).join()).toContain("cites no research");
  });

  it("rejects a citation to a file that does not exist, or a line past its end", () => {
    const p = specProblems({
      ...base,
      spec: { research: [{ claim: "x", source: "lib/missing.ts" }, { claim: "y", source: "lib/invoices.ts:99" }] },
    });
    expect(p.join("\n")).toContain("does not exist");
    expect(p.join("\n")).toContain("line 99");
  });

  it("rejects a path outside the repo", () => {
    expect(specProblems({ ...base, spec: { research: [{ claim: "x", source: "../../etc/passwd" }] } }).join()).toContain(
      "outside the repo",
    );
  });

  it("rejects a plan that changes a protected path, unless the pipeline is allowed it", () => {
    const spec = { files: [".factory/bin/bsf"], research: [{ claim: "x", source: "lib/invoices.ts" }] };
    expect(specProblems({ ...base, spec }).join()).toContain("protected path");
    expect(specProblems({ ...base, spec, pipelineExclusions: [".factory/bin/"] })).toEqual([]);
  });
});
