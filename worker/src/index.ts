/**
 * "Sign in with GitHub", the server half.
 *
 * It runs as a Cloudflare Pages Function on the dashboard's own address
 * (`functions/api/auth/[[route]].ts` hands every request here), so the browser
 * only ever talks to the site it is already on. That removes the usual
 * hazards of a token-minting endpoint: there is no cross-origin access to
 * allow, no list of origins to keep right, and the callback address is the
 * site's own, never one a caller names.
 *
 * What it does is the one step a static page cannot: GitHub's token exchange
 * needs the app's client secret, and GitHub does not answer cross-origin
 * requests to it. It stores nothing: no tokens, no user ids, no database, no
 * logs of either. If it is not configured the sign-in page does not show the
 * button, and the token form (doc 08) is all there is.
 *
 * Tokens are GitHub App user tokens. They carry no scopes: what one can do is
 * what the app was given AND what the person can do, on the repositories the
 * app is installed on. They last 8 hours and come with a refresh token.
 */

export interface Env {
  /** The GitHub App's client id (not its app id). Not a secret. */
  GITHUB_APP_CLIENT_ID?: string | undefined;
  /** The app's client secret. A Pages secret, never in code. */
  GITHUB_APP_CLIENT_SECRET?: string | undefined;
  /** The app's slug, from its public address, for the install link. Not a secret. */
  GITHUB_APP_SLUG?: string | undefined;
}

const API = "/api/auth";
const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** The route a request is for, or null when it is not under /api/auth. */
function routeOf(url: URL): string | null {
  if (url.pathname === API) return "/";
  return url.pathname.startsWith(`${API}/`) ? url.pathname.slice(API.length) : null;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
/** A PKCE challenge is the unpadded base64url of a SHA-256: always 43 characters. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636: 43 to 128 characters from this set. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const REFRESH_TOKEN = /^ghr_[A-Za-z0-9_]{20,}$/;
const CODE = /^[A-Za-z0-9_-]{8,128}$/;

export function configured(env: Env): boolean {
  const id = env.GITHUB_APP_CLIENT_ID ?? "";
  const secret = env.GITHUB_APP_CLIENT_SECRET ?? "";
  const slug = env.GITHUB_APP_SLUG ?? "";
  return id !== "" && secret !== "" && SLUG.test(slug);
}

export function installUrl(env: Env): string | null {
  const slug = env.GITHUB_APP_SLUG ?? "";
  return SLUG.test(slug) ? `https://github.com/apps/${slug}/installations/new` : null;
}

function json(body: unknown, status = 200): Response {
  // No CORS headers on purpose: the dashboard calls this from its own origin,
  // and nothing else should be able to read a response that may hold a token.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = routeOf(url);
    if (route === null) return json({ error: "not found" }, 404);

    if (route === "/health") return json({ ok: true });

    if (route === "/config") {
      if (request.method !== "GET") return json({ error: "use GET" }, 405);
      // Says whether the button should exist, and nothing about the
      // configuration beyond the public install address.
      return configured(env) ? json({ enabled: true, install_url: installUrl(env) }) : json({ enabled: false });
    }

    if (route === "/start") {
      if (request.method !== "GET") return json({ error: "use GET" }, 405);
      return start(url, env);
    }

    if (route === "/exchange" || route === "/refresh") {
      if (request.method !== "POST") return json({ error: "use POST" }, 405);
      return route === "/exchange" ? exchange(request, url, env) : refresh(request, url, env);
    }

    return json({ error: "not found" }, 404);
  },
};

/** The address GitHub sends the person back to: the dashboard's own front page, and nothing a caller picks. */
export function callbackUrl(url: URL): string {
  return `${url.origin}/`;
}

/**
 * Hand the browser the address to send the person to. The client id lives
 * here, and the callback is computed from the request, so it cannot be bent to
 * another site.
 */
function start(url: URL, env: Env): Response {
  if (!configured(env)) return json({ error: "sign-in with GitHub is not set up here" }, 503);

  const state = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  if (!STATE.test(state)) return json({ error: "state must be 16 to 128 letters, digits, - or _" }, 400);
  if (!CHALLENGE.test(challenge)) return json({ error: "code_challenge must be a 43-character SHA-256 challenge" }, 400);

  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID as string);
  authorize.searchParams.set("redirect_uri", callbackUrl(url));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return json({ authorize_url: authorize.toString() });
}

