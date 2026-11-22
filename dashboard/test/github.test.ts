import { describe, it, expect } from "vitest";
import { GitHubClient, GitHubHttpError, decodeBase64 } from "../lib/github.js";

/** A fetch stand-in, so the client is tested without the network. */
/**
 * The request body as the JSON string the client always sends. Asserting on
 * `String(body)` instead would quietly pass for any object, since that is
 * "[object Object]" and `toContain` would simply fail — or worse, match.
 */
function bodyOf(call: { init?: RequestInit } | undefined): string {
  const body = call?.init?.body;
  if (typeof body !== "string") throw new Error(`expected a JSON string body, got ${typeof body}`);
  return body;
}

function stubFetch(
  routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key === undefined ? { status: 404, body: { message: "Not Found" } } : routes[key]!;
    const status = route.status ?? 200;
    return new Response(route.body === undefined ? "" : JSON.stringify(route.body), {
      status,
      headers: { "content-type": "application/json", ...(route.headers ?? {}) },
    });
  };
  return { fetch: impl, calls };
}

const auth = { token: "github_pat_test", repo: "owner/name" };

describe("the GitHub client in a browser", () => {
  it("calls the global fetch as a plain function, not as a method of the client", async () => {
    // Browsers throw "Illegal invocation" when fetch runs with any `this` but the window.
    const real = globalThis.fetch;
    const strict = function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    globalThis.fetch = strict;
    try {
      await new GitHubClient(auth).get("repos/owner/name");
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("the GitHub client", () => {
  it("sends the token and the API version on every request", async () => {
    const { fetch, calls } = stubFetch({ "repos/owner/name": { body: { full_name: "owner/name" } } });
    const c = new GitHubClient(auth, fetch);
    await c.get("repos/owner/name");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer github_pat_test");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("turns an HTTP error into a message worth showing a person", async () => {
    for (const [status, expected] of [
      [401, "expired"],
      [403, "permission"],
      [404, "Not found"],
      [500, "having trouble"],
    ] as const) {
      const { fetch } = stubFetch({ "repos/": { status, body: { message: "x" } } });
      const c = new GitHubClient(auth, fetch);
      try {
        await c.get("repos/owner/name");
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GitHubHttpError);
        expect((err as GitHubHttpError).human).toContain(expected);
      }
    }
  });

  it("treats a missing file as absent rather than as an error", async () => {
    // A factory that has not run yet has no index.json, which is a normal
    // state the dashboard must render, not a failure.
    const { fetch } = stubFetch({});
    const c = new GitHubClient(auth, fetch);
    expect(await c.fileFromRef("index.json")).toBeNull();
  });

  it("decodes a file from the contents API", async () => {
    const content = Buffer.from(JSON.stringify({ schema: "index/1" })).toString("base64");
    const { fetch } = stubFetch({ "contents/index.json": { body: { content, encoding: "base64" } } });
    const c = new GitHubClient(auth, fetch);
    expect(await c.fileFromRef<{ schema: string }>("index.json")).toEqual({ schema: "index/1" });
  });

  it("reads the factory's data from its own ref, not from a branch", async () => {
    const { fetch, calls } = stubFetch({ "contents/": { body: { content: "e30=", encoding: "base64" } } });
    const c = new GitHubClient(auth, fetch);
    await c.fileFromRef("index.json");
    expect(calls[0]?.url).toContain("ref=refs%2Ffactory%2Fdata");
  });

  it("returns null rather than throwing when a data file is not valid JSON", async () => {
    const content = Buffer.from("not json").toString("base64");
    const { fetch } = stubFetch({ "contents/": { body: { content, encoding: "base64" } } });
    const c = new GitHubClient(auth, fetch);
    expect(await c.fileFromRef("index.json")).toBeNull();
  });

  it("lists no live refs rather than failing when there are none", async () => {
    const { fetch } = stubFetch({});
    const c = new GitHubClient(auth, fetch);
    expect(await c.liveRefs()).toEqual([]);
  });

  it("tracks the rate limit from the response headers", async () => {
    const { fetch } = stubFetch({
      "repos/": {
        body: {},
        headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1800000000" },
      },
    });
    const c = new GitHubClient(auth, fetch);
    await c.get("repos/owner/name");
    expect(c.rateLimit?.remaining).toBe(4321);
    expect(c.rateLimit?.resetAt).toBeInstanceOf(Date);
  });

  it("reports a read-only token rather than letting an approval fail later", async () => {
    const { fetch } = stubFetch({
      "repos/owner/name": { body: { permissions: { push: false, pull: true }, private: true } },
    });
    const c = new GitHubClient(auth, fetch);
    const access = await c.checkAccess();
    expect(access.ok).toBe(true);
    if (access.ok) {
      expect(access.readOnly).toBe(true);
      expect(access.reason).toContain("approving");
    }
  });

  it("reports a token that cannot see the repo at all", async () => {
    const { fetch } = stubFetch({});
    const c = new GitHubClient(auth, fetch);
    const access = await c.checkAccess();
    expect(access.ok).toBe(false);
  });

  it("accepts a token with push access", async () => {
    const { fetch } = stubFetch({
      "repos/owner/name": { body: { permissions: { push: true }, private: false } },
    });
    const c = new GitHubClient(auth, fetch);
    const access = await c.checkAccess();
    expect(access).toEqual({ ok: true, readOnly: false });
  });

  it("creates an issue, which is how a new request enters the factory", async () => {
    const { fetch, calls } = stubFetch({
      "issues": { status: 201, body: { number: 7, html_url: "https://github.com/owner/name/issues/7" } },
    });
    const c = new GitHubClient(auth, fetch);
    const issue = await c.createIssue("Export is empty", "steps…");
    expect(issue.number).toBe(7);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(bodyOf(calls[0])).toContain("Export is empty");
  });

  it("approves a pull request with the APPROVE event", async () => {
    const { fetch, calls } = stubFetch({ "pulls/311/reviews": { body: {} } });
    const c = new GitHubClient(auth, fetch);
    await c.approvePull(311);
    expect(bodyOf(calls[0])).toContain("APPROVE");
  });
});

describe("decodeBase64", () => {
  it("handles the newlines GitHub puts in base64 content", () => {
    const raw = Buffer.from("hello world").toString("base64");
    const wrapped = `${raw.slice(0, 4)}\n${raw.slice(4)}\n`;
    expect(decodeBase64(wrapped)).toBe("hello world");
  });

  it("round-trips non-ascii", () => {
    const text = '{"note":"café — 100%"}';
    expect(decodeBase64(Buffer.from(text, "utf8").toString("base64"))).toBe(text);
  });
});
