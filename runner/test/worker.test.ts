import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { originAllowed, allowedOrigins, safeOrigin, SCOPES, type Env } from "../../worker/src/index.js";

/**
 * The Worker's whole job is one exchange, so its tests are about the one risk:
 * an endpoint that mints GitHub tokens and can be called from anywhere.
 */

const env: Env = {
  GITHUB_CLIENT_ID: "Iv1.test",
  GITHUB_CLIENT_SECRET: "secret-value",
  ALLOWED_ORIGINS: "https://dash.example.com, https://localhost:3000",
};

const post = (body: unknown, origin: string | null): Request =>
  new Request("https://w.example.com/exchange", {
    method: "POST",
    headers: origin === null ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("origin checks", () => {
  it("reads the allowlist and trims it", () => {
    expect(allowedOrigins(env)).toEqual(["https://dash.example.com", "https://localhost:3000"]);
  });

  it("matches exactly, so a look-alike origin is refused", () => {
    const allowed = allowedOrigins(env);
    expect(originAllowed("https://dash.example.com", allowed)).toBe(true);
    expect(originAllowed("https://dash.example.com.evil.test", allowed)).toBe(false);
    expect(originAllowed("https://evil.test/dash.example.com", allowed)).toBe(false);
    expect(originAllowed("http://dash.example.com", allowed)).toBe(false);
  });

  it("refuses a request with no Origin at all", () => {
    expect(originAllowed(null, allowedOrigins(env))).toBe(false);
  });

  it("refuses everything when the allowlist is empty, rather than allowing everything", () => {
    // A misconfigured deployment should mint no tokens, not all of them.
    expect(originAllowed("https://anything.test", allowedOrigins({ ...env, ALLOWED_ORIGINS: "" }))).toBe(false);
  });

  it("does not throw on a malformed redirect_uri", () => {
    expect(safeOrigin("not a url")).toBeNull();
  });
});

describe("the exchange", () => {
  it("refuses a caller from an origin not on the list, without calling GitHub", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await worker.fetch(post({ code: "c", redirect_uri: "https://dash.example.com/cb" }, "https://evil.test"), env);
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a redirect_uri pointing somewhere else, even from an allowed origin", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await worker.fetch(
      post({ code: "c", redirect_uri: "https://evil.test/cb" }, "https://dash.example.com"),
      env,
    );
    expect(res.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns the token to the caller and nothing else", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "gho_x", token_type: "bearer", scope: "repo" }), { status: 200 }),
      ),
    );
    const res = await worker.fetch(
      post({ code: "c", redirect_uri: "https://dash.example.com/cb" }, "https://dash.example.com"),
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["access_token"]).toBe("gho_x");
    expect(Object.keys(body).sort()).toEqual(["access_token", "scope", "token_type"]);
  });

  it("never caches a response that carried a token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "gho_x" }), { status: 200 })));
    const res = await worker.fetch(
      post({ code: "c", redirect_uri: "https://dash.example.com/cb" }, "https://dash.example.com"),
      env,
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not pass GitHub's error description through, because it can echo the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "bad_verification_code", error_description: "The code abc123 is incorrect" }),
          { status: 200 },
        ),
      ),
    );
    const res = await worker.fetch(
      post({ code: "abc123", redirect_uri: "https://dash.example.com/cb" }, "https://dash.example.com"),
      env,
    );
    const body = JSON.stringify(await res.json());
    expect(body).toContain("bad_verification_code");
    expect(body).not.toContain("abc123");
  });

  it("reports a GitHub failure without relaying its body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("code abc123 leaked here", { status: 500 })));
    const res = await worker.fetch(
      post({ code: "abc123", redirect_uri: "https://dash.example.com/cb" }, "https://dash.example.com"),
      env,
    );
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("abc123");
  });

  it("never puts the client secret in a response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "gho_x" }), { status: 200 })));
    for (const path of ["/health", "/exchange", "/nope"]) {
      const res = await worker.fetch(
        new Request(`https://w.example.com${path}`, {
          method: path === "/exchange" ? "POST" : "GET",
          headers: { "Content-Type": "application/json", Origin: "https://dash.example.com" },
          ...(path === "/exchange" ? { body: JSON.stringify({ code: "c", redirect_uri: "https://dash.example.com/cb" }) } : {}),
        }),
        env,
      );
      const text = await res.text();
      expect(text, path).not.toContain("secret-value");
      expect(text, path).not.toContain("Iv1.test");
    }
  });

  it("rejects a GET on the exchange", async () => {
    const res = await worker.fetch(
      new Request("https://w.example.com/exchange", { method: "GET", headers: { Origin: "https://dash.example.com" } }),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("rejects a body that is not JSON", async () => {
    const res = await worker.fetch(
      new Request("https://w.example.com/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://dash.example.com" },
        body: "not json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("the start endpoint", () => {
  const get = (qs: string, origin = "https://dash.example.com"): Request =>
    new Request(`https://w.example.com/start?${qs}`, { headers: { Origin: origin } });

  it("builds the authorize URL with the scopes the dashboard needs", async () => {
    const res = await worker.fetch(
      get(`redirect_uri=${encodeURIComponent("https://dash.example.com/cb")}&state=0123456789abcdef`),
      env,
    );
    const body = (await res.json()) as { authorize_url: string };
    const url = new URL(body.authorize_url);
    expect(url.host).toBe("github.com");
    expect(url.searchParams.get("scope")).toBe(SCOPES);
    expect(url.searchParams.get("client_id")).toBe("Iv1.test");
    expect(url.searchParams.get("state")).toBe("0123456789abcdef");
  });

  it("refuses to send a user to GitHub with someone else's callback attached", async () => {
    const res = await worker.fetch(
      get(`redirect_uri=${encodeURIComponent("https://evil.test/cb")}&state=0123456789abcdef`),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("insists on a state long enough to be unguessable", async () => {
    const res = await worker.fetch(
      get(`redirect_uri=${encodeURIComponent("https://dash.example.com/cb")}&state=short`),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("CORS", () => {
  it("answers a preflight from an allowed origin and refuses others", async () => {
    const ok = await worker.fetch(
      new Request("https://w.example.com/exchange", { method: "OPTIONS", headers: { Origin: "https://dash.example.com" } }),
      env,
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("https://dash.example.com");

    const no = await worker.fetch(
      new Request("https://w.example.com/exchange", { method: "OPTIONS", headers: { Origin: "https://evil.test" } }),
      env,
    );
    expect(no.status).toBe(403);
  });

  it("never allows credentials, since the Worker holds no session", async () => {
    const res = await worker.fetch(
      new Request("https://w.example.com/health", { headers: { Origin: "https://dash.example.com" } }),
      env,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });
});
