import { describe, it, expect } from "vitest";
import { GitHubClient, GitHubHttpError } from "../lib/github.js";
import { PERMISSIONS, permissionForRequest, tokenLink } from "../lib/permissions.js";

/** A fake API: each route is a substring, answered with a status. */
function api(routes: Record<string, number>): { fetch: typeof fetch; urls: string[]; tokenSentTo: Set<string> } {
  const urls: string[] = [];
  const tokenSentTo = new Set<string>();
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers["authorization"] !== undefined) tokenSentTo.add(new URL(url).origin);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const status = key === undefined ? 404 : routes[key]!;
    return new Response(status === 200 ? JSON.stringify({ permissions: { push: true }, private: true }) : "{}", { status });
  };
  return { fetch: impl, urls, tokenSentTo };
}

const auth = { token: "github_pat_" + "x".repeat(30), repo: "owner/name" };

describe("the prefilled token link", () => {
  const url = new URL(tokenLink("acme/widgets"));

  it("opens GitHub's own token form, never another site", () => {
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/settings/personal-access-tokens/new");
  });

  it("names the token, the owner and a lifetime", () => {
    expect(url.searchParams.get("name")).toBe("Software Factory dashboard");
    expect(url.searchParams.get("target_name")).toBe("acme");
    expect(url.searchParams.get("expires_in")).toBe("90");
    expect(url.searchParams.get("description")).toContain("acme/widgets");
  });

  it("asks for every permission in the list, at the level the list gives", () => {
    for (const p of PERMISSIONS) expect(url.searchParams.get(p.key)).toBe(p.level);
  });

  it("keeps the name and description inside GitHub's length limits", () => {
    expect(url.searchParams.get("name")!.length).toBeLessThanOrEqual(40);
    expect(url.searchParams.get("description")!.length).toBeLessThanOrEqual(1024);
  });

  it("asks for nothing it does not use: no administration, no secrets, no Checks", () => {
    for (const k of ["administration", "secrets", "environments", "pages", "security_events", "checks"]) {
      expect(url.searchParams.has(k)).toBe(false);
    }
  });
});

describe("naming the permission a refused request needed", () => {
  it("maps the requests the dashboard makes", () => {
    const cases: [string, string, string][] = [
      ["POST", "repos/o/r/actions/workflows/factory-intake.yml/dispatches", "actions"],
      ["POST", "repos/o/r/pulls/3/reviews", "pull_requests"],
      ["PUT", "repos/o/r/pulls/3/merge", "pull_requests"],
      ["POST", "repos/o/r/issues", "issues"],
      ["POST", "repos/o/r/issues/4/comments", "issues"],
      ["POST", "repos/o/r/git/refs", "contents"],
      ["PUT", "repos/o/r/contents/.factory/definition/factory.yaml", "contents"],
      ["PUT", "repos/o/r/contents/.github/workflows/factory-garden.yml", "workflows"],
      ["GET", "repos/o/r/commits/abc/check-runs?per_page=100", "checks"],
    ];
    for (const [method, path, key] of cases) expect(permissionForRequest(method, path)?.key, `${method} ${path}`).toBe(key);
  });

  it("gives a person a sentence to act on, not a status code", () => {
    const err = new GitHubHttpError(403, "repos/o/r/actions/workflows/x.yml/dispatches", "{}", "POST");
    expect(err.human).toContain("Actions");
    expect(err.human).toContain("Read and write");
    expect(err.human).not.toMatch(/\b403\b/);
  });

  it("treats a 404 on a write as a missing permission too, but not a 404 on a read", () => {
    expect(new GitHubHttpError(404, "repos/o/r/issues", "{}", "POST").human).toContain("Issues");
    expect(new GitHubHttpError(404, "repos/o/r/issues/9", "{}", "GET").human).toContain("Not found");
  });
});

describe("checking a token at sign-in", () => {
  it("passes a token that can read everything the dashboard reads", async () => {
    const { fetch } = api({ "repos/owner/name": 200 });
    // every probe path contains repos/owner/name, so all answer 200
    const result = await new GitHubClient(auth, fetch).checkAccess();
    expect(result).toEqual({ ok: true, readOnly: false });
  });

  it("names each missing permission instead of failing later", async () => {
    const { fetch } = api({ "/pulls": 403, "/actions/": 403, "repos/owner/name": 200 });
    const result = await new GitHubClient(auth, fetch).checkAccess();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Pull requests");
    expect(result.reason).toContain("Actions");
    expect(result.reason).not.toContain("Issues");
    expect(result.missing?.map((m) => m.key).sort()).toEqual(["actions", "pull_requests"]);
  });

  it("says so when the repository is not visible to the token", async () => {
    const { fetch } = api({});
    const result = await new GitHubClient(auth, fetch).checkAccess();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("cannot see this repository");
  });

  it("tells a mistyped or expired token apart from a missing permission", async () => {
    const { fetch } = api({ "repos/owner/name": 401 });
    const result = await new GitHubClient(auth, fetch).checkAccess();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("refused that token");
  });

  it("does not call the Checks API, which a fine-grained token cannot be allowed to use", async () => {
    const { fetch, urls } = api({ "/check-runs": 403, "repos/owner/name": 200 });
    const result = await new GitHubClient(auth, fetch).checkAccess();
    expect(result.ok).toBe(true);
    expect(urls.some((u) => u.includes("check-runs"))).toBe(false);
  });
});

describe("where the token goes", () => {
  it("sends it to api.github.com and nowhere else", async () => {
    const { fetch, tokenSentTo } = api({ "repos/owner/name": 200 });
    const c = new GitHubClient(auth, fetch);
    await c.checkAccess();
    await c.get("repos/owner/name/pulls");
    expect([...tokenSentTo]).toEqual(["https://api.github.com"]);
  });

  it("refuses an absolute address on any other host before building the request", async () => {
    const { fetch, urls } = api({});
    const c = new GitHubClient(auth, fetch);
    for (const bad of [
      "https://evil.example/steal",
      "https://api.github.com.evil.example/x",
      "http://api.github.com/x",
      "ftp://api.github.com/x",
    ]) {
      await expect(c.get(bad), bad).rejects.toThrow(/anywhere but GitHub/);
    }
    expect(urls).toEqual([]);
  });

  it("joins any relative path onto the API origin, so a path cannot name another host", async () => {
    const { fetch, urls } = api({});
    const c = new GitHubClient(auth, fetch);
    await c.getOrNull("//evil.example/x");
    expect(new URL(urls[0]!).origin).toBe("https://api.github.com");
  });

  it("accepts the absolute API address GitHub's own paging links use", async () => {
    const { fetch, urls } = api({ "pulls": 200 });
    await new GitHubClient(auth, fetch).get("https://api.github.com/repositories/1/pulls?page=2");
    expect(urls).toEqual(["https://api.github.com/repositories/1/pulls?page=2"]);
  });
});

import { missingPermissionSentence, tokenSteps } from "../lib/permissions";
import { PERMISSIONS as ALL_PERMISSIONS } from "../lib/permissions";
describe("token steps", () => {
  it("name every permission", () => {
    const text = tokenSteps("o/r").join("\n");
    for (const p of ALL_PERMISSIONS.filter((x) => x.key !== "metadata")) expect(text).toContain(p.label);
    expect(text).toContain("o/r");
  });
  it("names the first missing permission", () => {
    expect(missingPermissionSentence([{ label: "Checks" }, { label: "Issues" }])).toContain("Checks");
  });
});
