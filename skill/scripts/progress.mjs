#!/usr/bin/env node
/**
 * Keep the person posted while the setup workflow runs on GitHub.
 *
 * Purpose:
 *   Polls the factory-setup workflow and prints one plain sentence the agent
 *   can relay. A long run with no line looks frozen, so this speaks when the
 *   stage changes and again every minute while the same stage continues.
 *
 * Key terms:
 *   - Live run: a factory-setup run that is still going (queued, running, or
 *     waiting). An older run that already failed is not the live run.
 *   - Stage: one job inside that run, such as reading the repo or opening
 *     the pull request. The person hears the sentence, not the job's name.
 *   - Heartbeat: the once-a-minute line. It is how a long run shows it is
 *     still alive between stage changes.
 *
 * Non-obvious behavior:
 *   - The first look does not adopt a run that has already finished. That
 *     is how a watch used to exit on an old failure before the re-run existed.
 *   - If this watch is following one run and a newer live run appears, it
 *     switches. The old run's finish is not reported as the result.
 *   - `--every` is how often it looks, in seconds. The default is 15. A gap
 *     of two minutes or more is a failed watch and the process exits 1.
 *
 *   node progress.mjs [--repo owner/name] [--every 15]
 *
 * Exits 0 when the live run completes successfully, 1 if that run fails or
 * the watch's own gap is too long.
 *
 * Exports:
 *   - JOB_LINES: the sentence for each stage.
 *   - SPEAK_EVERY_MS: how long a quiet stage may go before another line.
 *   - LIVE_STATUSES: run statuses that mean the run is still going.
 *   - currentJob: which stage is in progress.
 *   - nextLine: the sentence to print now, or none.
 *   - pickRun: which run to follow, given the recent list.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The setup workflow's jobs, in words a person wants to read.
 *
 * The workflow's own job names say Computer 0, Computer A, and Computer B.
 * Those names stay inside the workflow. The sentence a person hears is the
 * work: listing journeys, checking rules, building a private copy. Order is
 * the order the watch considers them; every job that is still going is
 * spoken, so two of those jobs running together are both named.
 */
export const JOB_LINES = {
  ready: "Checking your repository is ready",
  plan: "Reading which model the setup work will use",
  "seed-round": "Getting setup ready to start",
  "computer-0": "Reading the product to list the top journeys",
  "Computer 0. Reading the product for the top journeys": "Reading the product to list the top journeys",
  "computer-b": "Checking the standard rules against the code",
  "Computer B. Proving the standard rules": "Checking the standard rules against the code",
  "publish-journeys": "Passing the journey list on so the private copy can be built",
  "design-1": "Writing how the app starts and how each journey is tested",
  "Computer A. Writing the launch and how each journey is tested": "Writing how the app starts and how each journey is tested",
  "trial-1": "Starting a private copy and clicking through the journeys",
  "Computer A. Booting the private copy and clicking the listed journeys": "Starting a private copy and clicking through the journeys",
  "design-2": "Fixing the one journey the last try could not click",
  "Computer A. Fixing the one journey the last try could not click": "Fixing the one journey the last try could not click",
  "trial-2": "Starting the private copy and clicking through again",
  "Computer A. Booting the private copy and clicking again": "Starting the private copy and clicking through again",
  "design-3": "One last try at the journey that did not click",
  "Computer A. One last try at the journey that did not click": "One last try at the journey that did not click",
  "trial-3": "Starting the private copy for the last try",
  "Computer A. Booting the private copy and clicking the last try": "Starting the private copy for the last try",
  clean: "Cleaning until every guardrail count is zero",
  freeze: "Opening the setup pull request with the launch, the notes, and the proof",
  release: "Switching the factory on",
};

/**
 * The sentence key for a GitHub job name.
 *
 * Reusable workflows show up as "computer-0 / agent". That is still the
 * journey-list job. A name that is already one of the sentences below is
 * itself. The spoken line never includes Computer 0, Computer A, or Computer B.
 *
 * name: the job name from `gh run view`.
 */
export function jobKey(name) {
  if (JOB_LINES[name] !== undefined) return name;
  const head = name.split(" / ")[0];
  if (JOB_LINES[head] !== undefined) return head;
  for (const [key, sentence] of Object.entries(JOB_LINES)) {
    if (name === sentence || head === sentence) return key;
  }
  return null;
}

/** Speak again after this long even when the stage has not changed. */
export const SPEAK_EVERY_MS = 60 * 1000;

/**
 * Statuses that mean a factory-setup run is still going.
 * A completed run is absent on purpose: an old failure must not win.
 */
export const LIVE_STATUSES = ["queued", "in_progress", "waiting", "requested", "pending", "action_required"];

/** Two minutes between looks is a failed watch. The default look is far inside this. */
export const MAX_LOOK_SEC = 120;

/**
 * Every setup job that is still going, in the order a person would hear them.
 *
 * A completed job is skipped. Two computers running at once are both
 * returned, so the watch does not go quiet on the one it listed second.
 *
 * jobs: the jobs on the run, each with a name and a status.
 */
