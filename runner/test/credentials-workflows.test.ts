import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(ROOT, "templates/workflows");

interface Step {
  name?: string;
  run?: string;
  uses?: string;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

describe("missing credentials are caught before a job mints a token or starts a model", () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /^factory-.*\.yml$/.test(f));

  it("every job that mints an App token has already run bsf credentials check", () => {
    const missing: string[] = [];
    for (const file of files) {
      const wf = parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        const steps = job.steps ?? [];
        const mint = steps.findIndex((s) => (s.uses ?? "").includes("actions/create-github-app-token"));
        if (mint < 0) continue;
        const checked = steps.slice(0, mint).some((s) => (s.run ?? "").includes("bsf credentials check"));
        if (!checked) missing.push(`${file}:${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every job that calls a role or the setup writer needs a job that checked the model key", () => {
    const missing: string[] = [];
    for (const file of files) {
      const wf = parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Workflow;
      for (const [name, job] of Object.entries(wf.jobs ?? {})) {
        if (!/factory-(role-|setup-agent)/.test(job.uses ?? "")) continue;
        const needed = ([] as string[]).concat(job.needs ?? []);
        const checked = needed.some((id) => {
          const parent = wf.jobs[id];
          return (parent?.steps ?? []).some((s) => /bsf credentials check --need .*\bmodel\b/.test(s.run ?? ""));
        });
        if (!checked) missing.push(`${file}:${name} (needs ${needed.join(", ") || "nothing"})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the compiled setup-agent lock still exists for callers", () => {
    expect(existsSync(join(ROOT, "templates/compiled/factory-setup-agent.lock.yml"))).toBe(true);
  });

  it("a job that only needs the App does not mention the model key", () => {
    // Reusable workflows may only name secrets they declare. A settle job
    // that only mints an App token cannot read ANTHROPIC_API_KEY.
    const leaked: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(WORKFLOWS, file), "utf8");
      const steps = text.split(/\n(?=      - name:)/);
      for (const step of steps) {
        if (!/bsf credentials check --need app\s*$/m.test(step)) continue;
        if (/bsf credentials check --need app,/.test(step)) continue;
        if (step.includes("ANTHROPIC_API_KEY")) leaked.push(file);
      }
    }
    expect(leaked).toEqual([]);
  });
});
