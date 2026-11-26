#!/usr/bin/env node
/**
 * Keep the person posted while the setup workflow runs on GitHub.
 *
 * It looks at the factory-setup run every 60 seconds and prints one plain
 * sentence, only when the job in progress changes or three minutes have
 * passed since the last line. The agent relays each line as one sentence.
 *
 *   node progress.mjs [--repo owner/name] [--every 60]
 *
 * Exits 0 when the run completes, 1 if it fails.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The setup workflow's jobs, in words a person wants to read. */
export const JOB_LINES = {
  ready: "Checking your repository is ready",
  plan: "Reading your code and planning the sandbox",
  freeze: "Building and testing your sandbox, then opening the setup PR",
  release: "Switching the factory on",
};

const QUIET_MS = 3 * 60 * 1000;

/** The job in progress, from `gh run view --json jobs`; the first not yet finished. */
export function currentJob(jobs) {
  const known = Object.keys(JOB_LINES);
  const byName = new Map(jobs.map((j) => [j.name, j]));
  for (const name of known) {
    const j = byName.get(name);
    if (j !== undefined && j.status !== "completed") return name;
  }
  return null;
}

/**
 * The line to print now, or null for none. `state` is `{job, at}` from the
 * previous call. Prints on a change of job, or after three quiet minutes.
 */
export function nextLine(jobs, state, now) {
  const job = currentJob(jobs);
  if (job === null) return { line: null, state };
  const changed = job !== state.job;
  const quiet = now - state.at >= QUIET_MS;
  if (!changed && !quiet) return { line: null, state };
  const freezeDone = jobs.some((j) => j.name === "freeze" && j.status === "completed" && j.conclusion === "success");
  const win = freezeDone ? " Your app just started in the sandbox." : "";
  return { line: `${JOB_LINES[job]}.${win}`, state: { job, at: now } };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  const argv = process.argv.slice(2);
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const repo = at("--repo");
  const r = repo ? ["--repo", repo] : [];
  const everyMs = Number(at("--every") ?? 60) * 1000;
  let state = { job: null, at: 0 };
  for (;;) {
    try {
      const runs = JSON.parse(gh(["run", "list", "--workflow", "factory-setup.yml", ...r, "--limit", "1", "--json", "databaseId,status,conclusion"]));
      if (runs.length > 0) {
        const run = runs[0];
        const jobs = JSON.parse(gh(["run", "view", String(run.databaseId), ...r, "--json", "jobs"])).jobs ?? [];
        const out = nextLine(jobs, state, Date.now());
        state = out.state;
        if (out.line !== null) console.log(out.line);
        if (run.status === "completed") {
          console.log(run.conclusion === "success" ? "Setup finished on GitHub." : `Setup stopped on GitHub (${run.conclusion}).`);
          process.exit(run.conclusion === "success" ? 0 : 1);
        }
      }
    } catch {
      /* GitHub blipped; look again next time */
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
}
