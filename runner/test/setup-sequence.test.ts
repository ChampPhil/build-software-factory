import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrialReport } from "../src/commands/sandbox.js";
import { SETUP_RECORD_PATH, readRecord } from "../src/commands/setup-record.js";
import { bootStep, finishStep, startStep } from "../src/commands/setup-steps.js";
import { prStep } from "../src/commands/setup-pr.js";
import { Git, type RunResult, type SetupWorld } from "../src/commands/setup-world.js";

function git(cwd: string, args: readonly string[]): void {
  const done = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@test", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
  if ((done.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed:\n${done.stdout ?? ""}${done.stderr ?? ""}`);
}

function repo(): { work: string; remote: string; git: Git } {
  const root = mkdtempSync(join(tmpdir(), "bsf-seq-"));
  const work = join(root, "work");
  const remote = join(root, "remote.git");
  mkdirSync(work);
  git(root, ["init", "--bare", remote]);
  git(work, ["init"]);
  writeFileSync(join(work, "README.md"), "app\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "-m", "init"]);
  git(work, ["branch", "-M", "main"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "origin", "HEAD:main"]);
  return { work, remote, git: new Git(work, remote) };
}

const journey = {
  name: "See home",
  how_a_person_gets_there: "/home",
  what_proves_it: "the heading Home",
  signed_in: false,
};

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "sandbox/1",
    tier: "renders",
    tier_reason: null,
    commands: { install: "true", build: "true", run: "true", test: "true" },
    app_url: "http://127.0.0.1:3000/",
    env: [],
    services: [],
    egress: [],
    stubs: [],
    dropped: [],
    capabilities: { exercised: ["home"], not_exercised: [] },
    episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
    frozen_at: "2026-11-20T00:00:00Z",
    dependencies: [{
      name: "home-page",
      kind: "other",
      stand_in: "inert",
      probe: { path: "/", signed_in: false },
      why: "the home page",
    }],
    ...over,
  };
}

function recipeJourneys(check = "home-page"): Record<string, unknown> {
  return {
    schema: "recipe-journeys/1",
    tests: { "See home": { how_the_sandbox_tests_it: "open /home", check } },
  };
}

function trial(ok: boolean): TrialReport {
  return {
    schema: "sandbox-trial/1",
    claimed: "renders",
    reached: ok ? "renders" : "static",
    steps: [],
    app_url: ok ? "http://127.0.0.1:3000/" : null,
    app_status: ok ? 200 : null,
    screenshot: ok ? "shot" : null,
    summary: ok ? "the boot met the finish line" : "the app did not start",
    probes: ok ? [{ dependency: "home-page", path: "/", signed_in: false, ok: true, detail: "200" }] : [],
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function worldOf(opts: {
  work: string;
  git: Git;
  trials: TrialReport[];
}): { world: SetupWorld; dispatches: string[]; issues: string[]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const dispatches: string[] = [];
  const issues: string[] = [];
  let t = 0;
  const world: SetupWorld = {
    root: opts.work,
    temp: join(opts.work, ".tmp"),
    defaultBranch: "main",
    runUrl: "https://example/runs/1",
    git: opts.git,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString(),
    readJson: async <T>(path: string) => (store.has(path) ? (store.get(path) as T) : null),
    updateJson: async (path, step) => {
      const current = store.has(path) ? store.get(path) : null;
      const { next, result } = step(current as never);
      store.set(path, next);
      return result;
    },
    dispatch: async (workflow) => {
      dispatches.push(workflow);
    },
    openIssueOnce: async (title) => {
      if (!issues.includes(title)) issues.push(title);
    },
    bsf: async (args) => fakeBsf(args, opts.trials),
    findSetupPull: async () => null,
    createPull: async () => 7,
    updatePull: async () => undefined,
    commentOnPull: async () => undefined,
    say: () => undefined,
    output: () => undefined,
    summary: () => undefined,
  };
  mkdirSync(join(opts.work, ".tmp"), { recursive: true });
  return { world, dispatches, issues, store };
}

function fakeBsf(args: readonly string[], trials: TrialReport[]): RunResult {
  const cmd = args.join(" ");
  if (cmd.startsWith("env scan") || cmd.startsWith("env apply")) return { code: 0, out: "every setting has a decision\n" };
  if (cmd.startsWith("env skipped")) return { code: 0, out: `${JSON.stringify({ skipped_sign_in: [] })}\n` };
  if (cmd.startsWith("env list")) return { code: 0, out: `${JSON.stringify({ names: [] })}\n` };
  if (cmd.startsWith("sandbox secrets")) {
    const file = flag(args, "file") ?? "";
    const text = file === "" ? "" : readFileSync(file, "utf8");
    if (text.includes("sk_live_")) return { code: 1, out: "pasted password in STRIPE\n" };
    return { code: 0, out: "the recipe names secrets; it does not paste them\n" };
  }
  if (cmd.startsWith("sandbox trial")) {
    const out = flag(args, "out");
    if (out === undefined) return { code: 1, out: "no --out\n" };
    const next = trials.shift() ?? trial(false);
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, `${JSON.stringify(next, null, 2)}\n`);
    return { code: 0, out: next.summary };
  }
  if (cmd.startsWith("sandbox ui-paths") || cmd.startsWith("sandbox start") || cmd.startsWith("sandbox dry-run")) {
    return { code: 0, out: "ok\n" };
  }
  if (cmd.startsWith("guardrails record")) return { code: 0, out: "baselined 0 rule(s), 0 existing violation(s)\n" };
  if (cmd.startsWith("guardrails require-zero")) return { code: 0, out: "ok\n" };
  if (cmd.startsWith("assess fundamentals")) return { code: 0, out: "fundamentals.md does not copy the house docs\n" };
  if (cmd.startsWith("report setup")) {
    const out = flag(args, "out");
    if (out !== undefined) writeFileSync(out, "Set up the software factory\n");
    return { code: 0, out: "ok\n" };
  }
  if (cmd.startsWith("report check")) return { code: 0, out: "ok\n" };
  return { code: 0, out: "" };
}

function writeRound(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  }
}

describe("the whole setup sequence, with bad writer answers, no model and no GitHub", () => {
  it("retries a bad shape, a dropped journey, a pasted password and a missed boot, then opens the pull request", { timeout: 60_000 }, async () => {
    const { work, git: gitClient } = repo();
    const trials = [trial(false), trial(true)];
    const { world, dispatches, issues, store } = worldOf({ work, git: gitClient, trials });

    expect(await startStep(world, "")).toBe(0);
    expect(dispatches).toEqual(["factory-setup-journeys.yml", "factory-setup-rules.yml"]);

    const journeysDir = join(work, "rounds", "journeys");
    writeRound(journeysDir, { "journeys.json": JSON.stringify({ schema: "journeys/1", journeys: [{ name: "See home" }] }) });
    expect(await finishStep(world, "journeys", journeysDir, "", "success")).toBe(1);
    expect(dispatches.at(-1)).toBe("factory-setup-journeys.yml");
    expect(readRecord(store.get(SETUP_RECORD_PATH), "now").last_failure?.code).toBe("shape");

    writeRound(journeysDir, { "journeys.json": `${JSON.stringify({ schema: "journeys/1", journeys: [journey] }, null, 2)}\n` });
    expect(await finishStep(world, "journeys", journeysDir, "", "success")).toBe(0);
    expect(dispatches.filter((d) => d === "factory-setup-recipe.yml")).toHaveLength(0);

    const rulesDir = join(work, "rounds", "rules");
    writeRound(rulesDir, { "guardrails.json": JSON.stringify({ installed: [], skipped: [{ rule: "none", why: "this repo has no linter yet" }] }) });
    expect(await finishStep(world, "rules", rulesDir, "", "success")).toBe(0);
    expect(dispatches.at(-1)).toBe("factory-setup-recipe.yml");

    const recipeDir = join(work, "rounds", "recipe");
    writeRound(recipeDir, {
      "manifest.json": JSON.stringify(manifest()),
      "recipe-journeys.json": JSON.stringify({ schema: "recipe-journeys/1", tests: {} }),
    });
    expect(await finishStep(world, "recipe", recipeDir, "", "success")).toBe(1);
    expect(readRecord(store.get(SETUP_RECORD_PATH), "now").last_failure?.detail ?? "").toMatch(/See home/);

    writeRound(recipeDir, {
      "manifest.json": JSON.stringify(manifest({ env: [{ name: "STRIPE", kind: "self", value: "sk_live_abc123", why: "x" }] })),
      "recipe-journeys.json": JSON.stringify(recipeJourneys()),
    });
    expect(await finishStep(world, "recipe", recipeDir, "", "success")).toBe(1);
    expect(readRecord(store.get(SETUP_RECORD_PATH), "now").last_failure?.code).toBe("password-in-recipe");

    writeRound(recipeDir, {
      "manifest.json": `${JSON.stringify(manifest(), null, 2)}\n`,
      "recipe-journeys.json": `${JSON.stringify(recipeJourneys(), null, 2)}\n`,
    });
    expect(await finishStep(world, "recipe", recipeDir, "", "success")).toBe(0);
    expect(dispatches.at(-1)).toBe("factory-setup-boot.yml");

    expect(await bootStep(world)).toBe(1);
    expect(readRecord(store.get(SETUP_RECORD_PATH), "now").last_failure?.code).toBe("boot-missed");
    expect(dispatches.at(-1)).toBe("factory-setup-recipe.yml");

    writeRound(recipeDir, {
      "manifest.json": `${JSON.stringify(manifest({ frozen_at: "2026-11-21T00:00:00Z" }), null, 2)}\n`,
      "recipe-journeys.json": `${JSON.stringify(recipeJourneys(), null, 2)}\n`,
    });
    expect(await finishStep(world, "recipe", recipeDir, "", "success")).toBe(0);
    expect(await bootStep(world)).toBe(0);
    expect(dispatches.at(-1)).toBe("factory-setup-pr.yml");

    expect(await prStep(world)).toBe(0);
    const record = readRecord(store.get(SETUP_RECORD_PATH), "now");
    expect(record.stage).toBe("done");
    expect(record.pull).toBe(7);
    expect(issues).toEqual([]);
  });
});
