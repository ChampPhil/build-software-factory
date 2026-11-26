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
 * Exit 0 when it happened, 1 when the timeout passed first.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Poll `check` until it returns true or the timeout passes.
 * `now` and `sleep` are injectable so a test does not wait in real time.
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
