/**
 * Where the dashboard lives, and the link that opens it on a given repository.
 *
 * The dashboard is one shared static site, not a copy in each repository, so a
 * link is that site's address plus `?repo=owner/name`, which pre-fills the
 * sign-in. The address is set here once the site is published. Until then there
 * is no link to give, and the setup skill must say so rather than invent one.
 */

/** The published dashboard's address. */
export const DASHBOARD_URL: string | null = "https://buildsoftwarefactory.com";

/** The environment variable that overrides it, for a copy a person hosts themselves. */
export const DASHBOARD_URL_ENV = "BSF_DASHBOARD_URL";

/** owner/name, and nothing else (the same rule the dashboard applies). */
export function validRepo(value: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

function normalise(address: string | null | undefined): string | null {
  if (address === null || address === undefined || address.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  // A token is typed into this site, so it must be served securely. Plain http is only for a machine's own loopback.
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export interface DashboardLink {
  readonly ok: boolean;
  /** The link, when there is one. */
  readonly url?: string;
  /** Why not, in a sentence the setup skill can pass on. */
  readonly reason?: string;
}

export function dashboardLink(
  repo: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  published: string | null = DASHBOARD_URL,
): DashboardLink {
  if (!validRepo(repo)) return { ok: false, reason: `"${repo}" is not a repository (expected owner/name).` };
  const fromEnv = env[DASHBOARD_URL_ENV];
  const base = normalise(fromEnv !== undefined && fromEnv !== "" ? fromEnv : published);
  if (base === null) {
    return {
      ok: false,
      reason:
        fromEnv !== undefined && fromEnv !== ""
          ? `${DASHBOARD_URL_ENV} is not a secure address (it must start with https://).`
          : "The shared dashboard has not been published yet, so there is no link to give. Say that, and do not make one up.",
    };
  }
  return { ok: true, url: `${base}/?repo=${repo}` };
}
