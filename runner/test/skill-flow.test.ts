import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const skill = readFileSync(join(ROOT, "skill/SKILL.md"), "utf8");
const phase = (n: string) => readFileSync(join(ROOT, `skill/references/${n}`), "utf8");
const WF = join(ROOT, "templates/workflows");

describe("the skill's first message and human steps (fixes 9, 10, 11)", () => {
  it("opens with the three parts and sends the dashboard link separately", () => {
    expect(skill).toContain("What you are getting");
    expect(skill).toContain("What I'll do");
    expect(skill).toContain("What I need from you now");
    expect(skill).toContain("https://buildsoftwarefactory.com");
    expect(skill).toContain("separate\nfollow-up message");
  });

  it("front-loads the key, the App, the install and the one question, in that order", () => {
    const a = skill.indexOf("**A. The Anthropic key.**");
    const b = skill.indexOf("**B. Create the App.**");
    const c = skill.indexOf("**C. Install it.**");
    const d = skill.indexOf("**D. One question");
    expect(a).toBeGreaterThan(0);
    expect(a < b && b < c && c < d).toBe(true);
    expect(skill).toContain("settings/secrets/actions/new");
    expect(skill).toContain("ANTHROPIC_API_KEY");
    expect(skill).toContain("console.anthropic.com/settings/keys");
  });

  it("never ends a turn waiting for the person to say something it can see itself", () => {
    expect(skill).toContain("Never end a turn on \"tell me when you're done\"");
    expect(skill).toContain("scripts/wait-for.mjs");
  });
});

describe("one setup, no baselines (fixes 12, 14, 15)", () => {
  it("no skill document tells the agent to baseline", () => {
    for (const text of [skill, phase("phase-3-guardrails.md"), phase("phase-4-clean.md")]) {
      expect(/baseline everything|Baseline everything|else is baselined|rest is baselined|baselined and\s+seeded/.test(text)).toBe(false);
    }
    expect(phase("phase-3-guardrails.md")).toContain("Nothing is baselined");
    expect(phase("phase-3-guardrails.md")).toContain("local correction hook");
  });

  it("uses git rather than asking the person, and reuses a running setup", () => {
    expect(skill).toContain("git cat-file -e origin/main:assessment.md");
    expect(skill).toContain("gh run list --workflow factory-setup.yml");
    expect(skill).toContain("Duplicate of #<older>");
  });

  it("keeps the person's words as their own block and speaks as one setup", () => {
    expect(skill).toContain("Product intent (from you)");
    expect(skill).toContain('You speak as one "setup"');
  });

  it("the setup workflow merges the intent block and reuses an open setup PR", () => {
    const wf = readFileSync(join(WF, "factory-setup.yml"), "utf8");
    expect(wf).toContain("bsf context merge-intent");
    expect(wf).toContain('startswith("factory/setup-")');
    expect(wf).toContain("bsf sandbox dry-run");
    expect(wf).toContain("bsf sandbox scrub");
  });
});

describe("closing the setup (fix 18)", () => {
  it("has the formal closing message", () => {
    const p7 = phase("phase-7-switch-on.md");
    expect(p7).toContain("Setup is done. Your factory is running.");
    expect(p7).toContain("/practice");
    expect(p7).toContain("/retry");
    expect(p7).toContain("No loose ends");
  });
});

describe("launchers are executable wherever a workflow copies them (fix 13)", () => {
  it("every workflow and role prompt chmods the copied launchers before first running one", () => {
    const bad: string[] = [];
    for (const f of readdirSync(WF).filter((n) => n.endsWith(".yml") || n.endsWith(".md"))) {
      const lines = readFileSync(join(WF, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (l.includes('"$RUNNER_TEMP/bsf/bsf" --version') && !(lines[i - 1] ?? "").includes('chmod +x "$RUNNER_TEMP/bsf/"*')) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("the triage role always ends its run with a noop (fix 22)", () => {
  it("tells the agent to call noop after writing its outcome file", () => {
    const text = readFileSync(join(WF, "factory-role-triage.md"), "utf8");
    expect(text).toContain("Always end the run the same way");
    expect(text).toContain("`noop` safe output");
  });
});

describe("a held brainstorm never keeps a runner open past ten minutes (fix 22)", () => {
  it("the brainstorm role's timeout is ten minutes", () => {
    const text = readFileSync(join(WF, "factory-role-brainstorm.md"), "utf8");
    expect(/^timeout-minutes: 10$/m.test(text)).toBe(true);
  });
});

describe("only the first attempt may open a pull request (fix 19)", () => {
  it("factory-run hands the builder the existing PR number, and the builder pushes to it", () => {
    const run = readFileSync(join(WF, "factory-run.yml"), "utf8");
    expect(run).toContain("pr_number: ${{ fromJSON(inputs.reason == 'conflict' && '0' || inputs.pr_number) }}");
    const builder = readFileSync(join(WF, "factory-role-builder.md"), "utf8");
    expect(builder).toContain("Attempt 1 opens the draft PR; later attempts push to its branch.");
    expect(builder).toContain("target: ${{ inputs.pr_number }}");
  });
});
