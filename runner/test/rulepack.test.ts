import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { validate } from "../src/lib/schema.js";
import {
  verifyRule, EslintRunner, RuffRunner,
  type RulePack, type RulePackRule, type ToolRunner,
} from "../src/commands/rulepack.js";

/**
 * Phase 3 installs a rule only once it has been shown to discriminate: it must
 * fail on its bad example and pass on the dominant pattern. These tests run
 * the real tools against the real examples, so a rule that does not
 * discriminate cannot ship.
 *
 * This caught two things while the packs were being written: `no-undef` fired
 * on `module` in CommonJS, because the pack had no base config to declare its
 * globals — a rule that would have blocked correct code in every JS repo.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "rules")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const ROOT = repoRoot();
const RULES = join(ROOT, "rules");

function loadPack(name: string): RulePack {
  return parseYaml(readFileSync(join(RULES, `${name}.yaml`), "utf8")) as RulePack;
}

const PACKS = ["typescript", "javascript", "python"] as const;

function have(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_ESLINT = existsSync(join(ROOT, "node_modules/eslint/bin/eslint.js"));
const HAVE_RUFF = have("ruff", ["--version"]);

describe("the rule packs", () => {
  it("there is a pack for each v0.1 language", () => {
    const files = readdirSync(RULES).filter((f) => f.endsWith(".yaml"));
    for (const p of PACKS) expect(files).toContain(`${p}.yaml`);
  });

  for (const name of PACKS) {
    describe(name, () => {
      const pack = loadPack(name);

      it("validates against the rulepack schema", () => {
        const res = validate("rulepack", pack);
        if (!res.ok) throw new Error(JSON.stringify(res.errors, null, 2));
        expect(res.ok).toBe(true);
      });

      it("every rule names a tool the pack declares", () => {
        const ids = new Set(pack.tools.map((t) => t.id));
        for (const r of pack.rules) expect(ids, `${r.id} names ${r.tool}`).toContain(r.tool);
      });

      it("every rule explains its concern in a sentence a reviewer can read", () => {
        for (const r of pack.rules) {
          expect(r.concern.length, `${r.id} has no real concern`).toBeGreaterThan(40);
          // The PR body quotes this, so it should say why, not restate the id.
          expect(r.concern.toLowerCase()).not.toBe(r.id.replace(/-/g, " "));
        }
      });

      it("every rule's two examples differ", () => {
        for (const r of pack.rules) expect(r.bad.trim(), r.id).not.toBe(r.good.trim());
      });

      it("rule ids are unique", () => {
        const ids = pack.rules.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("declares a formatter and a secrets scanner, which every pack owes", () => {
        const kinds = new Set(pack.tools.map((t) => t.kind));
        expect(kinds).toContain("formatter");
        expect(kinds).toContain("secrets");
        expect(kinds).toContain("linter");
      });

      it("names the linter's own baseline file where it has one", () => {
        // Where a linter writes its own baseline, that file is the baseline and
        // baselines.json only mirrors it. Getting this wrong means two sources
        // of truth for one count.
        const linters = pack.tools.filter((t) => t.kind === "linter");
        for (const l of linters) expect(l, l.id).toHaveProperty("native_baseline");
      });
    });
  }
});

/* ---------------------------------------------- the rules actually discriminate */

describe.skipIf(!HAVE_ESLINT)("eslint rules fail on bad and pass on good", () => {
  for (const name of ["typescript", "javascript"] as const) {
    const pack = loadPack(name);
    const tool = pack.tools.find((t) => t.id === "eslint");
    const ext = name === "typescript" ? "ts" : "js";
    const runner: ToolRunner = new EslintRunner(ROOT, ext, tool?.base_config ?? {});

    for (const rule of pack.rules.filter((r) => r.tool === "eslint")) {
      it(`${name}: ${rule.id}`, async () => {
        const verdict = await verifyRule(rule, runner);
        if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
        expect(verdict.ok).toBe(true);
      }, 60_000);
    }
  }
});

describe.skipIf(!HAVE_RUFF)("ruff rules fail on bad and pass on good", () => {
  const pack = loadPack("python");
  const runner: ToolRunner = new RuffRunner();
  for (const rule of pack.rules.filter((r) => r.tool === "ruff")) {
    it(`python: ${rule.id}`, async () => {
      const verdict = await verifyRule(rule, runner);
      if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
      expect(verdict.ok).toBe(true);
    }, 60_000);
  }
});

/* ------------------------------------------------- the verifier itself works */

describe("verifyRule", () => {
  const rule: RulePackRule = {
    id: "x", concern: "c".repeat(50), tool: "t", config: {}, bad: "bad", good: "good",
  };

  it("rejects a rule that accepts its own bad example", async () => {
    const runner: ToolRunner = { violates: async () => ({ violates: false, detail: "" }) };
    const v = await verifyRule(rule, runner);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("accepted_the_bad_example");
  });

  it("rejects a rule that fires on the dominant pattern", async () => {
    const runner: ToolRunner = { violates: async () => ({ violates: true, detail: "" }) };
    const v = await verifyRule(rule, runner);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("rejected_the_good_example");
  });

  it("accepts a rule that tells them apart", async () => {
    const runner: ToolRunner = {
      violates: async (_r, source) => ({ violates: source === "bad", detail: "" }),
    };
    expect((await verifyRule(rule, runner)).ok).toBe(true);
  });

  it("reports a tool that blows up rather than calling the rule good", async () => {
    const runner: ToolRunner = {
      violates: async () => { throw new Error("tool exploded"); },
    };
    const v = await verifyRule(rule, runner);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("tool_error");
      expect(v.detail).toContain("tool exploded");
    }
  });
});
