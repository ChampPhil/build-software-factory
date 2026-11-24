"use client";

/**
 * "Sign in with GitHub", the browser half.
 *
 * The person is sent to GitHub, approves the Software Factory app, and comes
 * back with a one-time code. The code is traded for a token by the site's own
 * `/api/auth` function (`worker/src/index.ts`), which holds the app's secret.
 * Everything here talks to that function on the same address, never to another
 * server, and the token it returns is then used against GitHub's API only.
 *
 * The flow is protected twice. `state` ties the way back to the way out, so a
 * `?code=` someone plants in a link is ignored. PKCE ties the code to this
 * browser, so a code that leaks cannot be redeemed by anyone else.
 */

import { validRepo, writeSession, type Session } from "./session";

const AUTH = "/api/auth";
const AUTHORIZE_PREFIX = "https://github.com/login/oauth/authorize?";

const STATE_KEY = "bsf.oauth.state";
const VERIFIER_KEY = "bsf.oauth.verifier";
const PENDING_REPO_KEY = "bsf.oauth.repo";
const PENDING_REMEMBER_KEY = "bsf.oauth.remember";

/** Renew this long before the token stops working, so no request ever carries a dead one. */
export const REFRESH_MARGIN_MS = 2 * 60 * 1000;

type Fetch = typeof fetch;
// A wrapper rather than `fetch` itself: calling a stored reference to the
// browser's fetch as a method of another object throws "Illegal invocation".
const defaultFetch: Fetch = (input, init) => fetch(input, init);

