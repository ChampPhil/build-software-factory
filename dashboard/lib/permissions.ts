/**
 * What the dashboard needs from a token, in the words a person sees.
 *
 * One list drives three things, so they cannot drift apart: the link that
 * opens GitHub's token form already filled in, the probes run at sign-in, and
 * the message shown when a request is refused later.
 */

export interface PermissionNeed {
  /** GitHub's name for the permission, which is also its query parameter on the token form. */
  readonly key: string;
  /** The label on GitHub's token form. */
  readonly label: string;
  readonly level: "read" | "write";
  /** What it is for, in a few words. */
  readonly why: string;
}

export const PERMISSIONS: readonly PermissionNeed[] = [
  { key: "contents", label: "Contents", level: "write", why: "read the factory's records and save setting changes" },
  { key: "pull_requests", label: "Pull requests", level: "write", why: "approve, request changes and merge" },
  { key: "issues", label: "Issues", level: "write", why: "send requests and answer questions" },
  { key: "actions", label: "Actions", level: "write", why: "hand your decisions to the factory" },
  { key: "workflows", label: "Workflows", level: "write", why: "move the nightly cleanup time" },
  { key: "checks", label: "Checks", level: "read", why: "see whether the factory's own check passed" },
  { key: "metadata", label: "Metadata", level: "read", why: "see the repository (GitHub always adds this)" },
];

export const TOKEN_NAME = "Software Factory dashboard";

/** The wording on GitHub's form for a level. */
export function levelWords(level: "read" | "write"): string {
  return level === "write" ? "Read and write" : "Read-only";
}

/**
 * GitHub's token form with the name, owner, lifetime and permissions already
 * chosen. It cannot preselect the repository, so the page says to pick it.
 */
export function tokenLink(repo: string, days = 90): string {
  const owner = repo.split("/")[0] ?? "";
  const params = new URLSearchParams({
    name: TOKEN_NAME,
    description: `Lets the Software Factory dashboard act on ${repo}. Made from the dashboard's sign-in page.`,
    expires_in: String(days),
  });
  if (owner !== "") params.set("target_name", owner);
  for (const p of PERMISSIONS) params.set(p.key, p.level);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

function need(key: string): PermissionNeed {
  const found = PERMISSIONS.find((p) => p.key === key);
  if (found === undefined) throw new Error(`unknown permission ${key}`);
  return found;
}

/**
 * Which permission a request needs, from its method and path.
 *
 * Only for the message after a refusal: GitHub's own answer for a token that
 * lacks a permission is a bare 403 or 404, which says nothing a person can act
 * on. Null when no single permission explains it.
 */
export function permissionForRequest(method: string, path: string): PermissionNeed | null {
  const p = path.replace(/^https:\/\/api\.github\.com\//, "").replace(/^\//, "").split("?")[0] ?? "";
  const write = method !== "GET";
  if (/\/actions\//.test(p)) return need("actions");
  if (/\/check-runs$/.test(p)) return need("checks");
  if (write && /\/contents\/\.github\/workflows\//.test(p)) return need("workflows");
  if (/\/(contents|git)\//.test(p)) return need("contents");
  if (/\/pulls(\/|$)/.test(p)) return need("pull_requests");
  if (/\/issues(\/|$)/.test(p)) return need("issues");
  return null;
}

/** A sentence naming what to change, for a request that was refused. */
export function missingPermissionMessage(perm: PermissionNeed): string {
  return `This sign-in is not allowed to do that. It needs "${perm.label}: ${levelWords(perm.level)}" (${perm.why}). Add that permission, then sign in again.`;
}
