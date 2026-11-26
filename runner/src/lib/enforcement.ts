import type { GitHub } from "./github.js";

/**
 * Which enforcement the repository can have, decided once at setup so the
 * first dashboard load already knows (a rollup has not run yet).
 *
 * A public repository, or a private one on a paid plan, can require checks, so
 * the factory sets branch protection on. A private repository on the free plan
 * cannot: GitHub answers a protection read with "Upgrade to GitHub Pro or make
 * this repository public", and the factory runs in audit mode instead.
 *
 * It returns "on" or "off", the values factory.yaml's `enforcement.branch_protection`
 * already allows; `auto` (the template default) means "not decided yet".
 */
export async function detectEnforcement(gh: GitHub, branch: string): Promise<"on" | "off"> {
  const repo = await gh.get<{ private?: boolean }>(`repos/${gh.repo}`);
  if (repo.private !== true) return "on";
  try {
    await gh.get(`repos/${gh.repo}/branches/${branch}/protection`);
    return "on";
  } catch (e) {
    const text = e instanceof Error ? `${e.message}` : String(e);
    if (/upgrade to github pro|make this repository public|403/i.test(text)) return "off";
    // "Branch not protected" (404) is what a plan that supports protection says.
    return "on";
  }
}

/** Set `enforcement.branch_protection` in a factory.yaml text, leaving every other line alone. */
export function withBranchProtection(yaml: string, value: "on" | "off"): string {
  const block = /^(enforcement:\s*\n(?:[ \t]+.*\n)*?[ \t]+branch_protection:[ \t]*)\S+/m;
  if (!block.test(yaml)) throw new Error("factory.yaml has no enforcement.branch_protection to set");
  return yaml.replace(block, `$1${value}`);
}

/** What the dashboard shows when the rollup has not written health yet: the setup-time decision. */
export function enforcementFromConfig(value: string | null | undefined): "branch_protection" | "audit" | null {
  if (value === "on") return "branch_protection";
  if (value === "off") return "audit";
  return null;
}
