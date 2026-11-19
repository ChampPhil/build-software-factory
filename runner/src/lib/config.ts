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
export class DiskLoader implements Loader {
  constructor(private readonly root: string = process.cwd()) {}
  async read(path: string): Promise<string | null> {
    const full = join(this.root, path);
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
