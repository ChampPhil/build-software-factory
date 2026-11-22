/**
 * The GitHub App that "Sign in with GitHub" signs people in to.
 *
 * It is registered once, by the person who runs the dashboard, from a link
 * that fills in GitHub's registration form. What it asks for comes from the
 * same list as the token form (`permissions.ts`), so the two ways of signing in
 * can never ask for different things.
 *
 * The callback is the site's front page, because that is where the sign-in
 * function sends people back to. Webhooks are off: the dashboard reads GitHub
 * when you look, and nothing needs telling.
 */

import { PERMISSIONS } from "./permissions";

export const APP_NAME = "Software Factory Dashboard";

/** GitHub's registration form, filled in for a site at `origin` (for example https://factory.example.com). */
export function appRegistrationLink(origin: string, organization?: string): string {
  const site = new URL(origin);
  if (site.protocol !== "https:") throw new Error("The dashboard's address must be https://");
  const base = organization === undefined
    ? "https://github.com/settings/apps/new"
    : `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
  const params = new URLSearchParams({
    name: APP_NAME,
    description: "Lets the Software Factory dashboard read and act on repositories it is installed on.",
    url: site.origin,
    public: "true",
    webhook_active: "false",
    request_oauth_on_install: "false",
  });
  params.append("callback_urls[]", `${site.origin}/`);
  for (const p of PERMISSIONS) params.set(p.key, p.level);
  return `${base}?${params.toString()}`;
}
