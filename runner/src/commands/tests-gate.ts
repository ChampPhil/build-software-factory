import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHub } from "../lib/github.js";

const exec = promisify(execFile);

/**
 * `bsf gates tests` — Gate 2's test half.
 *
 * Where the repo already has a CI check that runs its tests on the factory's
 * branches, this reads that check's result for the same commit rather than
 * running the suite again: the team's CI is the authority on whether the
 * team's tests pass, and running them twice doubles the minutes for no extra
 * information. If that check has not reported within the wait, the gate runs
 * the tests itself — a check that never arrives must not read as a pass
 * (doc 06).
 */

export interface TestsGateOptions {
  readonly gh: GitHub;
  readonly commit: string;
  /** The repo's own test check, from factory.yaml's `existing_ci.test_check`. */
  readonly existingCheck: string | null;
  /** The command to run when there is no check to read, or it never arrives. */
  readonly command: string | null;
  readonly root: string;
  /**
   * The environment to run the command in: the sandbox's closed environment.
   * Absent only in tests; the CLI always passes it.
   */
  readonly env?: Record<string, string>;
  readonly waitMs?: number;
  readonly pollMs?: number;
  /** Injected in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type TestsGateResult = {
  readonly conclusion: "success" | "failure" | "neutral";
  readonly source: "existing_check" | "ran_tests" | "no_tests";
  readonly summary: string;
  readonly detail?: string;
};

interface CheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/**
 * Whether a sandbox test command throws tests away and can still exit 0.
 *
 * A product verification that ran `pytest -k`, `--deselect`, a
 * `PYTEST_ADDOPTS` that deselects, or `--ignore` on a test directory did not
 * run the suite. That is a failed sandbox, not a pass.
 *
 * @param command - the manifest test or coverage command
 * @param env - the closed environment, where PYTEST_ADDOPTS may hide a deselect
 */
export function testCommandDropsTests(
  command: string,
  env?: Readonly<Record<string, string>>,
): string | null {
  const addopts = env?.["PYTEST_ADDOPTS"] ?? "";
  const blob = `${command}\n${addopts}`;
  if (/--deselect(?:\s|=|$)/.test(blob)) {
    return "the sandbox test command deselects tests (`--deselect`), so a green run would not be the suite";
  }
  if (/\bpytest\b/.test(blob) && /(?:^|\s)-k(?:\s|=|$)/m.test(blob)) {
    return "the sandbox test command selects a pytest subset (`-k`), so a green run would not be the suite";
  }
  if (addopts !== "" && /(?:^|\s)-k(?:\s|=|$)/.test(addopts)) {
    return "PYTEST_ADDOPTS selects a pytest subset (`-k`), so a green run would not be the suite";
  }
  if (/\bPYTEST_ADDOPTS\b=.*(?:--deselect|(?:^|\s)-k(?:\s|=))/.test(command)) {
    return "PYTEST_ADDOPTS in the test command deselects tests, so a green run would not be the suite";
  }
  const ignored = ignoredTestDirs(blob);
  if (ignored.length > 0) {
    return `the sandbox test command ignores test paths (${ignored.join(", ")}), so a green run would not be the suite`;
  }
  return null;
}

/**
 * `--ignore` and `--ignore-glob` arguments that point at a test directory or a test file.
 *
 * Ignoring `node_modules` is how a runner stays out of dependencies. Ignoring
 * `tests` is how a command exits 0 without running the suite.
 *
 * @param command - the test command plus any PYTEST_ADDOPTS text
 */
function ignoredTestDirs(command: string): string[] {
  const out: string[] = [];
  const re = /--ignore(?:-glob)?(?:=|\s+)(['"]?)(\S+)\1/g;
  for (const m of command.matchAll(re)) {
    const path = (m[2] ?? "").replace(/\\/g, "/").replace(/^['"]|['"]$/g, "");
    if (path !== "" && isTestPath(path)) out.push(path);
  }
  return out;
}

/**
 * Whether a path a command was told to skip is a test directory or a test file.
 *
 * Matches `test`, `tests`, `__tests__`, `spec`, `test_*`, `*_test.*`, and
 * `*.test.*` / `*.spec.*`. A dependency directory does not match.
 *
 * @param path - one `--ignore` or `--ignore-glob` argument
 */
function isTestPath(path: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)/i.test(path) ||
    /(?:^|\/)test_[^/]*$/.test(path) ||
    /(?:^|\/)[^/]*_test\.[^/]+$/.test(path) ||
    /(?:^|\/)[^/]*\.(?:test|spec)\.[^/]+$/.test(path)
  );
}

/**
 * Whether the manifest's test command or its coverage command drops tests.
 *
 * The coverage command replaces the test command when it is set, so a
 * deselect hiding on either one is a failed sandbox before either runs.
 *
 * @param commands - the manifest's test and coverage commands
 * @param env - the closed environment, where PYTEST_ADDOPTS may hide a deselect
 */
export function manifestDropsTests(
  commands: { readonly test?: string | null; readonly coverage?: string | null },
  env?: Readonly<Record<string, string>>,
): string | null {
  for (const command of [commands.test, commands.coverage]) {
    if (command == null || command.trim() === "") continue;
    const dropped = testCommandDropsTests(command, env);
    if (dropped !== null) return dropped;
  }
  return null;
}

export async function runTestsGate(opts: TestsGateOptions): Promise<TestsGateResult> {
  if (opts.command !== null && opts.command.trim() !== "") {
    const dropped = testCommandDropsTests(opts.command, opts.env);
    if (dropped !== null) {
      return {
        conclusion: "failure",
        source: "ran_tests",
        summary: dropped,
        detail: "The manifest's test command was not run. A command that deselects tests is a failed sandbox for product verification.",
      };
    }
  }
  if (opts.existingCheck !== null && opts.existingCheck !== "") {
    const read = await readExistingCheck(opts);
    if (read !== null) return read;
    // Fall through deliberately: the check did not report in time, so the
    // gate finds out for itself rather than assuming either answer.
  }

  if (opts.command === null || opts.command.trim() === "") {
    // A repo with no tests is a documented state, not a failure: the coverage
    // floor starts at 0 and gardening is seeded to add tests. It is neutral
    // rather than success, so nobody reads it as "the tests passed".
    return {
      conclusion: "neutral",
      source: "no_tests",
      summary: "This repo has no test command, so there was nothing to run.",
      detail:
        "Setup records this, sets the coverage floor to 0% and seeds gardening to add tests. " +
        "Until then diff coverage is the only coverage check with teeth.",
    };
  }

  return runCommand(opts);
}

async function readExistingCheck(opts: TestsGateOptions): Promise<TestsGateResult | null> {
  const waitMs = opts.waitMs ?? 15 * 60 * 1000;
  const pollMs = opts.pollMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + waitMs;

  for (;;) {
    let runs: readonly CheckRun[];
    try {
      const res = await opts.gh.get<{ readonly check_runs: readonly CheckRun[] }>(
        `repos/${opts.gh.repo}/commits/${opts.commit}/check-runs?per_page=100`,
      );
      runs = res.check_runs;
    } catch {
      return null;
    }

    const match = runs.find((c) => c.name === opts.existingCheck);
    if (match !== undefined && match.status === "completed") {
      const ok = match.conclusion === "success";
      return {
        conclusion: ok ? "success" : "failure",
        source: "existing_check",
        summary: ok
          ? `${opts.existingCheck} passed on ${opts.commit.slice(0, 8)}.`
          : `${opts.existingCheck} concluded ${match.conclusion ?? "nothing"} on ${opts.commit.slice(0, 8)}.`,
        detail: "Read from the repo's own test check rather than run again.",
      };
    }

    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

async function runCommand(opts: TestsGateOptions): Promise<TestsGateResult> {
  const command = opts.command as string;
  try {
    // Through a shell, as the manifest's other commands are: a test command
    // is often `npm ci && npm test` or carries a variable, and splitting it
    // on spaces ran the first word with the rest as its arguments.
    const { stdout, stderr } = await exec("bash", ["-c", command], {
      cwd: opts.root,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...(opts.env ?? process.env), CI: "true", NO_COLOR: "1" },
    });
    return {
      conclusion: "success",
      source: "ran_tests",
      summary: `\`${command}\` passed.`,
      detail: tail(String(stdout) + String(stderr)),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      conclusion: "failure",
      source: "ran_tests",
      summary: `\`${command}\` failed with exit ${e.code ?? "unknown"}.`,
      // The tail, not the head: a test runner's failures are at the end, and
      // this text is what goes back to the builder for the next attempt.
      detail: tail(`${e.stdout ?? ""}${e.stderr ?? ""}`),
    };
  }
}

/** The last of the output, bounded so a check summary stays postable. */
export function tail(text: string, lines = 80, maxChars = 60_000): string {
  const kept = text.split("\n").slice(-lines).join("\n");
  return kept.length <= maxChars ? kept : kept.slice(kept.length - maxChars);
}