/**
 * A request that would mint or renew a token must come from this site's own
 * pages. Browsers always send Origin on a cross-site POST, so a page on
 * another address cannot get a token through here, and a request with no
 * Origin (a script, not a page) is turned away too.
 */
function fromThisSite(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface GitHubTokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  refresh_token_expires_in?: unknown;
  error?: unknown;
}

/** What goes back to the browser: the token fields, and nothing GitHub happened to add. */
function tokenReply(data: GitHubTokenResponse): Response {
  if (typeof data.error === "string" || typeof data.access_token !== "string") {
    // GitHub's own error names are safe to relay; its descriptions can echo the
    // code, so they are not.
    const name = typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error) ? data.error : "no_token";
    return json({ error: name }, 400);
  }
  const reply: Record<string, unknown> = { access_token: data.access_token };
  if (typeof data.expires_in === "number") reply["expires_in"] = data.expires_in;
  if (typeof data.refresh_token === "string") reply["refresh_token"] = data.refresh_token;
  if (typeof data.refresh_token_expires_in === "number") reply["refresh_token_expires_in"] = data.refresh_token_expires_in;
  return json(reply);
}

async function callGitHub(params: Record<string, string>, env: Env): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        ...params,
      }),
    });
  } catch {
    return json({ error: "github_unreachable" }, 502);
  }
  // GitHub's body can echo the code; a failure is reported by status alone.
  if (!res.ok) return json({ error: `github_${res.status}` }, 502);
  try {
    return tokenReply((await res.json()) as GitHubTokenResponse);
  } catch {
    return json({ error: "no_token" }, 502);
  }
}

/**
 * Trade the one-time code for a token. The token goes straight back in the
 * response and is never written anywhere: no KV, no logs, no error message
 * that includes it.
 */
async function exchange(request: Request, url: URL, env: Env): Promise<Response> {
  if (!configured(env)) return json({ error: "sign-in with GitHub is not set up here" }, 503);
  if (!fromThisSite(request, url)) return json({ error: "this request must come from the dashboard itself" }, 403);

  const body = await readBody(request);
  if (body === null) return json({ error: "body must be JSON" }, 400);
  const code = typeof body["code"] === "string" ? body["code"] : "";
  const verifier = typeof body["code_verifier"] === "string" ? body["code_verifier"] : "";
  if (!CODE.test(code)) return json({ error: "code is missing or malformed" }, 400);
  if (!VERIFIER.test(verifier)) return json({ error: "code_verifier is missing or malformed" }, 400);

  return callGitHub({ code, code_verifier: verifier, redirect_uri: callbackUrl(url) }, env);
}

/**
 * Renew a token with its refresh token. GitHub rotates it: the old refresh
 * token stops working the moment this succeeds, so the browser must keep the
 * new one.
 */
async function refresh(request: Request, url: URL, env: Env): Promise<Response> {
  if (!configured(env)) return json({ error: "sign-in with GitHub is not set up here" }, 503);
  if (!fromThisSite(request, url)) return json({ error: "this request must come from the dashboard itself" }, 403);

  const body = await readBody(request);
  if (body === null) return json({ error: "body must be JSON" }, 400);
  const token = typeof body["refresh_token"] === "string" ? body["refresh_token"] : "";
  if (!REFRESH_TOKEN.test(token)) return json({ error: "refresh_token is missing or malformed" }, 400);

  return callGitHub({ grant_type: "refresh_token", refresh_token: token }, env);
}
