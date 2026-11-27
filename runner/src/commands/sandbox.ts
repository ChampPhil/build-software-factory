import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyInterception, startStubs, type InterceptedStub } from "./stubs.js";
import { mintSession, proofComplete, runProbes, storageState, type ProbeOutcome } from "./sandbox-proof.js";
import { readCoverage, runSarifCheck } from "../lib/tools.js";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { resolveRead } from "../lib/config.js";
import { validate } from "../lib/schema.js";
import { SUPERVISOR_SOURCE } from "./supervisor-source.js";

/**
 * `bsf sandbox start` — bring up the frozen sandbox for a role.
 *
 * Replaces `.factory/sandbox/start.sh`, which the role workflows ran as a
 * free-form script. This reads the manifest in the checkout — the pull
 * request head when a change is being judged — and does only what it
 * declares. It does not read the default branch's copy, so a fix to the
 * manifest is what this run starts. Secret values still come only from
 * FACTORY_SANDBOX_ENV, not from workflow YAML.
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
    readonly coverage?: string | null;
  };
  /** Globs for the UI's files; a product-work PR touching one needs a video (fix 28). */
  readonly ui_paths?: readonly string[];
  readonly coverage_report?: { readonly path: string; readonly format: "lcov" | "cobertura" | "istanbul-summary" };
  readonly static_checks?: readonly StaticCheck[];
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
  readonly stubs?: readonly InterceptedStub[];
  readonly dependencies?: readonly Dependency[];
  readonly sign_in?: { readonly command: string; readonly why: string };
  readonly capabilities?: {
    readonly exercised: readonly string[];
    readonly not_exercised: readonly { readonly what: string; readonly paths?: readonly string[]; readonly why: string }[];
  };
}

/** Something outside the app's own code it needs, its stand-in here, and the request that proves it. */
export interface Dependency {
  readonly name: string;
  readonly kind: string;
  readonly stand_in: "test_mode" | "session" | "service" | "stub" | "inert";
  readonly probe: Probe | null;
  readonly proven?: boolean;
  readonly why: string;
}

export interface Probe {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly content_type?: string;
  readonly signed_in: boolean;
  readonly expect_text?: string;
}

/** A checker the repo's own toolchain runs, declared by setup, writing SARIF. */
export interface StaticCheck {
  readonly name: string;
  readonly command: string;
  readonly sarif: string;
  readonly why?: string;
}

export const MANIFEST_PATH = ".factory/sandbox/manifest.json";

/** Where the closed environment is written for the agent's shell to source. */
export const RUNTIME_ENV = ".factory/sandbox/.runtime.env";

export type LoadedManifest =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly errors: readonly string[] }
  | { readonly kind: "ok"; readonly manifest: SandboxManifest };

/** The manifest in this checkout, validated. Invalid is never treated as absent. */
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

/**
 * Remove a leftover container of ours by name, so starting is safe to repeat
 * (setup starts the sandbox for the baseline and again for the dry run).
 * Nothing to remove is fine.
 */
