import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { needsHost, serveOnHost, HOST_APP_PORT, type SandboxManifest } from "../src/commands/sandbox.js";

const base: SandboxManifest = {
  schema: "sandbox/1", tier: "renders",
  commands: { install: null, build: null, run: null, test: null },
  env: [], services: [],
};

describe("a sandbox that needs the runner", () => {
  it("is one with services, or stubs at a third party's own address", () => {
    expect(needsHost(base)).toBe(false);
    expect(needsHost({ ...base, services: [{ name: "db", image: "postgres", port: 5432, why: "w" }] })).toBe(true);
    expect(needsHost({ ...base, stubs: [{ name: "s", path: "p" }] })).toBe(false);
    expect(needsHost({ ...base, stubs: [{ name: "s", path: "p", hosts: ["a.example.com"], port: 4000, start: "x" }] })).toBe(true);
  });

  it("runs the app on the runner and forwards it on the one port the agent may reach", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-serve-"));
    const port = 43200 + (Date.now() % 500);
    const run = `node -e "require('http').createServer((q,r)=>r.end('hello from '+process.env.WHO)).listen(${port},'127.0.0.1')"`;
    const info = join(dir, "app.json");
    const r = await serveOnHost({
      manifest: { ...base, commands: { ...base.commands, run }, app_url: `http://127.0.0.1:${port}/` },
      workspace: dir, env: { WHO: "the sandbox" }, infoFile: info, log: () => {},
    });
    expect(r?.url).toBe(`http://host.docker.internal:${HOST_APP_PORT}/`);
    expect(JSON.parse(readFileSync(info, "utf8")).url).toBe(r?.url);
    await new Promise((res) => setTimeout(res, 500));
    const body = await (await fetch(`http://127.0.0.1:${HOST_APP_PORT}/`)).text();
    expect(body).toBe("hello from the sandbox");
  }, 60_000);
});