export function liveJobs(jobs) {
  const seen = new Set();
  const out = [];
  for (const job of jobs) {
    if (job.status === "completed") continue;
    const key = jobKey(job.name);
    if (key === null || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The job in progress, from `gh run view --json jobs`; the first not yet finished. */
export function currentJob(jobs) {
  return liveJobs(jobs)[0] ?? null;
}

/**
 * The line to print now, or null for none.
 *
 * Prints when the stage changes, and again every minute while the same
 * stage continues. A three-minute silence is a failed watch, so the quiet
 * gap is one minute. The "app just started" sentence is said once, on the
 * change into the later stage, not on every heartbeat after that.
 *
 * @param {Array<{name: string, status: string, conclusion?: string|null}>} jobs jobs on the run
 * @param {{job: string|null, at: number}} state the previous stage and when it was last spoken
 * @param {number} now milliseconds, so a test can move the clock
 * @returns {{line: string|null, state: {job: string|null, at: number}}}
 */
export function nextLine(jobs, state, now) {
  const live = liveJobs(jobs);
  if (live.length === 0) return { line: null, state };
  const job = live.join("+");
  const changed = job !== state.job;
  const due = now - state.at >= SPEAK_EVERY_MS;
  if (!changed && !due) return { line: null, state };
  // Only on the change. Repeating "just started" every minute is a lie.
  const freezeDone = jobs.some((j) => (j.name === "freeze" || jobKey(j.name) === "freeze") && j.status === "completed" && j.conclusion === "success");
  const win = changed && freezeDone ? " Your app just started in the sandbox." : "";
  const sentence = live.map((name) => `${JOB_LINES[name] ?? name}.`).join(" ");
  return { line: `${sentence}${win}`, state: { job, at: now } };
}

/**
 * Choose which factory-setup run to follow.
 *
 * GitHub's list includes old failures next to the re-run. Adopting the old
 * completed run makes the watch exit before the live run has started, which
 * is a failed watch. A run that is still going wins, newest first. On the
 * first look, a run that has already finished is not adopted. If this watch
 * was already following a run and a newer one exists, it switches.
 *
 * @param {Array<{databaseId: number, status: string}>} runs recent runs, in any order
 * @param {number|null} watchingId the run followed last time, or null if none
 * @returns {{run: {databaseId: number, status: string}|null, switched: boolean}}
 */
export function pickRun(runs, watchingId) {
  const ordered = [...runs].sort((a, b) => b.databaseId - a.databaseId);
  const live = ordered.filter((run) => LIVE_STATUSES.includes(run.status));
  if (live.length > 0) {
    const run = live[0];
    return { run, switched: watchingId !== null && watchingId !== run.databaseId };
  }
  // No live run. Move off an older id when a newer run is already in the list.
  if (watchingId !== null) {
    const newer = ordered.find((run) => run.databaseId > watchingId);
    if (newer) return { run: newer, switched: true };
    const watched = ordered.find((run) => run.databaseId === watchingId) ?? null;
    return { run: watched, switched: false };
  }
  return { run: null, switched: false };
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
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: node progress.mjs [--repo owner/name] [--every 15]\nPrints one plain sentence a minute while the live setup run is going. Exits 0 when that run succeeds, 1 if it fails.");
    process.exit(0);
  }
  const at = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const repo = at("--repo");
  const r = repo ? ["--repo", repo] : [];
  const everySec = Number(at("--every") ?? 15);
  // A multi-minute sleep cannot print a line a minute, so it is a failed watch.
  if (!Number.isFinite(everySec) || everySec <= 0 || everySec >= MAX_LOOK_SEC) {
    console.error("a multi-minute gap between checks is a failed watch; look every few seconds");
    process.exit(1);
  }
  const everyMs = everySec * 1000;
  let state = { job: null, at: 0 };
  let watchingId = null;
  for (;;) {
    try {
      const runs = JSON.parse(
        gh([
          "run",
          "list",
          "--workflow",
          "factory-setup.yml",
          ...r,
          "--limit",
          "20",
          "--json",
          "databaseId,status,conclusion",
        ]),
      );
      const picked = pickRun(runs, watchingId);
      // Forget the old stage so the next line is about the run we just joined.
      if (picked.switched) {
        console.log("Picking up the latest setup run.");
        state = { job: null, at: 0 };
      }
      if (picked.run === null) {
        const now = Date.now();
        if (state.at === 0 || now - state.at >= SPEAK_EVERY_MS) {
          console.log("The setup run has not started yet.");
          state = { job: null, at: now };
        }
      } else {
        watchingId = picked.run.databaseId;
        const run = picked.run;
        const jobs = JSON.parse(gh(["run", "view", String(run.databaseId), ...r, "--json", "jobs"])).jobs ?? [];
        const out = nextLine(jobs, state, Date.now());
        state = out.state;
        if (out.line !== null) console.log(out.line);
        // Only the run we have been following. An old completed run never reaches here on the first look.
        if (run.status === "completed") {
          console.log(
            run.conclusion === "success"
              ? "The long run on GitHub has finished."
              : "The long run on GitHub stopped. I'll repair it and run it again.",
          );
          process.exit(run.conclusion === "success" ? 0 : 1);
        }
      }
    } catch {
      /* GitHub blipped; look again next time */
    }
    await new Promise((res) => setTimeout(res, everyMs));
  }
}
