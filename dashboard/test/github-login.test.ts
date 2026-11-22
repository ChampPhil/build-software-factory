import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  challengeFor, newVerifier, newState, fetchAuthConfig, startGithubLogin, completeGithubLogin,
  needsRefresh, refreshSession, REFRESH_MARGIN_MS,
} from "../lib/github-login.js";
import { readSession, clearSession, type Session } from "../lib/session.js";

/** A browser's storage and address, small enough to hold in a test. */
function fakeBrowser(search = "") {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  const replaceState = vi.fn();
  const win = {
    sessionStorage: store(),
    localStorage: store(),
    location: { search, origin: "https://dash.example.com", pathname: "/" },
    history: { replaceState },
  };
  vi.stubGlobal("window", win);
  return { win, replaceState };
}

/** A request body, which these tests always send as a string. */
const bodyOf = (body: BodyInit | null | undefined): string => (typeof body === "string" ? body : "");

const jsonRes = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

const AUTHORIZE = "https://github.com/login/oauth/authorize?client_id=Iv1&state=s";

beforeEach(() => {
  clearSession();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PKCE", () => {
  it("matches the example in RFC 7636", async () => {
    expect(await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a 43-character verifier and challenge from safe characters, different each time", async () => {
    const v = newVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await challengeFor(v)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newVerifier()).not.toBe(v);
    expect(newState()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("whether the site offers the button", () => {
  it("is on when the function says so, with its install address", async () => {
    const f = vi.fn(async () => jsonRes({ enabled: true, install_url: "https://github.com/apps/x/installations/new" }));
    expect(await fetchAuthConfig(f)).toEqual({ installUrl: "https://github.com/apps/x/installations/new" });
  });

  it("is off on a plain static copy, where the address is a 404 page", async () => {
    expect(await fetchAuthConfig(async () => new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } }))).toBeNull();
  });

  it("is off when the site answers with a page instead of JSON, or says it is not set up, or cannot be reached", async () => {
    expect(await fetchAuthConfig(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }))).toBeNull();
    expect(await fetchAuthConfig(async () => jsonRes({ enabled: false }))).toBeNull();
    expect(await fetchAuthConfig(async () => Promise.reject(new Error("offline")))).toBeNull();
  });

  it("ignores an install address that is not GitHub's", async () => {
    const config = await fetchAuthConfig(async () => jsonRes({ enabled: true, install_url: "https://evil.test/" }));
    expect(config).toEqual({ installUrl: null });
  });
});

describe("starting", () => {
  it("remembers the way back and returns GitHub's address", async () => {
    const { win } = fakeBrowser();
    const f = vi.fn(async () => jsonRes({ authorize_url: AUTHORIZE }));
    const result = await startGithubLogin("acme/widgets", true, f);
    expect(result).toEqual({ ok: true, url: AUTHORIZE });
    expect(win.sessionStorage.getItem("bsf.oauth.repo")).toBe("acme/widgets");
    expect(win.sessionStorage.getItem("bsf.oauth.remember")).toBe("true");
    const state = win.sessionStorage.getItem("bsf.oauth.state");
    const verifier = win.sessionStorage.getItem("bsf.oauth.verifier");
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The function got the state and the challenge, never the verifier.
    const asked = String((f.mock.calls as unknown as [string][])[0]?.[0]);
    expect(asked).toContain(`state=${state}`);
    expect(asked).toContain(`code_challenge=${await challengeFor(verifier ?? "")}`);
    expect(asked).not.toContain(verifier ?? "never");
  });

  it("refuses to navigate anywhere but GitHub's sign-in page", async () => {
    fakeBrowser();
    const result = await startGithubLogin("acme/widgets", false, async () => jsonRes({ authorize_url: "https://evil.test/login" }));
    expect(result.ok).toBe(false);
    expect(result.url).toBeUndefined();
  });

  it("says so when the function is unavailable, the repository is malformed, or storage is blocked", async () => {
    fakeBrowser();
    expect((await startGithubLogin("acme/widgets", false, async () => jsonRes({ error: "x" }, 503))).ok).toBe(false);
    expect((await startGithubLogin("not a repo", false, async () => jsonRes({}))).error).toMatch(/owner\/name/);
    const { win } = fakeBrowser();
    win.sessionStorage.setItem = () => {
      throw new Error("blocked");
    };
    expect((await startGithubLogin("acme/widgets", false, async () => jsonRes({}))).error).toMatch(/blocking storage/);
  });
});

