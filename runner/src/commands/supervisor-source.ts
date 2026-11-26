/**
 * The program that keeps the app running on the runner and restarts it when a
 * file it serves from changes. It is passed to `node --input-type=module -e`,
 * so it is a string; kept in its own file so a test can run it for real.
 *
 * What it must not do is restart on its own tools' noise. Vite writes
 * `vite.config.ts.timestamp-<ms>-<hash>.mjs` into the workspace every time it
 * starts; seen as "a file changed", it restarted the app, which wrote another
 * one, and the app never stayed up long enough to answer (fix 1).
 *
 *  - Files the repository ignores (`git check-ignore`) never restart it.
 *  - Known build-tool folders and temp files never restart it.
 *  - Nothing restarts it in the first GRACE_MS after a start: build tools
 *    write their own files then.
 *  - Three restarts inside a minute is a loop: it says which file and exits 3.
 */
export const SUPERVISOR_SOURCE = String.raw`import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
const [cmd, dir] = process.argv.slice(1);
const IGNORE = /(^|\/)(\.git|node_modules|\.venv|venv|target|bin|obj|dist|build|\.next|coverage|__pycache__|\.vite|\.turbo|\.cache|\.parcel-cache|\.svelte-kit|\.nuxt|\.angular|\.factory\/sandbox)(\/|$)|\.timestamp-\d+-[0-9a-f]+\.[cm]?[jt]s$|\.log$/;
const GRACE_MS = Number(process.env.BSF_SUPERVISOR_GRACE_MS ?? 60000);
let child = null, timer = null, startedAt = 0;
let restarts = [];
const start = () => {
  child = spawn("bash", ["-c", cmd], { cwd: dir, stdio: "inherit", detached: true });
  startedAt = Date.now();
  console.log("[bsf] app started");
};
const stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch {} };
process.on("SIGTERM", () => { stop(); process.exit(0); });
const gitIgnored = (f) => spawnSync("git", ["check-ignore", "-q", "--", f], { cwd: dir }).status === 0;
const restart = (f) => {
  const now = Date.now();
  restarts = restarts.filter((t) => now - t < 60000);
  restarts.push(now);
  if (restarts.length >= 3) {
    console.log("[bsf] restart loop caused by " + f);
    stop();
    process.exit(3);
  }
  stop();
  setTimeout(start, 1500);
  console.log("[bsf] a file changed (" + f + "); restarting the app");
};
start();
watch(dir, { recursive: true }, (_e, f) => {
  if (!f || IGNORE.test(f)) return;
  if (Date.now() - startedAt < GRACE_MS) return;
  if (gitIgnored(f)) return;
  clearTimeout(timer);
  timer = setTimeout(() => restart(f), 1500);
});
`;
