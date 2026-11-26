import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { startSandbox } from "../src/commands/sandbox.js";

// A fake `docker` that records every call and, like the real one, refuses to
// run a name that is already in use unless it was removed first.
describe("starting the sandbox twice in one job", () => {
  it("removes the earlier container first, so the dry run does not hit a name conflict", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const addr = srv.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const bin = mkdtempSync(join(tmpdir(), "bsf-fakedocker-"));
    const state = join(bin, "state");
    writeFileSync(state, "");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/bash
echo "$@" >> "${bin}/calls"
if [ "$1" = "rm" ]; then : > "${state}"; exit 0; fi
if [ "$1" = "run" ]; then
  if [ -s "${state}" ]; then echo "Conflict. The container name is already in use" >&2; exit 125; fi
  echo up > "${state}"; exit 0
fi
exit 0
`,
    );
    chmodSync(join(bin, "docker"), 0o755);

    const dir = mkdtempSync(join(tmpdir(), "bsf-sbx-"));
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".factory/sandbox"), { recursive: true });
    writeFileSync(
      join(dir, ".factory/sandbox/manifest.json"),
      JSON.stringify({
        schema: "sandbox/1",
        tier: "renders",
        tier_reason: null,
        commands: { install: null, build: null, run: null, test: null },
        env: [],
        egress: [],
        stubs: [],
        dropped: [],
        capabilities: { exercised: ["x"], not_exercised: [] },
        episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
        frozen_at: "2026-11-20T00:00:00Z",
        services: [{ name: "postgres", image: "postgres:16", port, env: {}, why: "the app stores data" }],
      }),
    );

    const oldPath = process.env["PATH"];
    process.env["PATH"] = `${bin}:${oldPath ?? ""}`;
    try {
      await startSandbox({ root: dir, workspace: dir, log: () => {} });
      await startSandbox({ root: dir, workspace: dir, log: () => {} });
    } finally {
      process.env["PATH"] = oldPath;
      srv.close();
    }
    const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
    expect(calls.filter((c) => c.startsWith("run ")).length).toBe(2);
    expect(calls.filter((c) => c === "rm -f bsf-postgres").length).toBe(2);
  });
});
