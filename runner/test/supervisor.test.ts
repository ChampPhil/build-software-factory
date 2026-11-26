import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERVISOR_SOURCE } from "../src/commands/supervisor-source.js";

/** Run the supervisor around `cmd` in `dir`; resolves with its exit code and output. */
function run(cmd: string, dir: string, ms: number, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", SUPERVISOR_SOURCE, cmd, dir], {
      env: { ...process.env, BSF_SUPERVISOR_GRACE_MS: "0", ...env },
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill("SIGTERM"), ms);
    p.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
}

describe("app supervisor (fix 1)", () => {
  it("does not restart the app for vite's temp files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    // The app writes a timestamp temp file every 300ms, like vite does.
    const app = `node -e "setInterval(()=>require('fs').writeFileSync('vite.config.ts.timestamp-'+Date.now()+'-abc123.mjs','x'),300)"`;
    const { out } = await run(app, dir, 4000);
    const starts = (out.match(/\[bsf\] app started/g) ?? []).length;
    expect(starts).toBe(1);
  }, 15000);

  it("exits 3 and names the file when a source file restarts it in a loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sup-"));
    writeFileSync(join(dir, "main.js"), "0");
    // One write per start, like a tool that rewrites its own source on boot.
    const app = `node -e "setTimeout(()=>require('fs').writeFileSync('main.js',String(Date.now())),300);setInterval(()=>{},1000)"`;
    const { code, out } = await run(app, dir, 15000);
    expect(code).toBe(3);
    expect(out).toMatch(/restart loop caused by .*main\.js/);
  }, 20000);
});
