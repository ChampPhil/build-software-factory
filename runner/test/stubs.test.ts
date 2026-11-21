import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interceptionProblems, routesOf } from "../src/commands/stubs.js";
import { trialSandbox } from "../src/commands/sandbox.js";

const stub = { name: "sheets", path: "stubs/sheets", hosts: ["sheets.googleapis.com"], port: 47011, start: "node s.mjs" };

describe("stubs at a third party's own address", () => {
  it("needs a port and a start command for the hosts it claims, and one owner per host", () => {
    expect(interceptionProblems([stub])).toEqual([]);
    const { port: _port, ...noPort } = stub;
    expect(interceptionProblems([noPort])[0]).toContain("no port");
    expect(interceptionProblems([stub, { ...stub, name: "other" }])[0]).toContain("claimed by both");
    expect(interceptionProblems([{ ...stub, hosts: ["not a host"] }])[0]).toContain("not a hostname");
  });

  it("routes each host to its stub's port", () => {
    expect(routesOf([stub, { name: "x", path: "p" }])).toEqual({ "sheets.googleapis.com": 47011 });
  });

  // Changes /etc/hosts and the trust store and binds 443, so only where a
  // runner may: GitHub's runners and this kind of container.
  const canIntercept = spawnSync("sudo", ["-n", "true"]).status === 0 && spawnSync("openssl", ["version"]).status === 0;
  it.skipIf(!canIntercept)("Node, curl and Python all reach the stub over HTTPS at the real hostname", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-stub-"));
    mkdirSync(join(dir, "stubs"), { recursive: true });
    writeFileSync(join(dir, "stubs/s.mjs"), `import http from "node:http"; http.createServer((q, r) => r.end(JSON.stringify({ stub: true, path: q.url }))).listen(Number(process.env.PORT), "127.0.0.1");`);
    writeFileSync(join(dir, "marker"), "");
    const host = `bsf-test-${Date.now()}.example.com`;
    const m = {
      schema: "sandbox/1", tier: "build_and_test", tier_reason: null,
      commands: {
        install: null,
        build: `test -f marker && node -e "fetch('https://${host}/a').then(r=>r.json()).then(j=>process.exit(j.stub?0:1))"`,
        run: null,
        test: `test -f marker && curl -sf https://${host}/b && python3 -c "import urllib.request,json;assert json.load(urllib.request.urlopen('https://${host}/c'))['stub']"`,
      },
      app_url: null, env: [], services: [], egress: [], dropped: [],
      stubs: [{ name: "fake", replaces: "an API", path: "stubs", captured_from: "its docs", captured_at: "2026-11-21T00:00:00Z", hosts: [host], port: 47000 + (Date.now() % 900), start: "node stubs/s.mjs" }],
      capabilities: { exercised: ["x"], not_exercised: [] },
      episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
      frozen_at: "2026-11-21T00:00:00Z",
    };
    writeFileSync(join(dir, "m.json"), JSON.stringify(m));
    const r = await trialSandbox({ manifestPath: join(dir, "m.json"), workspace: dir, out: join(dir, "trial.json"), log: () => {} });
    expect(r.steps.filter((s) => s.step !== "control").map((s) => [s.step, s.ok])).toEqual([["install", true], ["build", true], ["test", true]]);
    expect(r.reached).toBe("build_and_test");
  }, 120_000);
});
