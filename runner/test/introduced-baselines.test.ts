import { describe, it, expect } from "vitest";
import { withIntroducedBaselines, withZeroBaselines } from "../src/commands/gates-run.js";
import { checkRatchet } from "../src/commands/gates.js";
import type { Baselines } from "../src/lib/types.js";

const b = (rules: Record<string, Record<string, number>>): Baselines => ({
  schema: "baselines/1",
  rules: Object.fromEntries(
    Object.entries(rules).map(([r, f]) => [r, { count: Object.values(f).reduce((a, x) => a + x, 0), by_file: f }]),
  ),
});

describe("a rule the PR introduces", () => {
  // js-legacy's setup PR turned on no-var with the existing violations
  // baselined, and the gate called every one of them new.
  const main = b({ eqeqeq: { "src/a.js": 1 } });
  const pr = b({ eqeqeq: { "src/a.js": 1 }, "no-var": { "src/a.js": 6, "src/b.js": 2 } });
  const measured = { eqeqeq: { "src/a.js": 1 }, "no-var": { "src/a.js": 6, "src/b.js": 2 } };

  it("holds untouched files to the counts the PR recorded", () => {
    const before = withIntroducedBaselines(withZeroBaselines(main, measured), main, pr, ["eslint.config.mjs"]);
    expect(checkRatchet(before, measured).ok).toBe(true);
  });

  it("keeps a file the PR changes at zero, so a new violation cannot be recorded away", () => {
    const before = withIntroducedBaselines(withZeroBaselines(main, measured), main, pr, ["src/b.js"]);
    expect(checkRatchet(before, measured).ok).toBe(false);
  });

  it("leaves a rule the default branch already baselines to its own counts", () => {
    const raised = b({ eqeqeq: { "src/a.js": 5 } });
    const m = { eqeqeq: { "src/a.js": 5 } };
    const before = withIntroducedBaselines(withZeroBaselines(main, m), main, raised, []);
    expect(checkRatchet(before, m).ok).toBe(false);
  });
});
