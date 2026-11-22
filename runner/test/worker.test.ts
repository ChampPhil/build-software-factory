import { describe, it, expect, vi, afterEach } from "vitest";
import worker, { callbackUrl, configured, installUrl, type Env } from "../../worker/src/index.js";

/**
 * The sign-in function's whole job is one exchange, so its tests are about the
 * one risk: an endpoint that mints GitHub tokens, reachable by anyone.
 */

const SITE = "https://dash.example.com";
const env: Env = {
  GITHUB_APP_CLIENT_ID: "Iv23li-test-client",
  GITHUB_APP_CLIENT_SECRET: "secret-value-xyz",
  GITHUB_APP_SLUG: "software-factory-dashboard",
};

const STATE = "a".repeat(32);
const CHALLENGE = "c".repeat(43);
const VERIFIER = "v".repeat(43);
const REFRESH = `ghr_${"r".repeat(40)}`;

const get = (path: string): Request => new Request(`${SITE}/api/auth${path}`);
const post = (path: string, body: unknown, origin: string | null = SITE): Request =>
  new Request(`${SITE}/api/auth${path}`, {
    method: "POST",
    headers: origin === null ? { "Content-Type": "application/json" } : { "Content-Type": "application/json", Origin: origin },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A request body, which these tests always send as a string. */
const bodyOf = (body: BodyInit | null | undefined): string => (typeof body === "string" ? body : "");

const githubSays = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("configuration", () => {
  it("is on only when the id, the secret and a valid slug are all set", () => {
    expect(configured(env)).toBe(true);
    expect(configured({ ...env, GITHUB_APP_CLIENT_ID: "" })).toBe(false);
    expect(configured({ GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID, GITHUB_APP_SLUG: env.GITHUB_APP_SLUG })).toBe(false);
    expect(configured({ ...env, GITHUB_APP_SLUG: "" })).toBe(false);
    expect(configured({ ...env, GITHUB_APP_SLUG: "not/a slug" })).toBe(false);
  });

  it("builds the install address from the slug, and refuses a slug that could change the address", () => {
    expect(installUrl(env)).toBe("https://github.com/apps/software-factory-dashboard/installations/new");
    expect(installUrl({ ...env, GITHUB_APP_SLUG: "x/../../evil" })).toBeNull();
  });

  it("tells the page whether to show the button, and nothing else about the setup", async () => {
    const on = await worker.fetch(get("/config"), env);
    expect(await on.json()).toEqual({ enabled: true, install_url: "https://github.com/apps/software-factory-dashboard/installations/new" });
    const off = await worker.fetch(get("/config"), {});
    expect(await off.json()).toEqual({ enabled: false });
  });

  it("mints nothing when it is half set up", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    for (const path of ["/exchange", "/refresh"]) {
      const res = await worker.fetch(post(path, { code: "abcdefgh1234", code_verifier: VERIFIER, refresh_token: REFRESH }), {});
      expect(res.status).toBe(503);
    }
    expect((await worker.fetch(get(`/start?state=${STATE}&code_challenge=${CHALLENGE}`), {})).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("starting a sign-in", () => {
  it("returns GitHub's authorize address with PKCE, and the site's own callback", async () => {
    const res = await worker.fetch(get(`/start?state=${STATE}&code_challenge=${CHALLENGE}`), env);
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { authorize_url: string }).authorize_url);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("Iv23li-test-client");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/`);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe(CHALLENGE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("asks for no scopes: a GitHub App's reach is what the app was given", async () => {
    const res = await worker.fetch(get(`/start?state=${STATE}&code_challenge=${CHALLENGE}`), env);
    const url = new URL(((await res.json()) as { authorize_url: string }).authorize_url);
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("ignores a redirect_uri the caller supplies, so the callback cannot be pointed elsewhere", async () => {
    const res = await worker.fetch(
      get(`/start?state=${STATE}&code_challenge=${CHALLENGE}&redirect_uri=${encodeURIComponent("https://evil.test/")}`),
      env,
    );
    const url = new URL(((await res.json()) as { authorize_url: string }).authorize_url);
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/`);
    expect(callbackUrl(new URL("https://dash.example.com/api/auth/start?x=1"))).toBe(`${SITE}/`);
  });

  it("refuses a short state or a malformed challenge", async () => {
    expect((await worker.fetch(get(`/start?state=short&code_challenge=${CHALLENGE}`), env)).status).toBe(400);
    expect((await worker.fetch(get(`/start?state=${STATE}&code_challenge=short`), env)).status).toBe(400);
    expect((await worker.fetch(get(`/start?state=${STATE}`), env)).status).toBe(400);
  });
});

describe("the exchange", () => {
  const good = { code: "abcdef123456", code_verifier: VERIFIER };

  it("refuses a request from another site, or with no origin, without calling GitHub", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await worker.fetch(post("/exchange", good, "https://evil.test"), env)).status).toBe(403);
    expect((await worker.fetch(post("/exchange", good, `${SITE}.evil.test`), env)).status).toBe(403);
    expect((await worker.fetch(post("/exchange", good, null), env)).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses GET, bad JSON, a malformed code and a malformed verifier", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await worker.fetch(get("/exchange"), env)).status).toBe(405);
    expect((await worker.fetch(post("/exchange", "not json"), env)).status).toBe(400);
    expect((await worker.fetch(post("/exchange", { code: "", code_verifier: VERIFIER }), env)).status).toBe(400);
    expect((await worker.fetch(post("/exchange", { code: "abcdef123456", code_verifier: "short" }), env)).status).toBe(400);
    expect((await worker.fetch(post("/exchange", { code: "abcdef123456" }), env)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("sends the secret to GitHub's token address and returns only the token fields", async () => {
    const spy = githubSays({
      access_token: "ghu_abc",
      expires_in: 28800,
      refresh_token: REFRESH,
      refresh_token_expires_in: 15897600,
      scope: "",
      token_type: "bearer",
      something_else: "not passed on",
    });
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(post("/exchange", good), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      access_token: "ghu_abc",
      expires_in: 28800,
      refresh_token: REFRESH,
      refresh_token_expires_in: 15897600,
    });

    const calls = spy.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("https://github.com/login/oauth/access_token");
    const sent = JSON.parse(bodyOf(calls[0]?.[1].body)) as Record<string, string>;
    expect(sent).toMatchObject({
      client_id: "Iv23li-test-client",
      client_secret: "secret-value-xyz",
      code: "abcdef123456",
      code_verifier: VERIFIER,
      redirect_uri: `${SITE}/`,
    });
  });

  it("never lets the secret or client id into any response", async () => {
    vi.stubGlobal("fetch", githubSays({ access_token: "ghu_abc" }));
    const responses = [
      await worker.fetch(post("/exchange", good), env),
      await worker.fetch(post("/exchange", good, "https://evil.test"), env),
      await worker.fetch(get("/config"), env),
      await worker.fetch(get("/health"), env),
      await worker.fetch(get(`/start?state=${STATE}&code_challenge=${CHALLENGE}`), env),
    ];
    for (const res of responses) expect(await res.text()).not.toContain("secret-value-xyz");
    // The client id is public by design but is only ever in the authorize address.
    expect(await (await worker.fetch(get("/config"), env)).text()).not.toContain("Iv23li-test-client");
    expect(await (await worker.fetch(get("/health"), env)).text()).not.toContain("Iv23li-test-client");
  });

  it("relays GitHub's error name but not its description, which can echo the code", async () => {
    vi.stubGlobal(
      "fetch",
      githubSays({ error: "bad_verification_code", error_description: "The code abcdef123456 passed is incorrect" }),
    );
    const res = await worker.fetch(post("/exchange", good), env);
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("bad_verification_code");
    expect(text).not.toContain("abcdef123456");
  });

  it("turns a failing GitHub into a plain 502 that carries none of its body", async () => {
    vi.stubGlobal("fetch", githubSays({ message: "echo abcdef123456" }, 500));
    const res = await worker.fetch(post("/exchange", good), env);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("abcdef123456");
  });

  it("survives GitHub being unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("network down"))));
    const res = await worker.fetch(post("/exchange", good), env);
    expect(res.status).toBe(502);
  });
});

describe("renewing a token", () => {
  it("exchanges the refresh token and returns the rotated pair", async () => {
    const spy = githubSays({ access_token: "ghu_new", expires_in: 28800, refresh_token: `ghr_${"n".repeat(40)}`, refresh_token_expires_in: 15897600 });
    vi.stubGlobal("fetch", spy);
    const res = await worker.fetch(post("/refresh", { refresh_token: REFRESH }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { access_token: string }).access_token).toBe("ghu_new");
    const calls = spy.mock.calls as unknown as [string, RequestInit][];
    const sent = JSON.parse(bodyOf(calls[0]?.[1].body)) as Record<string, string>;
    expect(sent).toMatchObject({ grant_type: "refresh_token", refresh_token: REFRESH, client_secret: "secret-value-xyz" });
  });

  it("refuses another site, a missing token, and anything that is not a refresh token", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await worker.fetch(post("/refresh", { refresh_token: REFRESH }, "https://evil.test"), env)).status).toBe(403);
    expect((await worker.fetch(post("/refresh", {}), env)).status).toBe(400);
    expect((await worker.fetch(post("/refresh", { refresh_token: "ghp_classicpersonaltoken1234567890" }), env)).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("every response", () => {
  it("is uncached and carries no cross-origin permission, because one of them holds a token", async () => {
    vi.stubGlobal("fetch", githubSays({ access_token: "ghu_abc" }));
    const responses = [
      await worker.fetch(get("/health"), env),
      await worker.fetch(get("/config"), env),
      await worker.fetch(get(`/start?state=${STATE}&code_challenge=${CHALLENGE}`), env),
      await worker.fetch(post("/exchange", { code: "abcdef123456", code_verifier: VERIFIER }), env),
      await worker.fetch(post("/exchange", { code: "abcdef123456", code_verifier: VERIFIER }, "https://evil.test"), env),
      await worker.fetch(get("/nothing"), env),
    ];
    for (const res of responses) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    }
  });

  it("does not answer for paths outside /api/auth", async () => {
    const res = await worker.fetch(new Request(`${SITE}/other`), env);
    expect(res.status).toBe(404);
  });
});
