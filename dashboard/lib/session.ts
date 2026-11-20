"use client";

/**
 * Where the user's token lives.
 *
 * Default is `sessionStorage`, cleared when the tab closes, because a token
 * with write access to someone's repo should not outlive the sitting unless
 * they ask for it. `localStorage` only on an explicit "remember on this
 * device".
 */

const TOKEN_KEY = "bsf.token";
const REPO_KEY = "bsf.repo";
const REMEMBER_KEY = "bsf.remember";

export interface Session {
  readonly token: string;
  readonly repo: string;
  readonly remembered: boolean;
}

function store(remember: boolean): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return remember ? window.localStorage : window.sessionStorage;
  } catch {
    // Storage can be unavailable (private mode, blocked cookies). The app
    // still works for the length of the page.
    return null;
  }
}

let memory: Session | null = null;

export function readSession(): Session | null {
  if (memory !== null) return memory;
  if (typeof window === "undefined") return null;
  for (const remember of [false, true]) {
    const s = store(remember);
    if (s === null) continue;
    const token = s.getItem(TOKEN_KEY);
    const repo = s.getItem(REPO_KEY);
    if (token !== null && token !== "" && repo !== null && repo !== "") {
      return { token, repo, remembered: remember };
    }
  }
  return null;
}

export function writeSession(session: Session): void {
  memory = session;
  const s = store(session.remembered);
  if (s === null) return;
  s.setItem(TOKEN_KEY, session.token);
  s.setItem(REPO_KEY, session.repo);
  s.setItem(REMEMBER_KEY, String(session.remembered));
  // Never leave a copy in the other store.
  const other = store(!session.remembered);
  other?.removeItem(TOKEN_KEY);
}

export function clearSession(): void {
  memory = null;
  for (const remember of [false, true]) {
    const s = store(remember);
    s?.removeItem(TOKEN_KEY);
    s?.removeItem(REPO_KEY);
    s?.removeItem(REMEMBER_KEY);
  }
}

/** owner/name, and nothing else. */
export function validRepo(value: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value.trim());
}

/**
 * A fine-grained token starts github_pat_, a classic one ghp_. Anything else
 * is probably a paste accident, and saying so beats a 401 later.
 */
export function looksLikeToken(value: string): boolean {
  const v = value.trim();
  if (v.length < 20) return false;
  return /^(github_pat_|ghp_|gho_|ghu_|ghs_)/.test(v) || /^[A-Za-z0-9_-]{40,}$/.test(v);
}

/* --------------------------------------------------------------- GitHub login */

/**
 * The optional sign-in Worker (`/worker`). The dashboard works without it —
 * the user pastes a fine-grained token instead — so every function here
 * reports "not configured" rather than failing, and nothing calls it unless
 * the deployment set its URL.
 */

const STATE_KEY = "bsf.oauth.state";
const PENDING_REPO_KEY = "bsf.oauth.repo";

export function workerUrl(): string | null {
  const url = process.env["NEXT_PUBLIC_SIGNIN_WORKER"];
  return url === undefined || url === "" ? null : url.replace(/\/$/, "");
}

/** A state value the callback can check, so a stray code cannot be replayed. */
function newState(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StartResult {
  readonly ok: boolean;
  readonly url?: string;
  readonly error?: string;
}

/** Ask the Worker where to send the user, remember the state, and hand it back. */
export async function startGithubLogin(repo: string): Promise<StartResult> {
  const base = workerUrl();
  if (base === null) return { ok: false, error: "no sign-in Worker is configured for this dashboard" };
  if (!validRepo(repo)) return { ok: false, error: "enter the repository as owner/name" };

  const state = newState();
  try {
    // sessionStorage, not localStorage: the state is for this sitting only.
    window.sessionStorage.setItem(STATE_KEY, state);
    window.sessionStorage.setItem(PENDING_REPO_KEY, repo.trim());
  } catch {
    return { ok: false, error: "this browser is blocking storage, so sign-in cannot complete; paste a token instead" };
  }

  const redirect = `${window.location.origin}${window.location.pathname}`;
  const res = await fetch(`${base}/start?redirect_uri=${encodeURIComponent(redirect)}&state=${state}`);
  if (!res.ok) return { ok: false, error: `the sign-in Worker answered ${res.status}` };
  const body = (await res.json()) as { authorize_url?: string; error?: string };
  if (body.authorize_url === undefined) return { ok: false, error: body.error ?? "the Worker returned no URL" };
  return { ok: true, url: body.authorize_url };
}

export interface CallbackResult {
  readonly handled: boolean;
  readonly session?: Session;
  readonly error?: string;
}

/**
 * Finish the login if this page load is the OAuth callback.
 *
 * The state must match what was stored, or the code is ignored: a `?code=` a
 * third party put in a link is exactly what that check is for. The query
 * string is cleared either way, so a reload cannot replay it and the code
 * does not sit in the address bar or in history.
 */
export async function completeGithubLogin(remember = false): Promise<CallbackResult> {
  if (typeof window === "undefined") return { handled: false };
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (code === null || state === null) return { handled: false };

  const clean = (): void => {
    window.history.replaceState({}, "", `${window.location.origin}${window.location.pathname}`);
  };

  let expected: string | null = null;
  let repo: string | null = null;
  try {
    expected = window.sessionStorage.getItem(STATE_KEY);
    repo = window.sessionStorage.getItem(PENDING_REPO_KEY);
    window.sessionStorage.removeItem(STATE_KEY);
    window.sessionStorage.removeItem(PENDING_REPO_KEY);
  } catch {
    /* handled below */
  }
  clean();

  if (expected === null || state !== expected) {
    return { handled: true, error: "this sign-in did not start here, so it was not completed" };
  }
  if (repo === null || !validRepo(repo)) {
    return { handled: true, error: "the repository was lost between steps; try signing in again" };
  }

  const base = workerUrl();
  if (base === null) return { handled: true, error: "no sign-in Worker is configured for this dashboard" };

  const res = await fetch(`${base}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirect_uri: `${window.location.origin}${window.location.pathname}` }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || body.access_token === undefined) {
    return { handled: true, error: body.error ?? `the sign-in Worker answered ${res.status}` };
  }

  const session: Session = { token: body.access_token, repo, remembered: remember };
  writeSession(session);
  return { handled: true, session };
}
