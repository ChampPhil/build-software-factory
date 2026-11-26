import { describe, it, expect, beforeEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runDoctor, formatReport, rolesOf, rubricsOf, referencedInWorkflows } from "../src/commands/doctor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../..");
const TEMPLATES = join(REPO, "templates");

let root: string;

/**
 * A complete factory, built from the templates the skill installs, with lock
 * files carrying gh-aw's real hashes — because an uncompiled role workflow is
 * a finding of its own, and every other test here would trip over seven of
 * them.
 */
async function install(dir: string): Promise<void> {
  mkdirSync(join(dir, ".factory"), { recursive: true });
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  cpSync(join(TEMPLATES, "definition"), join(dir, ".factory/definition"), { recursive: true });
  cpSync(join(TEMPLATES, "workflows"), join(dir, ".github/workflows"), { recursive: true });

  const { createRequire } = await import("node:module");
  const hashes = createRequire(join(REPO, "runner/src/commands/doctor.ts"))(
    "../../vendor/gh-aw/frontmatter_hash_pure.cjs",
  ) as {
    computeFrontmatterHash(p: string, o: object): Promise<string>;
    computeBodyHash(p: string, o: object): Promise<string>;
  };
  for (const role of ["triage", "brainstorm", "spec", "builder", "verifier", "gardener", "hardener", "scorer", "builder-host", "verifier-host"]) {
    const md = join(dir, `.github/workflows/factory-role-${role}.md`);
    if (!existsSync(md)) continue;
    const fm = await hashes.computeFrontmatterHash(md, {});
    const body = await hashes.computeBodyHash(md, {});
    writeFileSync(
      md.replace(/\.md$/, ".lock.yml"),
      `# gh-aw-metadata: {"frontmatter_hash":"${fm}","body_hash":"${body}"}\nname: x\non: {}\njobs: {}\n`,
    );
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bsf-doctor-"));
  await install(root);
});

const broken = (r: Awaited<ReturnType<typeof runDoctor>>) => r.findings.filter((f) => f.severity === "broken");
const details = (r: Awaited<ReturnType<typeof runDoctor>>) => r.findings.map((f) => f.detail).join(" | ");

