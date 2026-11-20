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
