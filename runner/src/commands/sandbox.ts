import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
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
    const base: Record<string, string> = {};
    for (const k of ["PATH", "HOME", "TMPDIR", "LANG", "CI", "RUNNER_TEMP"]) {
      const v = process.env[k];
      if (v !== undefined) base[k] = v;
    }
    const r = spawnSync("bash", ["-c", m.commands.install], {
      cwd: opts.workspace,
      env: { ...base, ...env },
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`install failed (exit ${r.status ?? "signal"}): ${m.commands.install}`);
  }

  return { tier: m.tier, services: m.services.map((s) => s.name), envNames: Object.keys(env).sort(), envFile: RUNTIME_ENV };
}
