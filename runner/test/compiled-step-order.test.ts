import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * gh-aw v1.2.2 compiled the builder's safe-outputs job with its checkout step
 * reading the App token from a step that ran after it, so the checkout got an
 * empty token and no role could ever open a PR. No test looked at the order.
 * This one does, for every compiled lock: a step may only read the outputs of
 * a step that ran before it in the same job.
 */
const COMPILED = join(dirname(fileURLToPath(import.meta.url)), "../../templates/compiled");

interface Step { id?: string; name?: string; uses?: string; [k: string]: unknown }

describe("compiled role workflows", () => {
  for (const file of readdirSync(COMPILED).filter((f) => f.endsWith(".lock.yml"))) {
    it(`${file}: no step reads the output of a step that has not run yet`, () => {
      const doc = parse(readFileSync(join(COMPILED, file), "utf8")) as { jobs: Record<string, { steps?: Step[] }> };
      const problems: string[] = [];
      for (const [job, def] of Object.entries(doc.jobs)) {
        const steps = def.steps ?? [];
        const ids = steps.map((s) => s.id).filter((x): x is string => typeof x === "string");
        const seen = new Set<string>();
        for (const s of steps) {
          const { id: _id, ...rest } = s;
          for (const m of JSON.stringify(rest).matchAll(/steps\.([A-Za-z0-9_-]+)\.(outputs|outcome|conclusion)/g)) {
            const ref = m[1]!;
            if (ids.includes(ref) && !seen.has(ref)) problems.push(`${job}: "${s.name ?? s.uses ?? "a step"}" reads steps.${ref} before it runs`);
          }
          if (typeof s.id === "string") seen.add(s.id);
        }
      }
      expect(problems).toEqual([]);
    });
  }
});