export function clearContainer(name: string): void {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
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
    throw new Error(`no ${MANIFEST_PATH} in this checkout: setup has not finished, so there is no sandbox to start`);
  }
  if (loaded.kind === "invalid") throw new Error(`${MANIFEST_PATH} is invalid:\n  ${loaded.errors.join("\n  ")}`);
  const m = loaded.manifest;

  const { env, missing } = sandboxEnv(m, opts.secretBlob);
  if (missing.length > 0) throw new Error(`the sandbox needs values that are not set: ${missing.join(", ")}`);

  for (const svc of m.services) {
    clearContainer(`bsf-${svc.name}`);
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

  // Stubs that answer at a third party's own address: names, trust, front.
  const stubDir = join(process.env["RUNNER_TEMP"] ?? tmpdir(), "bsf-stubs");
  const interception = applyInterception(stubDir, m.stubs ?? [], log);
  if (interception !== null) Object.assign(env, interception.env);
  await startStubs(m.stubs ?? [], opts.workspace, { ...shellBase(), ...env }, join(stubDir, "logs"), log);

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

  // Every boot loads the seed into this run's private data. The recipe's
  // seed command is what makes the next boot fresh. Scratch notes, if a
  // later step adds them, are not applied here.
  if (m.commands.seed) {
    log(`seeding: ${m.commands.seed}`);
    const seeded = spawnSync("bash", ["-c", m.commands.seed], {
      cwd: opts.workspace,
      env: { ...shellBase(), ...env },
      stdio: "inherit",
    });
    if (seeded.status !== 0) throw new Error(`seed failed (exit ${seeded.status ?? "signal"}): ${m.commands.seed}`);
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
  readonly step: "install" | "build" | "test" | "seed" | "run" | "screenshot" | "control";
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
  /** The coverage and static checks the candidate declared, and whether each worked. */
  readonly checks?: readonly CheckOutcome[];
  /** Whether the declared sign_in minted a session. */
  readonly sign_in?: { readonly ok: boolean; readonly detail: string };
  /** Each dependency's probe against the running app. */
  readonly probes?: readonly ProbeOutcome[];
}

export interface CheckOutcome {
  readonly kind: "coverage" | "static";
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
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
  if (failed("install") || failed("build") || failed("test") || failed("seed")) return "static";
  // The control: the same build and test, run in an empty directory, also
  // passed. Commands that pass with no code under them test nothing here.
  if (failed("control")) return "static";
  // Nothing to build or test still counts: a repo with no test suite can
  // build_and_test when it builds, and a repo with neither is static.
  if (!ran("build") && !ran("test") && !ran("install")) return "static";
  if (appOk && screenshot) return "renders";
  return "build_and_test";
}

/** A round is done when the trial reached what was claimed and proved every dependency. */
export function trialMet(t: TrialReport): boolean {
  return t.reached === t.claimed && proofComplete(t);
}

/** How much of the app a trial proved: its working probes, and sign-in. */
export function provenCount(t: TrialReport): number {
  return (t.probes ?? []).filter((p) => p.ok).length + (t.sign_in?.ok === true ? 1 : 0);
}

function tailOf(buf: Buffer | string | null | undefined, lines = 40): string {
  const text = (buf ?? "").toString();
  return text.split("\n").slice(-lines).join("\n").slice(-6000);
}

/**
 * The other loopback host for a localhost or 127.0.0.1 URL, or null when the
 * host is neither. On the GitHub runner those two names are different sockets:
 * localhost is ::1, and a server bound with -H 127.0.0.1 does not answer ::1.
 *
 * url: an absolute http(s) URL, usually the manifest's app_url.
 */
function loopbackAlternate(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
  else if (parsed.hostname === "127.0.0.1") parsed.hostname = "localhost";
  else return null;
  return parsed.toString();
}

/**
 * The HTTP status at `url`, or null when nothing accepted the connection.
 *
 * A status of 500 or higher still counts: a process is listening and the page
 * failed. Null is the only "did not answer". When the host is localhost or
 * 127.0.0.1 and the first attempt throws, the other host is tried on the same
 * port and path.
 *
 * url: the manifest's app_url, or the same URL with the other loopback host.
 */
export async function httpStatus(url: string): Promise<number | null> {
  const once = async (target: string): Promise<number | null> => {
    try {
      const r = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      return r.status;
    } catch {
      return null;
    }
  };
  const first = await once(url);
  if (first !== null) return first;
  const alt = loopbackAlternate(url);
  if (alt === null) return null;
  return once(alt);
}

/**
 * Quote a string for a single-quoted bash word. A quote inside the command
 * is closed, inserted, and reopened, which is the POSIX form that needs no
 * backslash rules.
 *
 * command: one shell command from the sandbox manifest.
 */
function shellSingleQuote(command: string): string {
  return `'${command.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The command the runner's supervisor starts, rebuilt from the repository
 * root after every file change.
 *
 * build: the manifest's commands.build, or null when the app has no build step.
 * run: the manifest's commands.run, the process that listens.
 *
 * Each half runs in its own shell that starts at the workspace. A `cd` inside
 * the build cannot leave the server in that directory.
 */
export function hostAppCommand(build: string | null, run: string): string {
  if (build === null || build.trim() === "") return run;
  return `bash -c ${shellSingleQuote(build)} && bash -c ${shellSingleQuote(run)}`;
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
      clearContainer(`bsf-${svc.name}`);
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
    if (steps.every((s) => s.ok) && (m.stubs ?? []).length > 0) {
      const stubDir = join(dirname(opts.out), "stubs");
      try {
        const interception = applyInterception(stubDir, m.stubs ?? [], log);
        if (interception !== null) Object.assign(runEnv, interception.env);
        await startStubs(m.stubs ?? [], opts.workspace, runEnv, join(stubDir, "logs"), log);
      } catch (e) {
        steps.push({ step: "install", command: "start the stubs", ok: false, exit: null, seconds: 0, tail: (e as Error).message });
      }
    }
    if (steps.every((s) => s.ok) && run("install", m.commands.install) && run("build", m.commands.build)) {
      run("test", m.commands.test);
    }
    // The seed runs after the tests and before the app starts, so the click
    // sees the private data directory the launch promised, not leftovers.
    if (steps.every((s) => s.ok) && m.commands.seed) run("seed", m.commands.seed);
    // A command can pass without exercising anything — guarded on a file the
    // repo does not have, or an echo. The same build and test are run once
    // more in an empty directory: if they pass there too, they are not
    // building or testing this repo, whatever the manifest says. Language
    // blind: it asks only whether the commands depend on the code.
    const real = [m.commands.build, m.commands.test].filter((c): c is string => c !== null);
    if (real.length > 0 && steps.every((s) => s.ok)) {
      const empty = mkdtempSync(join(tmpdir(), "bsf-control-"));
      const t0 = Date.now();
      const passedEmpty = real.every((c) => spawnSync("bash", ["-c", c], { cwd: empty, env: runEnv, encoding: "utf8", timeout: 10 * 60 * 1000 }).status === 0);
      steps.push({
        step: "control", command: real.join(" && "), ok: !passedEmpty, exit: null,
        seconds: Math.round((Date.now() - t0) / 1000),
        tail: passedEmpty
          ? "the build and test commands also pass in an empty directory, so they do not build or test this repo"
          : "the build and test commands fail in an empty directory: they depend on this repo's code",
      });
    }
  }

  // The checks the gates will run, run here first: a coverage command that
  // writes no report, or a checker that writes no SARIF, would make every
  // gate after setup fail. Whatever fails here is dropped at freeze.
  const checks: CheckOutcome[] = [];
  if (steps.every((s) => s.ok)) {
    if (m.commands.coverage != null && m.commands.coverage.trim() !== "") {
      const report = m.coverage_report;
      if (report === undefined) {
        checks.push({ kind: "coverage", name: "coverage", ok: false, detail: "commands.coverage is set but coverage_report says nowhere to read it" });
      } else {
        log(`trial coverage: ${m.commands.coverage}`);
        const r = spawnSync("bash", ["-c", m.commands.coverage], { cwd: opts.workspace, env: runEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
        const numbers = readCoverage(opts.workspace, report);
        const files = numbers === null ? 0 : Object.keys(numbers.by_file).length;
        checks.push({
          kind: "coverage", name: "coverage", ok: r.status === 0 && files > 0,
          detail: r.status !== 0
            ? `exit ${String(r.status)}: ${tailOf(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)}`
            : files === 0
              ? `no ${report.format} report with any file in it at ${report.path}`
              : `${report.format} report at ${report.path}: ${files} file(s), ${numbers?.total_pct ?? 0}% of lines`,
        });
      }
    }
    for (const check of m.static_checks ?? []) {
      log(`trial static check ${check.name}: ${check.command}`);
      const r = await runSarifCheck(opts.workspace, check, runEnv);
      const n = Object.values(r.counts).reduce((a, f) => a + Object.values(f).reduce((x, y) => x + y, 0), 0);
      checks.push({
        kind: "static", name: check.name, ok: !r.unavailable,
        detail: r.unavailable ? r.detail : `SARIF at ${check.sarif}: ${n} finding(s) across ${Object.keys(r.counts).length} rule(s)`,
      });
    }
  }

  // Start the app even when an earlier step failed. A red test used to
  // skip the listen, so the next round could not tell a broken server from
  // a test that was already wrong. Any HTTP status means a process answered.
  let appStatus: number | null = null;
  let shot: string | null = null;
  let signIn: { ok: boolean; detail: string } | undefined;
  let probes: readonly ProbeOutcome[] | undefined;
  const url = m.app_url ?? null;
  if (m.commands.run !== null && url !== null) {
    log(`trial run: ${m.commands.run}`);
    const child = spawn("bash", ["-c", m.commands.run], { cwd: opts.workspace, env: runEnv, detached: true });
    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { output += d.toString(); });
    const t0 = Date.now();
    const deadline = t0 + (opts.appWaitMs ?? 180_000);
    while (Date.now() < deadline) {
      appStatus = await httpStatus(url);
      if (appStatus !== null) break;
      if (child.exitCode !== null) break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    const answered = appStatus !== null;
    const listenNote = answered ? `the app answered ${appStatus}` : `${url} did not answer`;
    steps.push({ step: "run", command: m.commands.run, ok: answered, exit: child.exitCode,
      seconds: Math.round((Date.now() - t0) / 1000),
      tail: tailOf(`${output}\n${listenNote}`) });
    if (answered) {
      const file = join(dirname(opts.out), "screenshot.png");
      const took = (opts.screenshot ?? defaultScreenshot)(url, file);
      steps.push({ step: "screenshot", command: null, ok: took, exit: null, seconds: 0, tail: took ? file : "the screenshot could not be taken" });
      if (took) shot = file;
      // The proof that the sandbox matches the app: a session minted without
      // the identity provider, then one request per dependency.
      let cookies: Awaited<ReturnType<typeof mintSession>>["cookies"] = [];
      if (m.sign_in !== undefined) {
        log(`trial sign_in: ${m.sign_in.command}`);
        const minted = mintSession(m, opts.workspace, runEnv);
        signIn = { ok: minted.ok, detail: minted.detail };
        cookies = minted.cookies;
        log(`  ${minted.detail}`);
      }
      if ((m.dependencies ?? []).length > 0) {
        probes = await runProbes(m, url, cookies);
        for (const p of probes) log(`  probe ${p.dependency}: ${p.ok ? "ok" : "failed"}: ${p.detail}`);
      }
    }
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
  }
  // Declared but never reached, because the app did not answer: not proven.
  if (m.sign_in !== undefined && signIn === undefined) signIn = { ok: false, detail: "the app did not answer, so no session was minted" };
  if (probes === undefined && (m.dependencies ?? []).length > 0) {
    probes = (m.dependencies ?? []).map((d) => ({ dependency: d.name, path: d.probe?.path ?? "", signed_in: d.probe?.signed_in ?? false, ok: false, detail: "the app did not answer, so nothing was probed" }));
  }

  // renders still needs a page under 500 plus a screenshot. A 500 means the
  // process answered and the page failed, which is not a rendered screen.
  const reached = reachedTier(steps, appStatus !== null && appStatus < 500, shot !== null);
  const failedSteps = steps.filter((s) => !s.ok);
  const summaryBody =
    failedSteps.length === 0
      ? `reached ${reached}${reached === m.tier ? ", as claimed" : `; the manifest claimed ${m.tier}`}`
      : `reached ${reached}: ${failedSteps.map((s) => `${s.step} failed${s.command === null ? "" : ` (${s.command})`}`).join("; ")}`;
  const listen =
    m.commands.run === null || url === null
      ? ""
      : appStatus === null
        ? `; the app did not answer at ${url}`
        : `; the app answered ${appStatus}`;
  const summary = summaryBody + listen;
  const failedChecks = checks.filter((c) => !c.ok);
  const unproven = [
    ...(signIn !== undefined && !signIn.ok ? ["sign-in"] : []),
    ...(probes ?? []).filter((p) => !p.ok).map((p) => p.dependency),
  ];
  const report: TrialReport = {
    schema: "sandbox-trial/1", claimed: m.tier, reached, steps, app_url: url, app_status: appStatus,
    screenshot: shot,
    summary:
      summary +
      (failedChecks.length === 0 ? "" : `; ${failedChecks.map((c) => `${c.name} check failed`).join(", ")}`) +
      (unproven.length === 0 ? "" : `; not proven: ${unproven.join(", ")}`),
    ...(checks.length === 0 ? {} : { checks }),
    ...(signIn === undefined ? {} : { sign_in: signIn }),
    ...(probes === undefined ? {} : { probes }),
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
    // The highest tier wins; at the same tier, the round that proved more of
    // the app; on a full tie, the later round, which had more to go on.
    if (
      best === null ||
      TIER_RANK[t.reached] > TIER_RANK[best.tier] ||
      (TIER_RANK[t.reached] === TIER_RANK[best.tier] && provenCount(t) >= provenCount(best.t))
    ) {
      best = { i, tier: t.reached, m: JSON.parse(readFileSync(r.candidate, "utf8")) as Record<string, unknown>, t };
    }
  });
  if (best === null) throw new Error("no round produced a valid candidate manifest");
  const b: { i: number; tier: Tier; m: Record<string, unknown>; t: TrialReport } = best;
  const agentEpisode = Array.isArray(b.m["episode"]) ? (b.m["episode"] as { attempt: number }[]) : [];
  const next = agentEpisode.reduce((n, e) => Math.max(n, e.attempt), 0) + 1;
  // A declared check the trial could not make work is not frozen: the gates
  // would fail every PR on it. It is recorded as dropped, with what happened.
  const kept: Record<string, unknown> = { ...b.m };
  const droppedChecks: { from: string; what: string; why: string }[] = [];
  for (const c of b.t.checks ?? []) {
    if (c.ok) continue;
    if (c.kind === "coverage") {
      const commands = { ...(kept["commands"] as Record<string, unknown>) };
      droppedChecks.push({ from: "trial", what: `commands.coverage: ${String(commands["coverage"])}`, why: c.detail });
      delete commands["coverage"];
      kept["commands"] = commands;
      delete kept["coverage_report"];
    } else {
      const list = (kept["static_checks"] as { name: string; command: string }[] | undefined) ?? [];
      const gone = list.find((x) => x.name === c.name);
      kept["static_checks"] = list.filter((x) => x.name !== c.name);
      droppedChecks.push({ from: "trial", what: `static check ${c.name}: ${gone?.command ?? ""}`, why: c.detail });
    }
  }
  if (Array.isArray(kept["static_checks"]) && (kept["static_checks"] as unknown[]).length === 0) delete kept["static_checks"];
  applyProof(kept, b.t, droppedChecks);
  if (droppedChecks.length > 0) {
    kept["dropped"] = [...((kept["dropped"] as unknown[] | undefined) ?? []), ...droppedChecks];
  }
  const manifest: Record<string, unknown> = {
    ...kept,
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

/**
 * What the trial proved, written into the frozen manifest: each dependency
 * marked proven or not, every unproven one listed under not_exercised with
 * what happened, and a sign_in that minted nothing dropped, so no role is
 * told it can sign in when it cannot.
 */
export function applyProof(kept: Record<string, unknown>, t: TrialReport, dropped: { from: string; what: string; why: string }[]): void {
  const deps = (kept["dependencies"] as Dependency[] | undefined) ?? [];
  const caps = (kept["capabilities"] as { exercised: string[]; not_exercised: { what: string; paths?: string[]; why: string }[] } | undefined) ?? {
    exercised: [],
    not_exercised: [],
  };
  const notEx = [...caps.not_exercised];
  const listed = (what: string): boolean => notEx.some((n) => n.what.toLowerCase() === what.toLowerCase());
  const signInFailed = kept["sign_in"] !== undefined && t.sign_in?.ok !== true;
  if (signInFailed) {
    const si = kept["sign_in"] as { command: string };
    dropped.push({ from: "trial", what: `sign_in: ${si.command}`, why: t.sign_in?.detail ?? "it was not run" });
    delete kept["sign_in"];
    if (!listed("pages behind sign-in")) notEx.push({ what: "pages behind sign-in", why: `no session could be minted: ${t.sign_in?.detail ?? "not run"}` });
  }
  if (deps.length > 0) {
    kept["dependencies"] = deps.map((d) => {
      const p = (t.probes ?? []).find((x) => x.dependency === d.name);
      const proven = p?.ok === true;
      if (!proven && !listed(d.name)) notEx.push({ what: d.name, why: p?.detail ?? "not probed" });
      return { ...d, proven };
    });
  }
  // A capability claimed as exercised that its probe disproved is not exercised.
  const unproven = new Set(((kept["dependencies"] as Dependency[] | undefined) ?? []).filter((d) => d.proven !== true).map((d) => d.name.toLowerCase()));
  const exercised = caps.exercised.filter((e) => !unproven.has(e.toLowerCase()));
  if (deps.length > 0 || signInFailed) kept["capabilities"] = { exercised, not_exercised: notEx };
}

/* ------------------------------------------------------------- inadequacy */

export interface InadequacyReport {
  readonly role: string;
  readonly needs: string;
  readonly paths: readonly string[];
  readonly why: string;
  /**
   * True only when what is missing is something the change itself adds (a
   * test runner, a new service): the repair then waits for the change to
   * merge. Anything main's sandbox already lacks is repaired at once.
   */
  readonly needs_the_change?: boolean;
}

export function inadequacyProblems(r: unknown): readonly string[] {
  if (typeof r !== "object" || r === null) return ["the report is not an object"];
  const o = r as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["role", "needs", "why"]) {
    if (typeof o[k] !== "string" || (o[k]).trim() === "") out.push(`${k} is required`);
  }
  if (!Array.isArray(o["paths"]) || !(o["paths"] as unknown[]).every((p) => typeof p === "string")) out.push("paths is a list of file paths");
  if (o["needs_the_change"] !== undefined && typeof o["needs_the_change"] !== "boolean") out.push("needs_the_change is true or false");
  return out;
}

/** One amendment per need: the same need reported by every run must not start setup every time. */
export function inadequacyKey(r: InadequacyReport): string {
  const norm = `${r.needs.toLowerCase().replace(/\s+/g, " ").trim()}|${[...r.paths].sort().join(",")}`;
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------- host access */

/** The runner ports a host-access role may reach: the app, then up to three services. See scripts/host-variants.mjs. */
export const HOST_APP_PORT = 8787;
export const HOST_SERVICE_PORTS = [8788, 8789, 8790] as const;

/** The environment for the agent's own shell: every service address rewritten to where the container reaches it. */
export const AGENT_ENV = ".factory/sandbox/.agent.env";

/**
 * Whether the sandbox needs the runner itself: services, or stubs answering
 * at a third party's own address. Then the app is run on the runner and the
 * role uses its host-access variant to reach it.
 */
export function needsHost(m: SandboxManifest): boolean {
  // A signed-in session is minted on the runner, in the sandbox's own
  // environment, so an app with sign-in is served from there too.
  return m.services.length > 0 || (m.stubs ?? []).some((s) => (s.hosts ?? []).length > 0) || m.sign_in !== undefined;
}

/** The closed environment as the agent's container sees it: 127.0.0.1:<service> becomes host.docker.internal:<forward>. */
export function agentEnv(m: SandboxManifest, env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...env };
  m.services.slice(0, HOST_SERVICE_PORTS.length).forEach((svc, i) => {
    const to = `host.docker.internal:${HOST_SERVICE_PORTS[i]}`;
    const re = new RegExp(`(127\\.0\\.0\\.1|localhost):${svc.port}(?![0-9])`, "g");
    for (const k of Object.keys(out)) out[k] = (out[k] ?? "").replace(re, to);
  });
  return out;
}

/**
 * Bring the sandbox within the agent's reach. Each service is forwarded on
 * one of the agent's ports, and the agent's shell gets an environment that
 * points there. The app, if the manifest runs one, runs on the runner in the
 * closed environment and restarts whenever the workspace changes — the agent
 * edits the same files — so what it opens is always its latest change.
 */
export async function serveOnHost(opts: {
  readonly manifest: SandboxManifest;
  readonly workspace: string;
  readonly env: Record<string, string>;
  readonly infoFile: string;
  readonly log: (l: string) => void;
}): Promise<{ url: string | null; services: readonly string[]; appExpected: boolean; failure: string | null }> {
  const m = opts.manifest;
  // One app per runner: an app or forward left from an earlier start would
  // keep the agent's ports, and the agent would be shown the old app.
  stopServing();
  const forwards: string[] = [];
  m.services.slice(0, HOST_SERVICE_PORTS.length).forEach((svc, i) => {
    forward(HOST_SERVICE_PORTS[i] as number, svc.port);
    forwards.push(`${svc.name}: host.docker.internal:${HOST_SERVICE_PORTS[i]}`);
  });
  if (m.services.length > HOST_SERVICE_PORTS.length) {
    opts.log(`only the first ${HOST_SERVICE_PORTS.length} services are within the agent's reach; the rest run for the app only`);
  }
  writeFileSync(join(opts.workspace, AGENT_ENV), toEnvFile(agentEnv(m, opts.env)), { mode: 0o600 });
  excludeFromGit(opts.workspace, AGENT_ENV);

  const logDir = join(process.env["RUNNER_TEMP"] ?? tmpdir(), "bsf-app");
  mkdirSync(logDir, { recursive: true });
  let url: string | null = null;
  let failure: string | null = null;
  let logTail: string | null = null;
  let sessionFile: string | null = null;
  let signInNote: string | null = null;
  if (m.commands.run !== null && m.app_url != null) {
    const target = new URL(m.app_url);
    const appPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    // An app whose run command serves a build (`next start`, a compiled
    // server) needs the build first, and again after every change. Each
    // half starts in the workspace, so a cd in the build cannot move the server.
    const command = hostAppCommand(m.commands.build, m.commands.run);
    opts.log(`running the app on the runner, rebuilt and restarted on every change: ${command}`);
    const out = openSync(join(logDir, "app.log"), "a");
    const sup = spawn(process.execPath, ["--input-type=module", "-e", SUPERVISOR_SOURCE, command, opts.workspace, SUPERVISOR_MARK], {
      cwd: opts.workspace, env: { ...shellBase(), ...opts.env }, detached: true, stdio: ["ignore", out, out],
    });
    let supervisorExit: number | null = null;
    sup.on("exit", (code) => {
      supervisorExit = code ?? 1;
    });
    sup.unref();
    // Room for a build: a Next.js production build takes a minute or two. An
    // app with no build step either answers soon or is not going to.
    const deadline = Date.now() + (m.commands.build === null ? 120_000 : 480_000);
    let status: number | null = null;
    while (Date.now() < deadline) {
      status = await httpStatus(m.app_url);
      // Any status, including 500, means a process accepted the connection.
      if (status !== null) break;
      // The supervisor gave up (a restart loop): waiting longer changes nothing.
      if (supervisorExit !== null) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (status === null) {
      failure =
        supervisorExit === 3
          ? "the app restarted itself in a loop (see the log tail)"
          : `the app did not answer at ${m.app_url}`;
      opts.log(`${failure} (see ${logDir}/app.log)`);
      logTail = tailOfFile(join(logDir, "app.log"), 200);
      // The agent can only read its own folder, so the log goes there too.
      try {
        mkdirSync(dirname(opts.infoFile), { recursive: true });
        writeFileSync(join(dirname(opts.infoFile), "app.log"), logTail);
      } catch {
        /* the info file still carries the tail */
      }
    } else {
      forward(HOST_APP_PORT, appPort);
      url = `${target.protocol}//host.docker.internal:${HOST_APP_PORT}${target.pathname}${target.search}`;
      opts.log(
        status >= 500
          ? `the app answered ${status} at ${m.app_url}; the agent reaches it at ${url}`
          : `the app answers at ${m.app_url}; the agent reaches it at ${url}`,
      );
      // A signed-in session, minted here in the sandbox's environment, so
      // the agent's browser never goes to the identity provider, whose
      // pages it cannot reach. Loaded with `playwright-cli state-load`.
      if (m.sign_in !== undefined) {
        const minted = mintSession(m, opts.workspace, { ...shellBase(), ...opts.env });
        if (minted.ok) {
          sessionFile = join(dirname(opts.infoFile), "session.json");
          mkdirSync(dirname(sessionFile), { recursive: true });
          // A throwaway user in a throwaway database: readable by the agent,
          // whose container may not run as this user.
          writeFileSync(sessionFile, `${JSON.stringify(storageState(minted.cookies, "host.docker.internal"), null, 2)}\n`);
          opts.log(`signed-in session ready: ${minted.detail}`);
        } else {
          signInNote = `no signed-in session: ${minted.detail}`;
          opts.log(signInNote);
        }
      }
    }
  }
  mkdirSync(dirname(opts.infoFile), { recursive: true });
  writeFileSync(
    opts.infoFile,
    `${JSON.stringify(
      {
        url,
        services: forwards,
        env_file: AGENT_ENV,
        restarts_on_change: url !== null,
        log: join(logDir, "app.log"),
        ...(failure === null ? {} : { error: failure, log_tail: logTail }),
        session_file: sessionFile,
        ...(signInNote === null ? {} : { sign_in_problem: signInNote }),
      },
      null,
      2,
    )}\n`,
  );
  return { url, services: forwards, appExpected: m.commands.run !== null && m.app_url != null, failure };
}

/** The last `lines` lines of a file, or "" when it cannot be read. */
export function tailOfFile(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

const SUPERVISOR_MARK = "bsf-app-supervisor";
const FORWARD_MARK = "bsf-port-forward";

function forward(listen: number, to: number): void {
  spawn(process.execPath, ["--input-type=module", "-e", FORWARD_SOURCE, String(listen), String(to), FORWARD_MARK], { detached: true, stdio: "ignore" }).unref();
}

/** Stops the app and the forwards `serveOnHost` started. The supervisor takes its app down with it. */
export function stopServing(): void {
  spawnSync("pkill", ["-TERM", "-f", `${SUPERVISOR_MARK}$`]);
  spawnSync("pkill", ["-TERM", "-f", `${FORWARD_MARK}$`]);
  // Give the old listeners a moment to let go of their ports.
  spawnSync("sleep", ["0.5"]);
}

function excludeFromGit(workspace: string, path: string): void {
  const exclude = join(workspace, ".git/info/exclude");
  if (!existsSync(join(workspace, ".git"))) return;
  mkdirSync(join(workspace, ".git/info"), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!current.split("\n").includes(path)) appendFileSync(exclude, `${path}\n`);
}

const FORWARD_SOURCE = `import net from "node:net";
const [listen, to] = process.argv.slice(1).map(Number);
net.createServer((c) => { const u = net.connect(to, "127.0.0.1"); c.pipe(u).pipe(c); u.on("error", () => c.destroy()); c.on("error", () => u.destroy()); }).listen(listen, "0.0.0.0");`;