/* ------------------------------------------------------------------ PKCE */

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** 32 random bytes as 43 characters, the length PKCE wants. */
export function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The SHA-256 challenge for a verifier, unpadded base64url, always 43 characters. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A state value the callback can check. */
export function newState(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/* ---------------------------------------------------------------- config */

export interface AuthConfig {
  /** Where to install the app on a repository, or null when the site did not say. */
  readonly installUrl: string | null;
}

/**
 * Whether this site offers "Sign in with GitHub". It does when the function is
 * deployed and set up; on a plain static copy the address does not exist, and
 * the answer is null, which means the token form is all there is.
 */
export async function fetchAuthConfig(f: Fetch = defaultFetch): Promise<AuthConfig | null> {
  try {
    const res = await f(`${AUTH}/config`);
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return null;
    const body = (await res.json()) as { enabled?: unknown; install_url?: unknown };
    if (body.enabled !== true) return null;
    const url = typeof body.install_url === "string" && body.install_url.startsWith("https://github.com/apps/")
      ? body.install_url
      : null;
    return { installUrl: url };
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- start */

export interface StartResult {
  readonly ok: boolean;
  /** Where to send the browser. */
  readonly url?: string;
  readonly error?: string;
}

/** Remember what the way back needs, then ask the site where to send the person. */
/**
 * Start the GitHub sign-in.
 *
 * `repo` may be empty. Nobody arrives at this dashboard cold — they arrive
 * from a link setup gave them, which names the repository — but when that link
 * never reached them, being made to type `owner/name` from memory before the
 * sign-in button will even light up is a wall in front of the first thing they
 * came to do. Signing in first and then picking from the repositories the app
 * is actually installed on is the same information, without the typing.
 */
export async function startGithubLogin(repo: string, remember: boolean, f: Fetch = defaultFetch): Promise<StartResult> {
  if (repo !== "" && !validRepo(repo)) return { ok: false, error: "Enter the repository as owner/name." };

  const state = newState();
  const verifier = newVerifier();
  try {
    // sessionStorage, not localStorage: this is for the one trip to GitHub and back.
    window.sessionStorage.setItem(STATE_KEY, state);
    window.sessionStorage.setItem(VERIFIER_KEY, verifier);
    window.sessionStorage.setItem(PENDING_REPO_KEY, repo.trim());
    window.sessionStorage.setItem(PENDING_REMEMBER_KEY, String(remember));
  } catch {
    return { ok: false, error: "This browser is blocking storage, so signing in with GitHub cannot finish. Use a token instead." };
  }

  try {
    const challenge = await challengeFor(verifier);
    const res = await f(`${AUTH}/start?state=${encodeURIComponent(state)}&code_challenge=${encodeURIComponent(challenge)}`);
    const body = (await res.json().catch(() => ({}))) as { authorize_url?: unknown };
    if (!res.ok || typeof body.authorize_url !== "string") {
      return { ok: false, error: "Signing in with GitHub is not available right now. Use a token instead." };
    }
    // Only ever navigate to GitHub's own sign-in page.
    if (!body.authorize_url.startsWith(AUTHORIZE_PREFIX)) {
      return { ok: false, error: "The site returned an unexpected address, so nothing was opened." };
    }
    return { ok: true, url: body.authorize_url };
  } catch {
    return { ok: false, error: "Could not reach the sign-in service. Check your connection, or use a token instead." };
  }
}

/* -------------------------------------------------------------- callback */

export interface CallbackResult {
  /** This page load was GitHub's way back, whether or not it worked. */
  readonly handled: boolean;
  readonly session?: Session;
  readonly error?: string;
}

function takePending(): { state: string | null; verifier: string | null; repo: string | null; remember: boolean } {
  let state: string | null = null;
  let verifier: string | null = null;
  let repo: string | null = null;
  let remember = false;
  try {
    state = window.sessionStorage.getItem(STATE_KEY);
    verifier = window.sessionStorage.getItem(VERIFIER_KEY);
    repo = window.sessionStorage.getItem(PENDING_REPO_KEY);
    remember = window.sessionStorage.getItem(PENDING_REMEMBER_KEY) === "true";
    for (const key of [STATE_KEY, VERIFIER_KEY, PENDING_REPO_KEY, PENDING_REMEMBER_KEY]) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    /* handled by the caller: a null state fails the check */
  }
  return { state, verifier, repo, remember };
}

/**
 * Finish the sign-in if this page load is GitHub's way back. Returns the
 * session without storing it: the caller checks the repository is reachable
 * first, so a person who has not installed the app yet is told so instead of
 * landing on an empty dashboard.
 *
 * The address is cleaned either way, so a reload cannot replay the code and it
 * does not sit in history.
 */
export async function completeGithubLogin(f: Fetch = defaultFetch): Promise<CallbackResult> {
  if (typeof window === "undefined") return { handled: false };
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const denied = params.get("error");
  if (state === null || (code === null && denied === null)) return { handled: false };

  const pending = takePending();
  window.history.replaceState({}, "", `${window.location.origin}${window.location.pathname}`);

  if (pending.state === null || state !== pending.state) {
    return { handled: true, error: "That sign-in did not start from this page, so it was not completed. Try again." };
  }
  if (denied !== null) {
    return { handled: true, error: "GitHub did not give access, so you are not signed in." };
  }
  if (code === null || pending.verifier === null) {
    return { handled: true, error: "The sign-in was interrupted. Try again." };
  }
  // An empty repository is a deliberate choice, not a loss: the person signed
  // in without naming one and picks from their installations on the way back.
  // Anything non-empty still has to be a real `owner/name`.
  if (pending.repo === null) {
    return { handled: true, error: "The sign-in was interrupted on the way to GitHub. Try again." };
  }
  if (pending.repo !== "" && !validRepo(pending.repo)) {
    return { handled: true, error: "The repository was lost on the way to GitHub. Enter it and try again." };
  }

  let res: Response;
  try {
    res = await f(`${AUTH}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: pending.verifier }),
    });
  } catch {
    return { handled: true, error: "Could not reach the sign-in service. Try again." };
  }
  const body = (await res.json().catch(() => ({}))) as TokenFields;
  const session = sessionFrom(body, pending.repo, pending.remember, Date.now());
  if (!res.ok || session === null) {
    return { handled: true, error: "GitHub would not finish the sign-in. Try again, or use a token instead." };
  }
  return { handled: true, session };
}

interface TokenFields {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
}

function sessionFrom(body: TokenFields, repo: string, remembered: boolean, now: number): Session | null {
  if (typeof body.access_token !== "string" || body.access_token === "") return null;
  return {
    token: body.access_token,
    repo,
    remembered,
    ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
    ...(typeof body.expires_in === "number" ? { expiresAt: now + body.expires_in * 1000 } : {}),
  };
}

/* --------------------------------------------------------------- refresh */

/** Whether this session's token is expired or about to be, and can be renewed. */
export function needsRefresh(session: Session, now: number = Date.now()): boolean {
  return (
    session.refreshToken !== undefined &&
    session.expiresAt !== undefined &&
    now >= session.expiresAt - REFRESH_MARGIN_MS
  );
}

export type RefreshResult =
  | { readonly ok: true; readonly session: Session }
  /** `ended`: GitHub will not renew it (revoked, or past six months), so sign in again. `offline`: try again later. */
  | { readonly ok: false; readonly reason: "ended" | "offline" };

let inflight: Promise<RefreshResult> | null = null;

/**
 * Renew the token. GitHub rotates the refresh token, so two renewals at once
 * would spend it twice and the second would fail; callers share one.
 */
export function refreshSession(session: Session, f: Fetch = defaultFetch): Promise<RefreshResult> {
  if (session.refreshToken === undefined) return Promise.resolve({ ok: false, reason: "ended" });
  if (inflight !== null) return inflight;
  const refreshToken = session.refreshToken;
  const run = async (): Promise<RefreshResult> => {
    try {
      const res = await f(`${AUTH}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (res.status === 400 || res.status === 403) return { ok: false, reason: "ended" };
      if (!res.ok) return { ok: false, reason: "offline" };
      const next = sessionFrom((await res.json()) as TokenFields, session.repo, session.remembered, Date.now());
      if (next === null) return { ok: false, reason: "offline" };
      writeSession(next);
      return { ok: true, session: next };
    } catch {
      return { ok: false, reason: "offline" };
    }
  };
  const promise = run();
  inflight = promise;
  // Cleared once it settles, so the next renewal starts fresh.
  void promise.then(() => {
    if (inflight === promise) inflight = null;
  });
  return promise;
}
