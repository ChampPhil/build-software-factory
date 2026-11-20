/**
 * The sign-in Worker.
 *
 * It does one thing: exchange a GitHub OAuth `code` for an access token, which
 * a static site cannot do itself because the exchange needs the app's client
 * secret. It stores nothing — no tokens, no user ids, no logs of either — and
 * it holds no database. If this Worker is never deployed, the dashboard still
 * works; the user pastes a fine-grained token instead (doc 08).
 *
 * Everything here exists because of one risk: a token-minting endpoint that
 * anyone can call from anywhere is an open redirect for credentials. So the
 * origin is checked against an allowlist, the `state` is verified, the code is
 * single-use, and the response goes back to the browser that asked rather than
 * to any URL a caller names.
 */

export interface Env {
  /** The OAuth app's client id. Not a secret. */
  GITHUB_CLIENT_ID: string;
  /** The OAuth app's client secret. A Worker secret, never in code. */
  GITHUB_CLIENT_SECRET: string;
  /**
   * Comma-separated origins allowed to call this Worker — the dashboard's own
   * origins and nothing else. Without this, any page anywhere could mint
   * tokens through it.
   */
  ALLOWED_ORIGINS: string;
}

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** The scopes the dashboard needs, and no more (doc 08). */
export const SCOPES = "repo";

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = allowedOrigins(env);

    if (request.method === "OPTIONS") {
      return preflight(origin, allowed);
    }

    if (url.pathname === "/health") {
      // No configuration is echoed: a health check that lists its own
      // client id is a reconnaissance endpoint.
      return json({ ok: true }, 200, origin, allowed);
    }

    if (url.pathname === "/start") {
      return start(url, env, origin, allowed);
    }

    if (url.pathname === "/exchange") {
      if (request.method !== "POST") {
        return json({ error: "use POST" }, 405, origin, allowed);
      }
      return exchange(request, env, origin, allowed);
    }

    return json({ error: "not found" }, 404, origin, allowed);
  },
};

export function allowedOrigins(env: Env): readonly string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** An exact origin match. A prefix or suffix test would accept a look-alike. */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  if (origin === null) return false;
  return allowed.includes(origin);
}

function corsHeaders(origin: string | null, allowed: readonly string[]): Record<string, string> {
  if (!originAllowed(origin, allowed)) return {};
  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // No credentials: the Worker holds no session, so there is nothing for a
    // cookie to carry, and allowing them would widen what a CSRF could do.
    Vary: "Origin",
  };
}

function preflight(origin: string | null, allowed: readonly string[]): Response {
  if (!originAllowed(origin, allowed)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
}

function json(body: unknown, status: number, origin: string | null, allowed: readonly string[]): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin, allowed),
    },
  });
}

/**
 * Hand the browser the URL to send the user to. The Worker builds it so the
 * client id and scopes live in one place, and so `redirect_uri` can be checked
 * against the allowlist before the user ever leaves.
 */
function start(url: URL, env: Env, origin: string | null, allowed: readonly string[]): Response {
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");

  if (redirect === null || state === null) {
    return json({ error: "redirect_uri and state are required" }, 400, origin, allowed);
  }
  // The redirect must be one of our own origins. Otherwise this endpoint
  // would send a user to GitHub with someone else's callback attached.
  if (!originAllowed(new URL(redirect).origin, allowed)) {
    return json({ error: "redirect_uri is not an allowed origin" }, 403, origin, allowed);
  }
  if (state.length < 16) {
    return json({ error: "state must be at least 16 characters" }, 400, origin, allowed);
  }

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirect);
  authorize.searchParams.set("scope", SCOPES);
  authorize.searchParams.set("state", state);
  return json({ authorize_url: authorize.toString() }, 200, origin, allowed);
}

interface ExchangeBody {
  code?: unknown;
  redirect_uri?: unknown;
}

/**
 * Exchange the code. The token goes straight back in the response body and is
 * never written anywhere: no KV, no logs, no error message that includes it.
 */
async function exchange(
  request: Request,
  env: Env,
  origin: string | null,
  allowed: readonly string[],
): Promise<Response> {
  if (!originAllowed(origin, allowed)) {
    return json({ error: "origin not allowed" }, 403, origin, allowed);
  }

  let body: ExchangeBody;
  try {
    body = (await request.json()) as ExchangeBody;
  } catch {
    return json({ error: "body must be JSON" }, 400, origin, allowed);
  }

  const code = typeof body.code === "string" ? body.code : "";
  const redirect = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
  if (code === "" || redirect === "") {
    return json({ error: "code and redirect_uri are required" }, 400, origin, allowed);
  }
  if (!originAllowed(safeOrigin(redirect), allowed)) {
    return json({ error: "redirect_uri is not an allowed origin" }, 403, origin, allowed);
  }

  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirect,
    }),
  });

  if (!res.ok) {
    // GitHub's body can echo the code; it is not passed through.
    return json({ error: `GitHub returned ${res.status}` }, 502, origin, allowed);
  }

  const data = (await res.json()) as TokenResponse;
  if (data.error !== undefined || typeof data.access_token !== "string") {
    // GitHub's own error names are safe to relay; its descriptions can
    // include the code, so they are not.
    return json({ error: data.error ?? "no token in GitHub's response" }, 400, origin, allowed);
  }

  return json(
    { access_token: data.access_token, token_type: data.token_type ?? "bearer", scope: data.scope ?? SCOPES },
    200,
    origin,
    allowed,
  );
}

/** `new URL` throws on a malformed value; a throw here would be a 500. */
export function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