describe("coming back from GitHub", () => {
  /** Start a sign-in, then return the address GitHub would send the browser back to. */
  async function startedAndReturned(extra = "") {
    const { win, replaceState } = fakeBrowser();
    await startGithubLogin("acme/widgets", false, async () => jsonRes({ authorize_url: AUTHORIZE }));
    const state = win.sessionStorage.getItem("bsf.oauth.state");
    const verifier = win.sessionStorage.getItem("bsf.oauth.verifier");
    win.location.search = `?code=abcdef123456&state=${state}${extra}`;
    return { win, replaceState, state, verifier };
  }

  it("does nothing on an ordinary page load", async () => {
    fakeBrowser("?repo=acme/widgets");
    expect((await completeGithubLogin(vi.fn())).handled).toBe(false);
  });

  it("trades the code for a session, sending the verifier and no repository or secret", async () => {
    const { verifier } = await startedAndReturned();
    const now = Date.now();
    const f = vi.fn(async () => jsonRes({ access_token: "ghu_abc", expires_in: 28800, refresh_token: "ghr_def", refresh_token_expires_in: 15897600 }));
    const result = await completeGithubLogin(f);

    expect(result.handled).toBe(true);
    expect(result.session).toMatchObject({ token: "ghu_abc", repo: "acme/widgets", remembered: false, refreshToken: "ghr_def" });
    expect(result.session?.expiresAt).toBeGreaterThanOrEqual(now + 28800 * 1000 - 1000);

    const call = (f.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call?.[0]).toBe("/api/auth/exchange");
    expect(JSON.parse(bodyOf(call?.[1].body))).toEqual({ code: "abcdef123456", code_verifier: verifier });
  });

  it("does not store the session itself: the page checks the repository first", async () => {
    await startedAndReturned();
    await completeGithubLogin(async () => jsonRes({ access_token: "ghu_abc" }));
    expect(readSession()).toBeNull();
  });

  it("cleans the address and spends the stored state, so a reload cannot replay the code", async () => {
    const { win, replaceState } = await startedAndReturned();
    await completeGithubLogin(async () => jsonRes({ access_token: "ghu_abc" }));
    expect(replaceState).toHaveBeenCalledWith({}, "", "https://dash.example.com/");
    expect(win.sessionStorage.getItem("bsf.oauth.state")).toBeNull();
    expect(win.sessionStorage.getItem("bsf.oauth.verifier")).toBeNull();

    const f = vi.fn();
    const again = await completeGithubLogin(f);
    expect(again.error).toBeDefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores a code planted in a link: the state does not match, and nothing is sent", async () => {
    const { win } = fakeBrowser();
    await startGithubLogin("acme/widgets", false, async () => jsonRes({ authorize_url: AUTHORIZE }));
    win.location.search = "?code=abcdef123456&state=someone-elses-state-value";
    const f = vi.fn();
    const result = await completeGithubLogin(f);
    expect(result).toMatchObject({ handled: true });
    expect(result.session).toBeUndefined();
    expect(result.error).toMatch(/did not start from this page/);
    expect(f).not.toHaveBeenCalled();
  });

  it("ignores a code when no sign-in was started here at all", async () => {
    fakeBrowser("?code=abcdef123456&state=whatever-state-value-here");
    const f = vi.fn();
    expect((await completeGithubLogin(f)).error).toBeDefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("says so when the person declines at GitHub", async () => {
    const { win } = fakeBrowser();
    await startGithubLogin("acme/widgets", false, async () => jsonRes({ authorize_url: AUTHORIZE }));
    const state = win.sessionStorage.getItem("bsf.oauth.state");
    win.location.search = `?error=access_denied&state=${state}`;
    const f = vi.fn();
    const result = await completeGithubLogin(f);
    expect(result.error).toMatch(/did not give access/);
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a failed exchange without the function's body", async () => {
    await startedAndReturned();
    const result = await completeGithubLogin(async () => jsonRes({ error: "bad_verification_code" }, 400));
    expect(result.session).toBeUndefined();
    expect(result.error).not.toContain("bad_verification_code");
  });

  it("carries the 'remember' choice across the trip", async () => {
    const { win } = fakeBrowser();
    await startGithubLogin("acme/widgets", true, async () => jsonRes({ authorize_url: AUTHORIZE }));
    win.location.search = `?code=abcdef123456&state=${win.sessionStorage.getItem("bsf.oauth.state")}`;
    const result = await completeGithubLogin(async () => jsonRes({ access_token: "ghu_abc" }));
    expect(result.session?.remembered).toBe(true);
  });
});

describe("renewing", () => {
  const session: Session = {
    token: "ghu_old", repo: "acme/widgets", remembered: false, refreshToken: "ghr_old", expiresAt: 1_000_000_000_000,
  };

  it("is due shortly before the token stops working, and only for a GitHub sign-in", () => {
    const at = session.expiresAt as number;
    expect(needsRefresh(session, at - REFRESH_MARGIN_MS - 1)).toBe(false);
    expect(needsRefresh(session, at - REFRESH_MARGIN_MS)).toBe(true);
    expect(needsRefresh(session, at + 60_000)).toBe(true);
    expect(needsRefresh({ token: "github_pat_x", repo: "a/b", remembered: false }, at + 60_000)).toBe(false);
  });

  it("stores the renewed token and the new refresh token", async () => {
    fakeBrowser();
    const f = vi.fn(async () => jsonRes({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }));
    const result = await refreshSession(session, f);
    expect(result.ok).toBe(true);
    expect(readSession()).toMatchObject({ token: "ghu_new", refreshToken: "ghr_new", repo: "acme/widgets" });
    const call = (f.mock.calls as unknown as [string, RequestInit][])[0];
    expect(call?.[0]).toBe("/api/auth/refresh");
    expect(JSON.parse(bodyOf(call?.[1].body))).toEqual({ refresh_token: "ghr_old" });
  });

  it("shares one renewal between simultaneous callers, because GitHub's refresh token works once", async () => {
    fakeBrowser();
    const f = vi.fn(async () => jsonRes({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }));
    const [a, b] = await Promise.all([refreshSession(session, f), refreshSession(session, f)]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("can renew again after the first settles", async () => {
    fakeBrowser();
    const f = vi.fn(async () => jsonRes({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }));
    await refreshSession(session, f);
    await refreshSession(session, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("says 'ended' when GitHub will not renew it, and 'offline' when the service could not be reached", async () => {
    fakeBrowser();
    expect(await refreshSession(session, async () => jsonRes({ error: "bad_refresh_token" }, 400))).toEqual({ ok: false, reason: "ended" });
    expect(await refreshSession(session, async () => jsonRes({ error: "github_500" }, 502))).toEqual({ ok: false, reason: "offline" });
    expect(await refreshSession(session, async () => Promise.reject(new Error("offline")))).toEqual({ ok: false, reason: "offline" });
  });

  it("cannot renew a pasted token", async () => {
    const f = vi.fn();
    expect(await refreshSession({ token: "github_pat_x", repo: "a/b", remembered: false }, f)).toEqual({ ok: false, reason: "ended" });
    expect(f).not.toHaveBeenCalled();
  });
});
