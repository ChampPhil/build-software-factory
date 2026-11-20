import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { resolveRead } from "../lib/config.js";
import { validate } from "../lib/schema.js";

/**
 * `bsf sandbox start` — bring up the frozen sandbox for a role.
 *
 * Replaces `.factory/sandbox/start.sh`, which the role workflows ran from the
 * workspace: on a retry that is the PR branch, so a free-form script from the
 * change under judgement ran before the agent did. This reads the manifest
 * from the default branch and does only what it declares.
 */

export interface SandboxManifest {
  readonly schema: "sandbox/1";
  readonly tier: "renders" | "build_and_test" | "static";
  readonly commands: {
    readonly install: string | null;
    readonly build: string | null;
    readonly run: string | null;
    readonly test: string | null;
    readonly seed?: string | null;
  };
  readonly app_url?: string | null;
  readonly env: readonly {
    readonly name: string;
    readonly kind: string;
    readonly value?: string;
    readonly secret?: string;
    readonly why: string;
  }[];
  readonly services: readonly {
    readonly name: string;
    readonly image: string;
    readonly port: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly why: string;
  }[];
}

export const MANIFEST_PATH = ".factory/sandbox/manifest.json";

/** Where the closed environment is written for the agent's shell to source. */
export const RUNTIME_ENV = ".factory/sandbox/.runtime.env";

export type LoadedManifest =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  | { readonly kind: "ok"; readonly manifest: SandboxManifest };

/** The manifest from the trusted root, validated. Invalid is never treated as absent. */
export function loadManifest(root: string): LoadedManifest {
  return loadManifestAt(resolveRead(root, MANIFEST_PATH));
}

/** A manifest at an explicit path, validated. */
export function loadManifestAt(path: string): LoadedManifest {
  if (!existsSync(path)) return { kind: "missing" };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "invalid", errors: [`not JSON: ${(e as Error).message}`] };
  }
  const r = validate("sandbox", doc);
  if (!r.ok) return { kind: "invalid", errors: r.errors.map((e) => `${e.path} ${e.message}`) };
  return { kind: "ok", manifest: doc as SandboxManifest };
}

/** Parse a dotenv blob. Used for the one secret that carries test-mode keys. */
/** What a shell needs to find tools, and nothing else from the runner. */
export function shellBase(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "CI", "RUNNER_TEMP"]) {
    const v = process.env[k];
    if (v !== undefined) base[k] = v;
  }
  return base;
}

/**
 * The environment a gate runs the app's own commands in: the sandbox's
 * closed environment, as `bsf sandbox start` wrote it, over the shell base.
 * Null when the sandbox was not started here, so the caller can say so.
 */
export function closedEnv(workspace: string): Record<string, string> | null {
  const file = join(workspace, RUNTIME_ENV);
  if (!existsSync(file)) return null;
  return { ...shellBase(), ...parseDotenv(readFileSync(file, "utf8")) };
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1] === undefined || line.trim().startsWith("#")) continue;
    let v = m[2] ?? "";
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/**
 * The sandbox's whole environment: exactly the manifest's variables.
 *
 * A variable whose value comes from a secret is looked up in one repository
 * secret, FACTORY_SANDBOX_ENV, a dotenv blob. One fixed name, because a
 * workflow can only pass secrets it names, and per-repo secret names would
 * mean generating a different workflow for every repo.
 */
export function sandboxEnv(
  manifest: SandboxManifest,
  secretBlob: string | undefined,
): { readonly env: Record<string, string>; readonly missing: readonly string[] } {
  const secrets = secretBlob === undefined ? {} : parseDotenv(secretBlob);
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const v of manifest.env) {
    if (v.value !== undefined) env[v.name] = v.value;
    else if (v.secret !== undefined) {
      const s = secrets[v.secret];
      if (s === undefined) missing.push(`${v.name} (from ${v.secret} in FACTORY_SANDBOX_ENV)`);
      else env[v.name] = s;
    }
  }
  return { env, missing };
}

/** A shell-safe `export NAME='value'` file the agent's shell can source. */
export function toEnvFile(env: Readonly<Record<string, string>>): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'"'"'`)}'`;
  return Object.keys(env)
    .sort()
    .map((k) => `export ${k}=${q(env[k] ?? "")}`)
    .join("\n") + "\n";
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.setTimeout(1000);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
    s.once("timeout", () => { s.destroy(); resolve(false); });
  });
}

