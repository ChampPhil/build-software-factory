import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");

// v1.0 has no automatic changes to the factory definition. If someone adds the
// machinery back, this fails and points at the decision (docs/Decisions.md).
describe("v1.0 carries no self-improvement of the factory definition", () => {
  it("has no benchmark command, source or schema", () => {
    const cli = read("runner/src/cli.ts");
    expect(cli.replace(/review_and_benchmarks/g, "")).not.toMatch(/benchmark/i);
    for (const f of ["runner/src/commands/benchmark.ts", "runner/src/commands/benchmark-run.ts", "schema/benchmark-task.json", "schema/benchmark-result.json"]) {
      expect(existsSync(join(root, f)), f).toBe(false);
    }
    expect(readdirSync(join(root, "schema")).filter((f) => /benchmark/i.test(f))).toEqual([]);
  });

  it("has no definition route in the review", () => {
    const review = read("runner/src/commands/review.ts");
    expect(review).not.toContain("DEFINITION_ROUTE_ENABLED");
    expect(review).not.toMatch(/route:\s*["']definition["']/);
    const schema = JSON.parse(read("schema/review.json")) as unknown;
    expect(JSON.stringify(schema)).not.toMatch(/benchmark/i);
  });

  it("does not score /practice runs", () => {
    expect(existsSync(join(root, "templates/definition/rubrics/definition.yaml"))).toBe(false);
  });

  it("keeps /practice on the definition pipeline", () => {
    const intake = read("runner/src/commands/intake.ts");
    expect(intake).toContain("practice_declared");
    expect(intake).toContain("definition");
  });

  it("skips reviews under 5 runs", () => {
    const f = parse(read("templates/definition/factory.yaml")) as { review?: { skip_below_runs?: number } };
    expect(f.review?.skip_below_runs).toBe(5);
  });
});
