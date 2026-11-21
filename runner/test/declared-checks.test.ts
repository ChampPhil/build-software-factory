import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countSarif, readCoverage, runSarifCheck } from "../src/lib/tools.js";
import { trialSandbox, freezeManifest } from "../src/commands/sandbox.js";
import { runCoverageGate, runStaticTools } from "../src/commands/gates-run.js";

const OWN = "test -f candidate.json";
const sarif = (root: string) => JSON.stringify({
  version: "2.1.0",
  runs: [{
    tool: { driver: { name: "pmd" } },
    originalUriBaseIds: { SRC: { uri: `file://${root}/` } },
    results: [
      { ruleId: "UnusedLocalVariable", level: "warning", message: { text: "x" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/A.java", uriBaseId: "SRC" }, region: { startLine: 3 } } }] },
      { ruleId: "UnusedLocalVariable", locations: [{ physicalLocation: { artifactLocation: { uri: `file://${root}/src/B.java` } } }] },
      { ruleId: "EmptyCatchBlock", suppressions: [{ kind: "inSource" }], locations: [{ physicalLocation: { artifactLocation: { uri: "src/A.java" } } }] },
    ],
  }],
});

describe("a checker setup declares, counted from its SARIF", () => {
  // java-service: "no static checker here applies", so the gate checked
  // nothing on every Java PR and reported it as a pass.
  it("counts per rule per file, resolves base ids and file URIs, and skips suppressed results", () => {
    const root = "/w/repo";
    const r = countSarif(root, sarif(root), "pmd");
    expect(r.unavailable).toBe(false);
    expect(r.counts).toEqual({ UnusedLocalVariable: { "src/A.java": 1, "src/B.java": 1 } });
  });

  it("is unavailable, not a pass, when the command writes no SARIF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-sarif-"));
    const r = await runSarifCheck(dir, { name: "pmd", command: "exit 3", sarif: "out.sarif" });
    expect(r.unavailable).toBe(true);
    expect(r.detail).toContain("wrote no SARIF");
  });

  it("runs in the static gate's tool set beside the checkers the factory knows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-sarif-"));
    writeFileSync(join(dir, "make-sarif.cjs"), `require('fs').writeFileSync('out.sarif', ${JSON.stringify(sarif(dir))}); process.exit(1)`);
    const { results } = await runStaticTools(dir, { checks: [{ name: "pmd", command: "node make-sarif.cjs", sarif: "out.sarif" }] });
    expect(results.map((r) => r.tool)).toContain("pmd");
  });
});

describe("a coverage report where setup declared it", () => {
  it("reads Cobertura with <source> dirs, merging a file's classes", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-cov-"));
    mkdirSync(join(dir, "src/main/java/x"), { recursive: true });
    writeFileSync(join(dir, "src/main/java/x/A.java"), "");
    writeFileSync(join(dir, "cov.xml"), `<coverage><sources><source>${dir}/src/main/java</source></sources><packages><package><classes>
      <class filename="x/A.java"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>
      <class filename="x/A.java"><lines><line number="5" hits="3"/></lines></class>
    </classes></package></packages></coverage>`);
    const c = readCoverage(dir, { path: "cov.xml", format: "cobertura" });
    expect(c?.by_file).toEqual({ "src/main/java/x/A.java": { covered: 2, total: 3 } });
  });

  it("fails the coverage gate when the declared report is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-cov-"));
    const r = await runCoverageGate({
      root: dir, changedFiles: ["a.js"], report: { path: "coverage/lcov.info", format: "lcov" },
      current: { schema: "coverage/1", floor_pct: 0 } as never,
    });
    expect(r.conclusion).toBe("failure");
  });
});

describe("setup's trial runs the declared checks, and freeze drops what failed", () => {
  function candidate(over: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "bsf-trialchk-"));
    const m = {
      schema: "sandbox/1", tier: "build_and_test", tier_reason: null,
      commands: { install: "true", build: OWN, run: null, test: OWN },
      app_url: null, env: [], services: [], egress: [], stubs: [], dropped: [],
      capabilities: { exercised: ["x"], not_exercised: [] },
      episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
      frozen_at: "2026-11-20T00:00:00Z",
      ...over,
    };
    writeFileSync(join(dir, "candidate.json"), JSON.stringify(m));
    return dir;
  }

  it("keeps a coverage command that writes its report and drops a checker that writes no SARIF", async () => {
    const dir = candidate({
      commands: { install: "true", build: OWN, run: null, test: OWN, coverage: `${OWN} && mkdir -p coverage && printf 'SF:a.js\\nDA:1,1\\nDA:2,0\\nend_of_record\\n' > coverage/lcov.info` },
      coverage_report: { path: "coverage/lcov.info", format: "lcov" },
      static_checks: [{ name: "pmd", command: "true", sarif: "pmd.sarif", why: "w" }],
    });
    const out = join(dir, "trial.json");
    const t = await trialSandbox({ manifestPath: join(dir, "candidate.json"), workspace: dir, out, log: () => {} });
    expect(t.checks?.map((c) => [c.name, c.ok])).toEqual([["coverage", true], ["pmd", false]]);
    expect(t.reached).toBe("build_and_test");
    const { manifest } = freezeManifest([{ candidate: join(dir, "candidate.json"), trial: out }], "2026-11-21T00:00:00Z");
    expect((manifest["commands"] as Record<string, unknown>)["coverage"]).toBeDefined();
    expect(manifest["static_checks"]).toBeUndefined();
    expect(JSON.stringify(manifest["dropped"])).toContain("static check pmd");
    expect(readFileSync(out, "utf8")).toContain("pmd check failed");
  });
});