export interface StartReport {
  readonly tier: string;
  readonly services: readonly string[];
  readonly envNames: readonly string[];
  readonly envFile: string;
}

export async function startSandbox(opts: {
  readonly root: string;
  readonly workspace: string;
  readonly secretBlob?: string;
  readonly log?: (line: string) => void;
}): Promise<StartReport> {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const loaded = loadManifest(opts.root);
  if (loaded.kind === "missing") {
    throw new Error(`no ${MANIFEST_PATH} on the default branch: setup has not finished, so there is no sandbox to start`);
  }
  if (loaded.kind === "invalid") throw new Error(`${MANIFEST_PATH} is invalid:\n  ${loaded.errors.join("\n  ")}`);
  const m = loaded.manifest;

  const { env, missing } = sandboxEnv(m, opts.secretBlob);
  if (missing.length > 0) throw new Error(`the sandbox needs values that are not set: ${missing.join(", ")}`);

  for (const svc of m.services) {
    const args = ["run", "-d", "--rm", "--name", `bsf-${svc.name}`, "-p", `127.0.0.1:${svc.port}:${svc.port}`];
    for (const [k, v] of Object.entries(svc.env ?? {})) args.push("-e", `${k}=${v}`);
    args.push(svc.image);
    log(`starting ${svc.name} (${svc.image}) on ${svc.port}`);
    execFileSync("docker", args, { stdio: "inherit" });
    const deadline = Date.now() + 90_000;
    while (!(await portOpen(svc.port))) {
      if (Date.now() > deadline) throw new Error(`${svc.name} did not open port ${svc.port} within 90s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Written into the workspace so the agent's shell can source it, and kept
  // out of every commit by the repo's own exclude file, so a value can never
  // ride along in a diff.
  const file = join(opts.workspace, RUNTIME_ENV);
  mkdirSync(join(opts.workspace, ".factory/sandbox"), { recursive: true });
  writeFileSync(file, toEnvFile(env), { mode: 0o600 });
  const exclude = join(opts.workspace, ".git/info/exclude");
  if (existsSync(join(opts.workspace, ".git"))) {
    mkdirSync(join(opts.workspace, ".git/info"), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!current.split("\n").includes(RUNTIME_ENV)) appendFileSync(exclude, `${RUNTIME_ENV}\n`);
  }

  if (m.commands.install !== null) {
    log(`installing: ${m.commands.install}`);
    // Only the manifest's variables, plus what a shell needs to find tools.
    // Nothing else from the runner's environment, so a missed variable is
    // absent rather than inherited.
    const base = shellBase();
    const r = spawnSync("bash", ["-c", m.commands.install], {
      cwd: opts.workspace,
      env: { ...base, ...env },
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`install failed (exit ${r.status ?? "signal"}): ${m.commands.install}`);
  }

  return { tier: m.tier, services: m.services.map((s) => s.name), envNames: Object.keys(env).sort(), envFile: RUNTIME_ENV };
}

/* ========================================================================== *
 * Trial: run a candidate manifest and measure the tier it actually reaches
 * ========================================================================== */

export type Tier = "renders" | "build_and_test" | "static";

const TIER_RANK: Record<Tier, number> = { static: 0, build_and_test: 1, renders: 2 };

export function tierAtLeast(a: Tier, b: Tier): boolean {
  return TIER_RANK[a] >= TIER_RANK[b];
}

export interface StepOutcome {
  readonly step: "install" | "build" | "test" | "run" | "screenshot";
  readonly command: string | null;
  readonly ok: boolean;
  readonly exit: number | null;
  readonly seconds: number;
  /** The last lines of output: what the agent reads to decide what to change. */
  readonly tail: string;
}

export interface TrialReport {
  readonly schema: "sandbox-trial/1";
  readonly claimed: Tier;
  readonly reached: Tier;
  readonly steps: readonly StepOutcome[];
  readonly app_url: string | null;
  readonly app_status: number | null;
  readonly screenshot: string | null;
  /** One line for a person: what happened, in the order it happened. */
  readonly summary: string;
}

/**
 * The tier the measured steps support. Mechanical, so the agent's claim is
 * checked rather than believed: build_and_test needs every declared install,
 * build and test command to pass; renders needs that, plus the app answering
 * at its URL and a screenshot of it.
 */
export function reachedTier(steps: readonly StepOutcome[], appOk: boolean, screenshot: boolean): Tier {
  const failed = (s: StepOutcome["step"]): boolean => steps.some((x) => x.step === s && !x.ok);
  const ran = (s: StepOutcome["step"]): boolean => steps.some((x) => x.step === s && x.command !== null);
  if (failed("install") || failed("build") || failed("test")) return "static";
  // Nothing to build or test still counts: a repo with no test suite can
  // build_and_test when it builds, and a repo with neither is static.
  if (!ran("build") && !ran("test") && !ran("install")) return "static";
  if (appOk && screenshot) return "renders";
  return "build_and_test";
}

function tailOf(buf: Buffer | string | null | undefined, lines = 40): string {
  const text = (buf ?? "").toString();
  return text.split("\n").slice(-lines).join("\n").slice(-6000);
}

async function httpStatus(url: string): Promise<number | null> {
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    return r.status;
  } catch {
    return null;
  }
}

export async function trialSandbox(opts: {
  readonly manifestPath: string;
  readonly workspace: string;
  readonly out: string;
  readonly secretBlob?: string;
  readonly appWaitMs?: number;
  readonly screenshot?: (url: string, file: string) => boolean;
  readonly log?: (line: string) => void;
}): Promise<TrialReport> {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const loaded = loadManifestAt(opts.manifestPath);
  if (loaded.kind !== "ok") {
    const why = loaded.kind === "missing" ? "the candidate manifest was not written" : `the candidate manifest is invalid: ${loaded.errors.join("; ")}`;
    const report: TrialReport = {
      schema: "sandbox-trial/1", claimed: "static", reached: "static", steps: [], app_url: null,
      app_status: null, screenshot: null, summary: why,
    };
    writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  const m = loaded.manifest;
  const steps: StepOutcome[] = [];

  const { env, missing } = sandboxEnv(m, opts.secretBlob);
  const runEnv = { ...shellBase(), ...env };

  const run = (step: StepOutcome["step"], command: string | null): boolean => {
    if (command === null) {
      steps.push({ step, command: null, ok: true, exit: null, seconds: 0, tail: "" });
      return true;
    }
    log(`trial ${step}: ${command}`);
    const t0 = Date.now();
    const r = spawnSync("bash", ["-c", command], {
      cwd: opts.workspace, env: runEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
    });
    const ok = r.status === 0;
    steps.push({
      step, command, ok, exit: r.status, seconds: Math.round((Date.now() - t0) / 1000),
      tail: tailOf(`${r.stdout ?? ""}\n${r.stderr ?? ""}`),
    });
    return ok;
  };

  if (missing.length > 0) {
    steps.push({ step: "install", command: null, ok: false, exit: null, seconds: 0, tail: `values not set: ${missing.join(", ")}` });
  } else {
    for (const svc of m.services) {
      const args = ["run", "-d", "--rm", "--name", `bsf-${svc.name}`, "-p", `127.0.0.1:${svc.port}:${svc.port}`];
      for (const [k, v] of Object.entries(svc.env ?? {})) args.push("-e", `${k}=${v}`);
      args.push(svc.image);
      const r = spawnSync("docker", args, { encoding: "utf8" });
      let up = r.status === 0;
      const deadline = Date.now() + 90_000;
      while (up && !(await portOpen(svc.port))) {
        if (Date.now() > deadline) { up = false; break; }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!up) {
        steps.push({ step: "install", command: `docker run ${svc.image}`, ok: false, exit: r.status, seconds: 0,
          tail: tailOf(`${r.stdout ?? ""}\n${r.stderr ?? ""}\n${svc.name} did not open port ${svc.port}`) });
      }
    }
    if (steps.every((s) => s.ok) && run("install", m.commands.install) && run("build", m.commands.build)) {
      run("test", m.commands.test);
    }
  }

  // Start the app and see whether it answers.
  let appStatus: number | null = null;
  let shot: string | null = null;
  const url = m.app_url ?? null;
  if (steps.every((s) => s.ok) && m.commands.run !== null && url !== null) {
    log(`trial run: ${m.commands.run}`);
    const child = spawn("bash", ["-c", m.commands.run], { cwd: opts.workspace, env: runEnv, detached: true });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    const t0 = Date.now();
    const deadline = t0 + (opts.appWaitMs ?? 180_000);
    while (Date.now() < deadline) {
      appStatus = await httpStatus(url);
      if (appStatus !== null && appStatus < 500) break;
      if (child.exitCode !== null) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    const answered = appStatus !== null && appStatus < 500;
    steps.push({ step: "run", command: m.commands.run, ok: answered, exit: child.exitCode,
      seconds: Math.round((Date.now() - t0) / 1000),
      tail: tailOf(answered ? output : `${output}\n${url} answered ${appStatus ?? "nothing"}`) });
    if (answered) {
      const file = join(dirname(opts.out), "screenshot.png");
      const took = (opts.screenshot ?? defaultScreenshot)(url, file);
      steps.push({ step: "screenshot", command: null, ok: took, exit: null, seconds: 0, tail: took ? file : "the screenshot could not be taken" });
      if (took) shot = file;
    }
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }

  const reached = reachedTier(steps, appStatus !== null && appStatus < 500, shot !== null);
  const failedStep = steps.find((s) => !s.ok);
  const summary =
    failedStep === undefined
      ? `reached ${reached}${reached === m.tier ? ", as claimed" : `; the manifest claimed ${m.tier}`}`
      : `reached ${reached}: ${failedStep.step} failed${failedStep.command === null ? "" : ` (${failedStep.command})`}`;
  const report: TrialReport = {
    schema: "sandbox-trial/1", claimed: m.tier, reached, steps, app_url: url, app_status: appStatus,
    screenshot: shot, summary,
  };
  writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
  log(summary);
  return report;
}

/** Playwright's own CLI, which every runner can fetch; no dependency of ours. */
function defaultScreenshot(url: string, file: string): boolean {
  const install = spawnSync("npx", ["-y", "playwright@1", "install", "--with-deps", "chromium"], { stdio: "inherit" });
  if (install.status !== 0) return false;
  const r = spawnSync("npx", ["-y", "playwright@1", "screenshot", "--full-page", "--wait-for-timeout", "2000", url, file], { stdio: "inherit" });
  return r.status === 0 && existsSync(file);
}

/* ========================================================================== *
 * Freeze: the manifest that lands, from the best measured round
 * ========================================================================== */

export interface Round {
  readonly candidate: string;
  readonly trial: string;
}

/**
 * Pick the round whose trial reached the highest tier (the latest one on a
 * tie, since later rounds had more to go on) and write its manifest with the
 * tier the trial measured. The agent's claim is replaced by what happened.
 */
export function freezeManifest(rounds: readonly Round[], now: string): {
  readonly manifest: Record<string, unknown>;
  readonly chosen: number;
} {
  let best: { i: number; tier: Tier; m: Record<string, unknown>; t: TrialReport } | null = null;
  const trials: TrialReport[] = [];
  rounds.forEach((r, i) => {
    let t: TrialReport;
    try { t = JSON.parse(readFileSync(r.trial, "utf8")) as TrialReport; } catch { return; }
    trials.push(t);
    const loaded = loadManifestAt(r.candidate);
    if (loaded.kind !== "ok") return;
    if (best === null || TIER_RANK[t.reached] >= TIER_RANK[best.tier]) {
      best = { i, tier: t.reached, m: JSON.parse(readFileSync(r.candidate, "utf8")) as Record<string, unknown>, t };
    }
  });
  if (best === null) throw new Error("no round produced a valid candidate manifest");
  const b: { i: number; tier: Tier; m: Record<string, unknown>; t: TrialReport } = best;
  const agentEpisode = Array.isArray(b.m["episode"]) ? (b.m["episode"] as { attempt: number }[]) : [];
  const next = agentEpisode.reduce((n, e) => Math.max(n, e.attempt), 0) + 1;
  const manifest: Record<string, unknown> = {
    ...b.m,
    tier: b.tier,
    tier_reason:
      b.tier === "renders" ? null : b.t.claimed === b.tier ? (b.m["tier_reason"] ?? b.t.summary) : `measured: ${b.t.summary}`,
    episode: [
      ...agentEpisode,
      ...trials.map((t, k) => ({
        attempt: next + k,
        tried: `trial of round ${k + 1}: ${t.steps.filter((s) => s.command !== null).map((s) => s.step).join(", ") || "nothing to run"}`,
        observed: t.summary,
        changed: null,
      })),
    ],
    frozen_at: now,
  };
  const v = validate("sandbox", manifest);
  if (!v.ok) throw new Error(`the frozen manifest is invalid: ${v.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
  return { manifest, chosen: b.i };
}
