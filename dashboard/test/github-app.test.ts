import { describe, it, expect } from "vitest";
import { appRegistrationLink } from "../lib/github-app.js";
import { PERMISSIONS } from "../lib/permissions.js";

describe("the app registration link", () => {
  const url = new URL(appRegistrationLink("https://factory.example.com/some/page?x=1"));

  it("opens GitHub's new-app form, for a person or for an organization", () => {
    expect(url.origin + url.pathname).toBe("https://github.com/settings/apps/new");
    const org = new URL(appRegistrationLink("https://factory.example.com", "acme"));
    expect(org.pathname).toBe("/organizations/acme/settings/apps/new");
  });

  it("asks for exactly the permissions the token form asks for, so the two ways cannot disagree", () => {
    for (const p of PERMISSIONS) expect(url.searchParams.get(p.key)).toBe(p.level);
    const names = new Set(PERMISSIONS.map((p) => p.key));
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
