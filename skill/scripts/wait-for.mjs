#!/usr/bin/env node
/**
 * Wait for something to become true, without asking the person to say so.
 *
 * Setup used to stop at "tell me when you're done" and sit until the person
 * typed back, even when `gh` could see for itself that the PR had merged or
 * the App had been installed. This is the one polling rule for all of it: ask
 * every few seconds, say one line a minute so the wait does not look like a
 * hang, and exit 0 the moment the thing is true.
 *
 *   node wait-for.mjs pr-merged <number>  [--repo owner/name]
 *   node wait-for.mjs secret <NAME>       [--repo owner/name]
 *   node wait-for.mjs workflow-success <file.yml> [--repo owner/name]
 *       [--interval 5] [--timeout 600]        (seconds)
 *
 * The secret is polled every few seconds. The default interval is 5 seconds.
 * A gap of two minutes or more is a failed watch: the process exits 1 and
 * does not sit there. Exit 0 when the thing happened, 1 when the timeout
 * passed first or the gap between checks is too long.
 *
 * Key terms:
 *   - Watch: this process, left running in the background. The agent wakes
 *     when it exits. The person is not asked to type that they finished.
 *   - Gap: how long the watch sleeps between checks. A few seconds is a
 *     watch. A multi-minute gap is a failed watch.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Two minutes between checks is a failed watch. The secret is looked at every few seconds. */
export const MULTI_MINUTE_MS = 2 * 60 * 1000;

/**
 * Say whether the gap between checks is too long to be a real watch.
 *
 * The Anthropic secret is checked every few seconds. A gap of two minutes
 * or more is the failure where the secret was already saved and the watch
 * did not notice. The same rule covers a pull request watch.
 *
 * @param {number} intervalMs milliseconds between checks
 * @returns {string|null} a short error, or null when the gap is fine
 */
export function pollGapError(intervalMs) {
  if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0 || intervalMs >= MULTI_MINUTE_MS) {
    return "a multi-minute gap between checks is a failed watch; look every few seconds";
  }
  return null;
}

/**
 * Poll `check` until it returns true or the timeout passes.
 *
 * Looks every few seconds. A multi-minute gap returns false immediately
 * and does not call `check`. `now` and `sleep` are injectable so a test
 * does not wait in real time.
 *
 * @param {() => Promise<boolean> | boolean} check returns true when the thing has happened
 * @param {object} [options]
 * @param {number} [options.intervalMs] milliseconds between checks. Default 5000.
 * @param {number} [options.timeoutMs] when to give up. Default 10 minutes.
 * @param {(line: string) => void} [options.say] where the once-a-minute line goes
 * @param {string} [options.label] what the minute line says it is waiting for
 * @param {() => number} [options.now] clock, so a test can move time
 * @param {(ms: number) => Promise<void>} [options.sleep] wait, so a test does not really sleep
 * @returns {Promise<boolean>} true when `check` succeeds, false on timeout or a failed watch
 */
export async function waitFor(
  check,
  {
    intervalMs = 5000,
    timeoutMs = 600000,
    say = (line) => console.log(line),
    label = "the thing you asked for",
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  const gap = pollGapError(intervalMs);
  if (gap !== null) {
    say(gap);
    return false;
  }
  const start = now();
  let lastSaid = start;
  for (;;) {
    let ok = false;
    try {
      ok = (await check()) === true;
    } catch {
      ok = false;
    }
    if (ok) return true;
    const t = now();
    if (t - start >= timeoutMs) return false;
    if (t - lastSaid >= 60000) {
      say(`still waiting for ${label}`);
      lastSaid = t;
    }
    await sleep(intervalMs);
  }
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The checks the command line offers. Each returns a function that answers true/false. */
export function checkFor(kind, target, repo) {
  const r = repo ? ["--repo", repo] : [];
  switch (kind) {
    case "pr-merged":
      return {
        label: `PR #${target} to be merged`,
        check: () => {
          const o = JSON.parse(gh(["pr", "view", String(target), ...r, "--json", "state,mergedAt"]));
          return o.state === "MERGED" && o.mergedAt != null;
        },
      };
    case "secret":
      return {
        label: `the ${target} secret to be set`,
        check: () => JSON.parse(gh(["secret", "list", ...r, "--json", "name"])).some((s) => s.name === target),
      };
    case "workflow-success":
      return {
        label: `${target} to finish successfully`,
        check: () => {
          const runs = JSON.parse(gh(["run", "list", "--workflow", target, ...r, "--limit", "1", "--json", "status,conclusion"]));
          return runs.length > 0 && runs[0].status === "completed" && runs[0].conclusion === "success";
        },
      };
    default:
      return null;
  }
}

function parse(argv) {
  const out = { positional: [], intervalMs: 5000, timeoutMs: 600000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--interval") out.intervalMs = Number(argv[++i]) * 1000;
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]) * 1000;
    else out.positional.push(a);
  }
  return out;
}

function runningAsEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (argv1 === undefined) return false;
  const last = (p) => p.split(/[\\/]/).pop() ?? p;
  if (last(argv1) === last(fileURLToPath(moduleUrl))) return true;
  try {
    return pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (runningAsEntryPoint(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node wait-for.mjs pr-merged N | secret NAME | workflow-success FILE.yml [--repo owner/name] [--interval S] [--timeout S]\nExits 0 when it happened, 1 on timeout.");
    process.exit(0);
  }
  const a = parse(process.argv.slice(2));
  const gap = pollGapError(a.intervalMs);
  if (gap !== null) {
    console.error(gap);
    process.exit(1);
  }
  const [kind, target] = a.positional;
  const spec = kind === undefined || target === undefined ? null : checkFor(kind, target, a.repo);
  if (spec === null) {
    console.error("usage: node wait-for.mjs pr-merged N | secret NAME | workflow-success FILE.yml [--repo owner/name] [--interval S] [--timeout S]");
    process.exit(2);
  }
  console.log(`waiting for ${spec.label}…`);
  const ok = await waitFor(spec.check, { intervalMs: a.intervalMs, timeoutMs: a.timeoutMs, label: spec.label });
  console.log(ok ? `done: ${spec.label}` : `gave up waiting for ${spec.label}`);
  process.exit(ok ? 0 : 1);
}