describe("a repo with no factory", () => {
  it("is a note, not a fault — it is how the skill picks setup over update", async () => {
    const empty = mkdtempSync(join(tmpdir(), "bsf-empty-"));
    const r = await runDoctor({ root: empty });
    expect(r.installed).toBe(false);
    expect(broken(r)).toEqual([]);
    expect(details(r)).toContain("no factory yet");
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("a complete factory", () => {
  it("has nothing broken", async () => {
    const r = await runDoctor({ root });
    expect(broken(r), details(r)).toEqual([]);
    expect(r.installed).toBe(true);
  });

  it("says what it checked, so an empty report means something", async () => {
    const r = await runDoctor({ root });
    expect(r.checked).toEqual(
      expect.arrayContaining(["definition", "roles", "context", "rubrics", "guardrails", "workflows"]),
    );
  });

  it("changes nothing", async () => {
    const before = readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8");
    await runDoctor({ root });
    expect(readFileSync(join(root, ".factory/definition/factory.yaml"), "utf8")).toBe(before);
  });

  it("notes that secrets and the data ref went unchecked rather than passing them", async () => {
    // An unchecked thing reported as fine is worse than no report.
    const r = await runDoctor({ root });
    expect(details(r)).toContain("were not checked");
  });
});

describe("a broken definition", () => {
  it("catches factory.yaml that no longer parses", async () => {
    writeFileSync(join(root, ".factory/definition/factory.yaml"), "not: valid: yaml: [\n");
    const r = await runDoctor({ root });
    expect(details(r)).toContain("could not be parsed");
  });

  it("catches factory.yaml that parses but does not match its schema", async () => {
    writeFileSync(join(root, ".factory/definition/factory.yaml"), "schema: factory/1\nharness: nonsense\n");
    const r = await runDoctor({ root });
    expect(details(r)).toContain("does not match its schema");
  });

  it("offers no automatic repair for it, because the file is the user's own", async () => {
    writeFileSync(join(root, ".factory/definition/policy.yaml"), "schema: policy/1\n");
    const r = await runDoctor({ root });
    const finding = r.findings.find((f) => f.detail.includes("policy.yaml"));
    expect(finding?.repair).toBeNull();
  });

  it("catches a missing policy.yaml", async () => {
    rmSync(join(root, ".factory/definition/policy.yaml"));
    const r = await runDoctor({ root });
    expect(details(r)).toContain("policy.yaml is missing");
  });
});

describe("roles and context", () => {
  it("catches a role config missing for a role factory.yaml gives a model", async () => {
    rmSync(join(root, ".factory/definition/roles/builder.yaml"));
    const r = await runDoctor({ root });
    expect(broken(r).map((f) => f.detail).join(" ")).toContain("roles/builder.yaml is missing");
  });

  it("catches an empty context file, which is worse than a missing one", async () => {
    // The roles load it and get nothing, and nothing says why their work is poor.
    writeFileSync(join(root, ".factory/definition/context/runbook.md"), "   \n");
    const r = await runDoctor({ root });
    expect(details(r)).toContain("context/runbook.md is empty");
  });

  it("catches a missing context file", async () => {
    rmSync(join(root, ".factory/definition/context/history.md"));
    const r = await runDoctor({ root });
    expect(details(r)).toContain("context/history.md is missing");
  });

  it("catches a missing rubric for a configured pipeline", async () => {
    rmSync(join(root, ".factory/definition/rubrics/gardening.yaml"));
    const r = await runDoctor({ root });
    expect(details(r)).toContain("rubrics/gardening.yaml is missing");
  });
});

describe("guardrails", () => {
  it("is quiet when the files are simply not there yet", async () => {
    const r = await runDoctor({ root });
    expect(details(r)).not.toContain("guardrails/");
  });

  it("catches a guardrail file that no longer validates", async () => {
    // The gates read these every run, so a broken one fails every PR.
    mkdirSync(join(root, ".factory/guardrails"), { recursive: true });
    writeFileSync(
      join(root, ".factory/guardrails/coverage.json"),
      JSON.stringify({ schema: "coverage/1", floor_pct: "not a number" }),
    );
    const r = await runDoctor({ root });
    expect(broken(r).map((f) => f.detail).join(" ")).toContain("coverage.json does not match its schema");
  });

  it("catches one that is not JSON at all", async () => {
    mkdirSync(join(root, ".factory/guardrails"), { recursive: true });
    writeFileSync(join(root, ".factory/guardrails/baselines.json"), "{oops");
    const r = await runDoctor({ root });
    expect(details(r)).toContain("is not valid JSON");
  });
});

describe("workflows", () => {
  it("catches a missing trigger workflow", async () => {
    rmSync(join(root, ".github/workflows/factory-gates.yml"));
    const r = await runDoctor({ root });
    expect(details(r)).toContain("factory-gates.yml is missing");
  });

  it("catches a role prompt edited after it was compiled", async () => {
    // The lock file is what runs, so the edit is not in effect — and nothing
    // on GitHub would say so.
    const md = join(root, ".github/workflows/factory-role-spec.md");
    writeFileSync(md, `${readFileSync(md, "utf8")}\n\nan edit made after compiling\n`);
    const r = await runDoctor({ root });
    const f = broken(r).find((x) => x.detail.includes("factory-role-spec.md"));
    expect(f?.detail).toContain("body (the prompt) changed");
    expect(f?.repair).toContain("recompile");
  });

  it("catches a role workflow that was never compiled", async () => {
    rmSync(join(root, ".github/workflows/factory-role-triage.lock.yml"));
    const r = await runDoctor({ root });
    expect(details(r)).toContain("factory-role-triage.md has never been compiled");
  });

  it("treats a stale lock file as broken, since gh-aw refuses to run it", async () => {
    const lock = join(root, ".github/workflows/factory-role-spec.lock.yml");
    writeFileSync(lock, "name: x\non: {}\njobs: {}\n");
    const r = await runDoctor({ root });
    expect(broken(r).map((f) => f.detail).join(" ")).toContain("no gh-aw-metadata hashes");
  });
});

describe("what only the API can tell us", () => {
  function fakeGh(over: Partial<Record<string, unknown>> = {}) {
    return {
      repo: "owner/repo",
      get: async (path: string) => {
        if (path.includes("actions/secrets")) {
          return over["secrets"] ?? { secrets: [{ name: "FACTORY_APP_PRIVATE_KEY" }, { name: "ANTHROPIC_API_KEY" }] };
        }
        if (path.includes("actions/variables")) {
          return (
            over["variables"] ?? {
              variables: [{ name: "FACTORY_APP_CLIENT_ID" }],
            }
          );
        }
        if (path.includes("git/refs/factory/data")) {
          if (over["ref"] === "missing") throw new Error("Not Found");
          return { ref: "refs/factory/data" };
        }
        throw new Error(`unexpected ${path}`);
      },
    };
  }

  it("passes when the secrets, variables and data ref are all there", async () => {
    const r = await runDoctor({ root, gh: fakeGh() as never });
    expect(broken(r), details(r)).toEqual([]);
    expect(r.checked).toEqual(expect.arrayContaining(["secrets", "variables", "data ref"]));
  });

  it("catches a missing secret, and never offers to set it", async () => {
    // A secret's value must not pass through the runner, so there is nothing
    // it can do but say which one is missing.
    const r = await runDoctor({ root, gh: fakeGh({ secrets: { secrets: [] } }) as never });
    const f = broken(r).find((x) => x.detail.includes("ANTHROPIC_API_KEY"));
    expect(f?.repair).toBeNull();
  });

  it("catches a missing variable", async () => {
    const r = await runDoctor({ root, gh: fakeGh({ variables: { variables: [] } }) as never });
    expect(broken(r).map((f) => f.detail).join(" ")).toContain("FACTORY_APP_CLIENT_ID");
    // The sandbox secret is referenced by every role that starts a sandbox,
    // but needed only when the manifest sources a variable from it.
    expect(broken(r).map((f) => f.detail).join(" ")).not.toContain("FACTORY_SANDBOX_ENV");
    // Models are inputs read from factory.yaml now, not variables, so a repo
    // with no FACTORY_MODEL_* variables is not broken.
    expect(broken(r).map((f) => f.detail).join(" ")).not.toContain("FACTORY_MODEL");
  });

  it("calls an absent data ref degraded, since the first run creates it", async () => {
    const r = await runDoctor({ root, gh: fakeGh({ ref: "missing" }) as never });
    const f = r.findings.find((x) => x.check === "data ref");
    expect(f?.severity).toBe("degraded");
    expect(broken(r)).toEqual([]);
  });

  it("says a list could not be read rather than reporting it empty", async () => {
    const gh = {
      repo: "owner/repo",
      get: async () => {
        throw new Error("403");
      },
    };
    const r = await runDoctor({ root, gh: gh as never });
    expect(details(r)).toContain("could not be read");
    expect(broken(r)).toEqual([]);
  });
});

describe("rolesOf and rubricsOf", () => {
  it("follow the factory's own config", () => {
    expect(rolesOf({ models: { triage: "a", builder: "b" } })).toEqual(["triage", "builder"]);
    expect(rubricsOf({ pipelines: { product_work: {}, gardening: {} } })).toEqual([
      "product_work.yaml",
      "gardening.yaml",
      "shared.yaml",
    ]);
  });

  it("check everything when the config says nothing, rather than nothing", () => {
    // Silence there would hide a missing role file behind a second mistake.
    expect(rolesOf(null)).toHaveLength(7);
    expect(rolesOf({ models: {} })).toHaveLength(7);
    expect(rubricsOf(null)).toContain("product_work.yaml");
  });
});

describe("formatReport", () => {
  it("puts broken first and says plainly that nothing was changed", async () => {
    rmSync(join(root, ".github/workflows/factory-gates.yml"));
    writeFileSync(join(root, ".factory/definition/context/runbook.md"), "");
    const text = formatReport(await runDoctor({ root }));
    expect(text.indexOf("broken")).toBeLessThan(text.indexOf("degraded"));
    expect(text).toContain("Nothing has been changed");
  });

  it("says what it checked when there is nothing to report", async () => {
    const text = formatReport({ installed: true, findings: [], checked: ["definition", "workflows"] });
    expect(text).toContain("nothing wrong");
    expect(text).toContain("definition, workflows");
  });
});

describe("requirements are read from the installed workflows", () => {
  it("requires the key each role's engine actually names", () => {
    // A hardcoded list once said ANTHROPIC_API_KEY while every role asked for
    // a MODEL_API_KEY nothing created. Reading the workflows cannot disagree
    // with them.
    // beforeEach has installed the templates into root.
    const r = referencedInWorkflows(root);
    expect(r.secrets).toEqual(["ANTHROPIC_API_KEY", "FACTORY_APP_PRIVATE_KEY", "FACTORY_SANDBOX_ENV", "RECOMPILER_APP_PRIVATE_KEY"]);
    expect(r.vars).toEqual(["FACTORY_APP_CLIENT_ID", "RECOMPILER_APP_CLIENT_ID"]);
    expect(r.optionalVars).toEqual([]);
  });

  it("follows an engine swap without a map of engines to key names", () => {
    // beforeEach has installed the templates into root.
    const md = join(root, ".github/workflows/factory-role-spec.md");
    writeFileSync(md, readFileSync(md, "utf8").replace(/ANTHROPIC_API_KEY/g, "CURSOR_API_KEY"));
    expect(referencedInWorkflows(root).secrets).toContain("CURSOR_API_KEY");
  });
});

describe("variable classification", () => {
  it("treats a variable bound only to an env name as optional, anywhere else as required", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-vars-"));
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github/workflows/factory-x.yml"),
      [
        "jobs:",
        "  a:",
        "    steps:",
        "      - env:",
        "          LIMIT: ${{ vars.SOME_LIMIT }}",
        "      - with:",
        "          app-id: ${{ vars.SOME_APP }}",
      ].join("\n"),
    );
    const r = referencedInWorkflows(dir);
    expect(r.vars).toEqual(["SOME_APP"]);
    expect(r.optionalVars).toEqual(["SOME_LIMIT"]);
  });
});


describe("exec-bits", () => {
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  const commitBin = (mode: "644" | "755") => {
    mkdirSync(join(root, ".factory/bin"), { recursive: true });
    writeFileSync(join(root, ".factory/bin/bsf"), "#!/bin/sh\n");
    writeFileSync(join(root, ".factory/bin/bsf.cmd"), "@echo off\n");
    git("init", "-q");
    git("add", ".factory/bin");
    git("update-index", `--chmod=${mode === "755" ? "+x" : "-x"}`, ".factory/bin/bsf");
  };

  it("flags a launcher committed without the execute bit", async () => {
    commitBin("644");
    const r = await runDoctor({ root });
    expect(r.findings.some((f) => f.check === "exec-bits" && f.severity === "broken")).toBe(true);
    expect(details(r)).toContain(".factory/bin/bsf");
    expect(details(r)).not.toContain("bsf.cmd is");
  });

  it("is quiet when the bit is set", async () => {
    commitBin("755");
    expect((await runDoctor({ root })).findings.some((f) => f.check === "exec-bits")).toBe(false);
  });

  it("re-commits the modes with fixModes and finds nothing left", async () => {
    commitBin("644");
    const r = await runDoctor({ root, fixModes: true });
    expect(r.findings.some((f) => f.check === "exec-bits")).toBe(false);
    expect(execFileSync("git", ["ls-files", "-s", ".factory/bin/bsf"], { cwd: root, encoding: "utf8" })).toContain("100755");
  });

  it("says nothing outside a git repo", async () => {
    expect((await runDoctor({ root })).findings.some((f) => f.check === "exec-bits")).toBe(false);
  });
});
