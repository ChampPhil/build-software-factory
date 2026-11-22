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
    expect(p.join("\n")).toContain("not a file in the repo");
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

  it("accepts a reference followed by a note, and an experiment that names its command", () => {
    const p = specProblems({
      ...base,
      spec: {
        research: [
          { claim: "x", source: "lib/invoices.ts (the status union)" },
          { claim: "y", source: "lib/invoices.ts:2, where sent is defined" },
          { claim: "z", source: "https://vitest.dev/api/ (expect.toBe)" },
          { claim: "w", source: "ran: npx vitest run lib/ (12 passed)" },
        ],
      },
    });
    expect(p).toEqual([]);
  });

  it("rejects prose that is not a reference, and says what a source looks like", () => {
    const p = specProblems({
      ...base,
      spec: { research: [{ claim: "x", source: "npx vitest run in this sandbox" }, { claim: "y", source: "ran:" }] },
    });
    expect(p[0]).toContain('"ran: <command>"');
    expect(p[1]).toContain("without its command");
  });
});

describe("a product-work spec says whether it touches the UI", () => {
  const spec = { research: [{ claim: "x", source: "lib/invoices.ts:1" }] };
  it("asks for ui_change on product work", () => {
    expect(specProblems({ ...base, pipeline: "product_work", spec }).join("\n")).toContain("ui_change");
  });
  it("accepts true or false", () => {
    for (const ui_change of [true, false]) {
      expect(specProblems({ ...base, pipeline: "product_work", spec: { ...spec, ui_change } }).join("\n")).not.toContain("ui_change");
    }
  });
  it("rejects anything else", () => {
    expect(specProblems({ ...base, pipeline: "product_work", spec: { ...spec, ui_change: "yes" } }).join("\n")).toContain("ui_change must be true or false");
  });
  it("does not ask on other pipelines", () => {
    expect(specProblems({ ...base, pipeline: "gardening", spec }).join("\n")).not.toContain("ui_change");
  });
});
