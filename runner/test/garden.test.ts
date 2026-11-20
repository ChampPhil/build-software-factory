import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselinedDrift, untestedRecent, MAX_FILES_PER_PR } from "../src/commands/garden.js";
import type { Baselines } from "../src/lib/types.js";

/** A real Baselines from per-file counts, so the fixture is the shape the
 * code reads rather than a cast that hid a missing `count`. */
const baselines = (byFile: Record<string, Record<string, number>>): Baselines => ({
  schema: "baselines/1",
  rules: Object.fromEntries(
    Object.entries(byFile).map(([rule, files]) => [
      rule,
      { count: Object.values(files).reduce((a, b) => a + b, 0), by_file: files },
    ]),
  ),
});

describe("baselinedDrift", () => {
  it("lists rules with counts above zero, worst first", () => {
    const items = baselinedDrift(baselines({
      "no-explicit-any": { "a.ts": 3, "b.ts": 1 },
      "no-floating-promises": { "c.ts": 9 },
    }));
    expect(items.map((i) => i.problem_class)).toEqual(["no-floating-promises", "no-explicit-any"]);
    expect(items[0]?.occurrences).toBe(9);
  });

  it("ignores rules already at zero, which are nothing to clean", () => {
    expect(baselinedDrift(baselines({ "no-explicit-any": { "a.ts": 0 } }))).toHaveLength(0);
  });

  it("leaves a retired rule alone, which is what retiring it meant", () => {
    const b: Baselines = {
      schema: "baselines/1",
      rules: {
        "no-explicit-any": { count: 4, by_file: { "a.ts": 4 }, retired: true },
        "no-floating-promises": { count: 1, by_file: { "b.ts": 1 } },
      },
    };
    expect(baselinedDrift(b).map((i) => i.problem_class)).toEqual(["no-floating-promises"]);
  });

  it("reads a rule's own fields as fields, not as file names", () => {
    // The entry's keys are `count`, `by_file`, `recorded_at` and so on. An
    // earlier version walked those as if they were paths, and filed items
    // asking an agent to clean a file called `count`.
    const b: Baselines = {
      schema: "baselines/1",
      rules: {
        "no-explicit-any": {
          count: 3,
          recorded_at: "2026-11-19T00:00:00Z",
          native: ".eslint-baseline.json",
          by_file: { "src/a.ts": 3 },
        },
      },
    };
    const item = baselinedDrift(b)[0];
    expect(item?.files).toEqual(["src/a.ts"]);
    expect(item?.occurrences).toBe(3);
  });

  it("files nothing to clean for a rule with a count and no per-file breakdown", () => {
    // `byFileOf` keeps such a rule under the empty key so the ratchet has a
    // number; there is no path to put in a PR, so there is no item.
    const b: Baselines = { schema: "baselines/1", rules: { "no-explicit-any": { count: 5 } } };
    expect(baselinedDrift(b)).toHaveLength(0);
  });

  it("caps an item at the per-PR file limit and says so", () => {
    const perFile: Record<string, number> = {};
    for (let i = 0; i < 40; i++) perFile[`f${i}.ts`] = 1;
    const item = baselinedDrift(baselines({ "no-explicit-any": perFile }))[0]!;
    expect(item.files).toHaveLength(MAX_FILES_PER_PR);
    expect(item.detail).toContain(`first ${MAX_FILES_PER_PR}`);
    // The full count is still reported, so the next night picks up the rest.
    expect(item.occurrences).toBe(40);
  });
});

describe("untestedRecent", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "garden-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");

    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "src/__tests__"), { recursive: true });

    // Commit 1: source with a test alongside it — tested.
    writeFileSync(join(repo, "src/with-test.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "src/__tests__/with-test.test.ts"), "test('a', () => {});\n");
    git("add", "-A");
    git("commit", "-qm", "tested change");

    // Commit 2: source with no test — untested.
    writeFileSync(join(repo, "src/no-test.ts"), "export const b = 2;\n");
    git("add", "-A");
    git("commit", "-qm", "untested change");

    // Commit 3: generated output only — not anybody's untested behaviour.
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist/bundle.js"), "console.log(1);\n");
    git("add", "-A");
    git("commit", "-qm", "build output");
  });

  it("finds source changed with no test in the same commit", async () => {
    const items = await untestedRecent(repo, 30);
    const files = items.flatMap((i) => i.files);
    expect(files).toContain("src/no-test.ts");
  });

  it("does not flag a change that brought its own test", async () => {
    const files = (await untestedRecent(repo, 30)).flatMap((i) => i.files);
    expect(files).not.toContain("src/with-test.ts");
  });

  it("ignores generated and vendored trees", async () => {
    const files = (await untestedRecent(repo, 30)).flatMap((i) => i.files);
    expect(files).not.toContain("dist/bundle.js");
  });

  it("says nothing rather than guessing when there is no history to read", async () => {
    const empty = mkdtempSync(join(tmpdir(), "garden-empty-"));
    expect(await untestedRecent(empty, 30)).toHaveLength(0);
  });
});
