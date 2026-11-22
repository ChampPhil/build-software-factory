import { describe, it, expect } from "vitest";
import { dashboardLink, validRepo } from "../src/lib/dashboard-link.js";

describe("the dashboard link", () => {
  it("is the site's address with the repository filled in", () => {
    expect(dashboardLink("acme/widgets", {}, "https://factory.example.com")).toEqual({
      ok: true,
      url: "https://factory.example.com/?repo=acme/widgets",
    });
  });

  it("drops a trailing slash so the link has one", () => {
    expect(dashboardLink("acme/widgets", {}, "https://factory.example.com/").url).toBe("https://factory.example.com/?repo=acme/widgets");
  });

  it("uses the published address when nothing overrides it", () => {
    expect(dashboardLink("acme/widgets", {})).toEqual({ ok: true, url: "https://buildsoftwarefactory.com/?repo=acme/widgets" });
  });

  it("gives no link, and says why, when there is no address", () => {
    const r = dashboardLink("acme/widgets", {}, null);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not been published/);
    expect(r.reason).toMatch(/do not make one up/);
  });

  it("lets a person who hosts their own copy point at it", () => {
    const r = dashboardLink("acme/widgets", { BSF_DASHBOARD_URL: "https://mine.example.org/factory" }, "https://factory.example.com");
    expect(r.url).toBe("https://mine.example.org/factory/?repo=acme/widgets");
  });

  it("refuses an address that is not secure, because a token is typed into it", () => {
    for (const bad of ["http://factory.example.com", "ftp://x.example.com", "javascript:alert(1)", "not a url"]) {
      const r = dashboardLink("acme/widgets", { BSF_DASHBOARD_URL: bad }, "https://factory.example.com");
      expect(r.ok, bad).toBe(false);
    }
  });

  it("allows plain http only on a machine's own loopback address", () => {
    expect(dashboardLink("acme/widgets", { BSF_DASHBOARD_URL: "http://localhost:3000" }, null).url).toBe("http://localhost:3000/?repo=acme/widgets");
  });

  it("does not let a bad override fall back to the published address silently", () => {
    const r = dashboardLink("acme/widgets", { BSF_DASHBOARD_URL: "http://evil.example" }, "https://factory.example.com");
    expect(r.ok).toBe(false);
  });

  it("refuses anything that is not owner/name, so a link cannot carry extra parameters", () => {
    for (const bad of ["acme", "acme/widgets&token=x", "acme/widgets?x=1", "a/b/c", "", "acme/ widgets"]) {
      expect(validRepo(bad), bad).toBe(false);
      expect(dashboardLink(bad, {}, "https://factory.example.com").ok, bad).toBe(false);
    }
  });
});
