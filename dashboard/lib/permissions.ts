/**
 * What the dashboard needs from a sign-in, in the words a person sees.
 *
 * A fine-grained personal access token and a GitHub App are not given the
 * same permissions. GitHub's token form has no Checks row, and a fine-grained
 * token is refused by the Checks API no matter which boxes are ticked.
 * `PERMISSIONS` is what that form can actually grant. `APP_PERMISSIONS` is
 * what "Sign in with GitHub" asks for: the same list, plus Checks, which only
 * the app can hold.
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
  { key: "metadata", label: "Metadata", level: "read", why: "see the repository (GitHub always adds this)" },
];

/**
 * Checks, which a GitHub App can be given and a fine-grained token cannot.
 *
 * key: GitHub's permission name on an app registration.
 * label: the word a person would look for. It is absent from the token form.
 * level: read. The dashboard only looks at results. It does not create them.
 * why: what the read is for.
 */
const CHECKS: PermissionNeed = {
  key: "checks",
  label: "Checks",
  level: "read",
  why: "see whether the factory's own check passed",
};

/** What the dashboard's GitHub App asks for. Includes Checks; the token form does not. */
export const APP_PERMISSIONS: readonly PermissionNeed[] = [...PERMISSIONS, CHECKS];

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

/**
 * The steps to make a token by hand, one per thing to set, generated from
 * PERMISSIONS so a permission added there appears here too.
 */
export function tokenSteps(repo: string): readonly string[] {
  const where = repo.trim() === "" ? "your repository" : repo.trim();
  return [
    `Open GitHub's token form (the button below fills in the name and lifetime).`,
    `Under Repository access choose Only select repositories, then pick ${where}.`,
    ...PERMISSIONS.filter((p) => p.key !== "metadata").map((p) => `Under Repository permissions set ${p.label} to "${levelWords(p.level)}" (${p.why}).`),
    `Metadata is read-only and GitHub adds it by itself.`,
    `Press Generate token, copy it, and paste it below.`,
  ];
}

/** The sentence that names the first permission a token lacks, from the labels checkAccess reports. */
export function missingPermissionSentence(missing: readonly { readonly label: string }[]): string {
  const first = missing[0];
  if (first === undefined) return "";
  const p = PERMISSIONS.find((x) => x.label === first.label);
  const level = p === undefined ? "" : ` to "${levelWords(p.level)}"`;
  return `This token is missing the ${first.label} permission. Make a new token with ${first.label} set${level || ""}.`;
}

function need(key: string): PermissionNeed {
  const found = APP_PERMISSIONS.find((p) => p.key === key);
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

/**
 * A sentence naming what to change, for a request that was refused.
 *
 * perm: the permission the refused request needed.
 */
export function missingPermissionMessage(perm: PermissionNeed): string {
  if (perm.key === "checks") {
    return "A fine-grained token cannot read GitHub check results. There is no Checks permission to add. Sign in with GitHub, which uses the dashboard's app.";
  }
  return `This sign-in is not allowed to do that. It needs "${perm.label}: ${levelWords(perm.level)}" (${perm.why}). Add that permission, then sign in again.`;
}
