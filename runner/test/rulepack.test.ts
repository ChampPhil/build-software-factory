import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { validate } from "../src/lib/schema.js";
import {
  verifyRule, EslintRunner, RuffRunner, ClippyRunner, GoVetRunner, JavacLintRunner,
  type RulePack, type RulePackRule, type ToolRunner, SemgrepRunner } from "../src/commands/rulepack.js";

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

const PACKS = ["typescript", "javascript", "python", "go", "java", "rust", "ruby", "csharp"] as const;

/**
 * Packs whose tool could not be installed where they were written, so no rule
 * has been run against it. They declare `verification: documented_not_run`,
 * and phase 3 is what checks them for real — it runs every rule's two
 * examples before installing it, and rejects one whose bad example does not
 * fire. Saying so in the pack is the point: a rule nobody has run is not the
 * same as a rule that works.
 */
const UNVERIFIED = new Set(["ruby", "csharp"]);

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
const HAVE_CARGO = have("cargo", ["--version"]);
const HAVE_GO = have("go", ["env", "GOVERSION"]);
const HAVE_JAVAC = have("javac", ["-version"]);
const HAVE_SEMGREP = have("semgrep", ["--version"]);

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

      it("declares a formatter and a linter, which every pack owes", () => {
        const kinds = new Set(pack.tools.map((t) => t.kind));
        expect(kinds).toContain("formatter");
        expect(kinds).toContain("linter");
      });

      it("declares no secret scanner, because the host already scans", () => {
        // GitHub scans pushes for secrets. The pack's own entry was never run.
        expect(pack.tools.map((t) => String(t.kind))).not.toContain("secrets");
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

describe.skipIf(!HAVE_SEMGREP)("data-flow rules fire on the path, not on the call", () => {
  for (const name of ["typescript", "python"] as const) {
    const pack = loadPack(name);
    const runner: ToolRunner = new SemgrepRunner(name);
    for (const rule of pack.rules.filter((r) => r.tool === "semgrep")) {
      it(`${name}: ${rule.id}`, async () => {
        const verdict = await verifyRule(rule, runner);
        if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
        expect(verdict.ok).toBe(true);
      }, 120_000);
    }
  }

  it("every data-flow rule's good example still calls the sink", () => {
    // The point of a taint rule is that it does not ban a useful function.
    // A good example that simply dropped the call would prove nothing — the
    // rule would pass while being indistinguishable from a ban.
    const sinkWords = /exec|subprocess|os\.system|\.query\(|\.unsafe\(/;
    for (const name of ["typescript", "python"] as const) {
      for (const rule of loadPack(name).rules.filter((r) => r.tool === "semgrep")) {
        expect(rule.good, `${name}: ${rule.id}`).toMatch(sinkWords);
      }
    }
  });
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

describe("the v1.0 languages", () => {
  it("there is a pack for each of the eight languages v1.0 names", () => {
    expect([...PACKS].sort()).toEqual([
      "csharp", "go", "java", "javascript", "python", "ruby", "rust", "typescript",
    ]);
  });

  it("a pack nobody could run says so in the file", () => {
    for (const name of PACKS) {
      const pack = loadPack(name) as RulePack & { verification?: string };
      if (UNVERIFIED.has(name)) {
        expect(pack.verification, `${name} does not declare itself unverified`).toBe(
          "documented_not_run",
        );
        expect(readFileSync(join(RULES, `${name}.yaml`), "utf8")).toContain("UNVERIFIED");
      } else {
        expect(pack.verification, `${name} claims to be unverified`).toBeUndefined();
      }
    }
  });

  it("every rule in a verified pack is covered by a live check below", () => {
    // A pack that is neither live-verified nor marked unverified would be one
    // whose rules nobody has ever run, without saying so.
    const liveTools = new Set(["eslint", "ruff", "clippy", "go-vet", "javac-lint", "semgrep"]);
    for (const name of PACKS) {
      if (UNVERIFIED.has(name)) continue;
      const pack = loadPack(name);
      for (const rule of pack.rules) {
        expect(liveTools.has(rule.tool), `${name}: ${rule.id} runs on ${rule.tool}, which nothing verifies`).toBe(true);
      }
    }
  });
});

describe.skipIf(!HAVE_CARGO)("clippy rules fail on bad and pass on good", () => {
  const pack = loadPack("rust");
  const runner: ToolRunner = new ClippyRunner();
  for (const rule of pack.rules.filter((r) => r.tool === "clippy")) {
    it(`rust: ${rule.id}`, async () => {
      const verdict = await verifyRule(rule, runner);
      if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
      expect(verdict.ok).toBe(true);
    }, 180_000);
  }
});

describe.skipIf(!HAVE_GO)("go vet rules fail on bad and pass on good", () => {
  const pack = loadPack("go");
  const runner: ToolRunner = new GoVetRunner();
  for (const rule of pack.rules.filter((r) => r.tool === "go-vet")) {
    it(`go: ${rule.id}`, async () => {
      const verdict = await verifyRule(rule, runner);
      if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
      expect(verdict.ok).toBe(true);
    }, 120_000);
  }
});

describe.skipIf(!HAVE_JAVAC)("javac lint rules fail on bad and pass on good", () => {
  const pack = loadPack("java");
  const runner: ToolRunner = new JavacLintRunner();
  for (const rule of pack.rules.filter((r) => r.tool === "javac-lint")) {
    it(`java: ${rule.id}`, async () => {
      const verdict = await verifyRule(rule, runner);
      if (!verdict.ok) throw new Error(`${verdict.reason}\n${verdict.detail}`);
      expect(verdict.ok).toBe(true);
    }, 120_000);
  }
});
