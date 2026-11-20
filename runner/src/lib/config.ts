import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertValid } from "./schema.js";
import type { Policy, Baselines, Coverage } from "./types.js";

/**
 * Loading the factory's own configuration.
 *
 * The gates load `policy.yaml` from the default branch, never from the PR,
 * which is what stops a PR changing the rules that judge it. Everything here
 * is validated on read.
 */

export const DEFINITION_DIR = ".factory/definition";
export const GUARDRAILS_DIR = ".factory/guardrails";

export const POLICY_PATH = `${DEFINITION_DIR}/policy.yaml`;
export const FACTORY_PATH = `${DEFINITION_DIR}/factory.yaml`;
export const BASELINES_PATH = `${GUARDRAILS_DIR}/baselines.json`;
export const COVERAGE_PATH = `${GUARDRAILS_DIR}/coverage.json`;

export interface Loader {
  /** Read a repo-relative file, or null when it is absent. */
  read(path: string): Promise<string | null>;
}

/** Reads from a checkout on disk. */
/**
 * Paths that decide how a change is judged — the definition (policy, factory
 * config, roles) and the frozen sandbox (which test command runs). In CI these
 * are read from the default branch, never from the change under judgement.
 */
const TRUSTED_PREFIXES = [".factory/definition/", ".factory/sandbox/"];

/**
 * Where the default branch's copy of the trusted paths is, when a workflow
 * has fetched one. Unset outside Actions, where the checkout is the only copy.
 */
export function trustedRoot(): string | undefined {
  const r = process.env["BSF_TRUSTED_ROOT"];
  return r === undefined || r === "" ? undefined : r;
}

/** The file to read for `path`: the trusted copy for judging paths, else the checkout. */
export function resolveRead(root: string, path: string): string {
  const trusted = trustedRoot();
  const normalized = path.replace(/^\.\//, "");
  if (trusted !== undefined && TRUSTED_PREFIXES.some((p) => normalized.startsWith(p))) {
    return join(trusted, normalized);
  }
  return join(root, normalized);
}

/**
 * Reads files from a checkout.
 *
 * A gate checks out the change it is judging, so reading `factory.yaml` or the
 * sandbox manifest from that checkout let a pull request choose its own test
 * command, or point `existing_ci.test_check` at a check that always passes.
 * With a trusted root set, the judging paths come from the default branch and
 * only the code being judged comes from the change.
 */
export class DiskLoader implements Loader {
  constructor(private readonly root: string = process.cwd()) {}
  async read(path: string): Promise<string | null> {
    const full = resolveRead(this.root, path);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  }
}

export async function loadPolicy(loader: Loader): Promise<Policy> {
  const text = await loader.read(POLICY_PATH);
  if (text === null) {
    throw new Error(
      `${POLICY_PATH} is missing. The gates read it from the default branch; ` +
        `without it there is nothing to enforce, so they fail rather than pass.`,
    );
  }
  return assertValid<Policy>("policy", parseYaml(text));
}

export async function loadFactory(loader: Loader): Promise<unknown> {
  const text = await loader.read(FACTORY_PATH);
  if (text === null) throw new Error(`${FACTORY_PATH} is missing`);
  return assertValid("factory", parseYaml(text));
}

/** Absent baselines mean a clean repo, not a broken one. */
export async function loadBaselines(loader: Loader): Promise<Baselines> {
  const text = await loader.read(BASELINES_PATH);
  if (text === null) return { schema: "baselines/1", rules: {} };
  return assertValid<Baselines>("baselines", JSON.parse(text));
}

/** Absent coverage settings mean no floor yet, which is the no-tests path. */
export async function loadCoverage(loader: Loader): Promise<Coverage> {
  const text = await loader.read(COVERAGE_PATH);
  if (text === null) {
    return {
      schema: "coverage/1",
      high_pct: 0,
      floor_pct: 0,
      tolerance_pts: 1,
      diff_min_pct: 80,
      skips: { count: 0, cap: 10 },
    };
  }
  return assertValid<Coverage>("coverage", JSON.parse(text));
}

/* -------------------------------------------------- reading from another ref */

import { execFileSync } from "node:child_process";

/**
 * Reads a file as it stands on another ref, for the "before" side of the
 * ratchet. Tries git first — the gate workflows check out with full history —
 * and falls back to the contents API.
 */
export class RefLoader implements Loader {
  constructor(
    private readonly ref: string,
    private readonly fallback?: { read(path: string, ref: string): Promise<string | null> },
  ) {}

  async read(path: string): Promise<string | null> {
    try {
      return execFileSync("git", ["show", `${this.ref}:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      // The file may not exist on that ref, which is a legitimate answer: a
      // first-time baseline has no "before".
      if (this.fallback !== undefined) return this.fallback.read(path, this.ref);
      return null;
    }
  }
}

/** Files changed between a ref and the working tree. */
export function changedFilesSince(ref: string): readonly string[] {
  try {
    const out = execFileSync("git", ["diff", "--name-only", `${ref}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.split("\n").map((s) => s.trim()).filter((s) => s !== "");
  } catch {
    return [];
  }
}
