import { describe, it, expect } from "vitest";
import { appRegistrationLink } from "../lib/github-app.js";
import { APP_PERMISSIONS } from "../lib/permissions.js";

describe("the app registration link", () => {
  const url = new URL(appRegistrationLink("https://factory.example.com/some/page?x=1"));

  it("opens GitHub's new-app form, for a person or for an organization", () => {
    expect(url.origin + url.pathname).toBe("https://github.com/settings/apps/new");
    const org = new URL(appRegistrationLink("https://factory.example.com", "acme"));
    expect(org.pathname).toBe("/organizations/acme/settings/apps/new");
  });

  it("asks for the token form's permissions plus Checks, which only an app can be given", () => {
    for (const p of APP_PERMISSIONS) expect(url.searchParams.get(p.key)).toBe(p.level);
    expect(url.searchParams.get("checks")).toBe("read");
    const names = new Set(APP_PERMISSIONS.map((p) => p.key));
    const asked = [...url.searchParams.keys()].filter((k) => ["contents", "pull_requests", "issues", "actions", "workflows", "checks", "metadata", "administration", "statuses"].includes(k));
    expect(new Set(asked)).toEqual(names);
  });

  it("calls back to the site's own front page, and nothing else", () => {
    expect(url.searchParams.getAll("callback_urls[]")).toEqual(["https://factory.example.com/"]);
    expect(url.searchParams.get("url")).toBe("https://factory.example.com");
  });

  it("is public so anyone can install it, with no webhook", () => {
    expect(url.searchParams.get("public")).toBe("true");
    expect(url.searchParams.get("webhook_active")).toBe("false");
  });

  it("refuses an address that is not https", () => {
    expect(() => appRegistrationLink("http://factory.example.com")).toThrow(/https/);
  });
});
