"use client";

/**
 * Where the user's token lives.
 *
 * The token stays in this browser. It is never put in a cookie, because a
 * cookie is sent to this site's host on every page load, and the host is not
 * supposed to see a GitHub token.
 *
 * Every tab of one browser sitting shares one copy, in localStorage. A
 * sitting is one run of the browser: it covers every tab and window, and it
 * ends when the browser quits. A cookie with no expiry marks that the sitting
 * is still open. That cookie's value is the flag "1", never the token. When
 * the browser quits, the cookie goes, and the next visit throws the shared
 * copy away.
 *
 * "Remember on this device" is the only case that outlives the sitting.
 *
 * A sign-in from an older version of this page lived in sessionStorage, which
 * belongs to one tab. The first read of that copy moves it into the shared
 * store, so the next tab does not have to ask again.
 */

import { DEMO_REPO, DEMO_TOKEN } from "./demo";

const TOKEN_KEY = "bsf.token";
const REPO_KEY = "bsf.repo";
const REPOS_KEY = "bsf.repos";
const REMEMBER_KEY = "bsf.remember";
const REFRESH_KEY = "bsf.refresh";
const EXPIRES_KEY = "bsf.expires";

/** The keys that make up a sign-in. The theme, and the trip to GitHub and back, use other names. */
const SESSION_KEYS = [TOKEN_KEY, REPO_KEY, REPOS_KEY, REMEMBER_KEY, REFRESH_KEY, EXPIRES_KEY] as const;

/**
 * Marks that this browser sitting is still open.
 *
 * No expiry date: the browser deletes it when the sitting ends, and every
 * tab of that sitting can see it. The value is a flag, never a token.
 */
const SITTING_COOKIE = "bsf.sitting";

export interface Session {
  readonly token: string;
  /** The repository the pages show. */
  readonly repo: string;
  /**
   * Every repository connected with this sign-in, oldest first.
   * The first connection is the start of the list. Absent on a session
   * object that was built before the list was read back.
   */
  readonly repos?: readonly string[];
  readonly remembered: boolean;
  /**
   * Present only for a "Sign in with GitHub" session. Those tokens last 8
   * hours, and this renews them without sending the person back to GitHub.
   * A pasted token has neither field.
   */
  readonly refreshToken?: string;
  /** When `token` stops working, in milliseconds since the epoch. */
  readonly expiresAt?: number;
}

/**
 * The store every tab of this site can read.
 *
 * localStorage is per origin, so a second tab sees the same copy. It also
 * survives quitting the browser, which is why a sign-in that was not
 * remembered still needs the sitting cookie: the cookie is what ends it.
 */
function sharedStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can be unavailable (private mode, blocked storage). The app
    // still works for the length of this tab, from the in-memory copy.
    return null;
  }
}

/**
 * The per-tab store.
 *
 * Older versions kept the sign-in here, which is why a new tab asked again.
 * The trip to GitHub and back still uses it, under different keys, because
 * that trip returns to the same tab.
 */
function tabStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let memory: Session | null = null;

/**
 * Add a repository to the connected list.
 *
 * The first connection is the start of the list. A later one is appended.
 * A name that is already there, or that is not owner/name, is left out.
 * The pages do not change which repository they show; that is selectRepo.
 *
 * repos: the repositories already connected, oldest first.
 * repo: the repository to connect, as owner/name.
 */
export function connectRepo(repos: readonly string[], repo: string): readonly string[] {
  const seen: string[] = [];
  for (const entry of repos) {
    const name = entry.trim();
    if (!validRepo(name) || seen.includes(name)) continue;
    seen.push(name);
  }
  const add = repo.trim();
  if (validRepo(add) && !seen.includes(add)) seen.push(add);
  return seen;
}

/**
 * Which connected repository the pages should show.
 *
 * The choice has to be one already connected. Anything else leaves the
 * current repository in place, so a stray value cannot blank the dashboard.
 *
 * repos: the connected repositories, oldest first.
 * current: the repository the pages show now.
 * next: the repository the person chose.
 */
export function selectRepo(repos: readonly string[], current: string, next: string): string {
  const name = next.trim();
  return repos.some((entry) => entry.trim() === name) ? name : current;
}

/** The connected list stored beside the session, or empty when the value is missing or junk. */
function parseRepos(raw: string | null): readonly string[] {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    let list: readonly string[] = [];
    for (const item of parsed) if (typeof item === "string") list = connectRepo(list, item);
    return list;
  } catch {
    return [];
  }
}

/**
 * Read a sign-in out of one store.
 *
 * s: the store to read. Null when that store does not exist.
 * Returns null when the token or the repository is missing, which is how an
 * empty store and a half-written one both look.
 */
function readFrom(s: Storage | null): Session | null {
  if (s === null) return null;
  const token = s.getItem(TOKEN_KEY);
  const repo = s.getItem(REPO_KEY);
  if (token === null || token === "" || repo === null || repo === "") return null;
  const refreshToken = s.getItem(REFRESH_KEY);
  const expires = Number(s.getItem(EXPIRES_KEY));
  // A session saved before the list existed still has one repository: this one.
  const repos = connectRepo(parseRepos(s.getItem(REPOS_KEY)), repo);
  return {
    token,
    repo,
    repos,
    remembered: s.getItem(REMEMBER_KEY) === "true",
    ...(refreshToken !== null && refreshToken !== "" ? { refreshToken } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: expires } : {}),
  };
}

/** Remove every sign-in key from one store. Leaves the theme and the GitHub trip alone. */
function scrub(s: Storage | null): void {
  if (s === null) return;
  for (const key of SESSION_KEYS) s.removeItem(key);
}

/**
 * Whether this browser sitting is still open.
 *
 * True when the sitting cookie is present. Also true when there is no
 * document, which is the test runner: there the store itself is the source
 * of truth, and a real browser always has a document.
 */
function sittingOpen(): boolean {
  const doc = globalThis.document;
  if (doc === undefined) return true;
  return doc.cookie.split(";").some((part) => {
    const item = part.trim();
    return item.startsWith(`${SITTING_COOKIE}=`) && item.length > SITTING_COOKIE.length + 1;
  });
}

/**
 * Mark this browser sitting as open.
 *
 * A session cookie has no Max-Age and no Expires, so the browser deletes it
 * when the sitting ends and shares it with every tab until then. Secure only
 * on https, so a local http preview can still set it.
 */
function markSitting(): void {
  const doc = globalThis.document;
  if (doc === undefined || typeof window === "undefined") return;
  const secure = window.location?.protocol === "https:" ? "; Secure" : "";
  doc.cookie = `${SITTING_COOKIE}=1; Path=/; SameSite=Lax${secure}`;
}

/** Delete the sitting marker. The shared copy is cleared by the caller. */
function endSitting(): void {
  const doc = globalThis.document;
  if (doc === undefined) return;
  doc.cookie = `${SITTING_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/**
 * The sign-in this tab should show.
 *
 * Returns the copy this tab just wrote, when it has one. Otherwise the shared
 * copy. A shared copy that was not remembered is dropped when the sitting
 * cookie is gone, which is the visit after the browser quit.
 */
export function readSession(): Session | null {
  if (memory !== null) return memory;
  return readStored();
}

/**
 * Read the sign-in from storage again, dropping this tab's cached copy first.
 *
 * Another tab writes the shared copy. This tab would keep showing its cached
 * copy until that cache was dropped, so a storage event comes through here.
 *
 * Returns the session now in storage, or null when there is none.
 */
export function reloadSession(): Session | null {
  memory = null;
  return readStored();
}

/**
 * The sign-in a token renewal should start from.
 *
 * Prefers the shared copy, so two tabs do not each spend a refresh token
 * that GitHub only honors once. When that copy is gone in a real browser,
 * returns null: a sign-out in another tab, or a sitting that ended, must not
 * be undone by writing this tab's old token back. The fallback is used when
 * there is no document (the test runner), or when storage itself is blocked
 * and this tab is holding the only copy.
 *
 * fallback: the sign-in this tab was already holding.
 */
export function sessionToRenew(fallback: Session): Session | null {
  const cached = memory;
  const stored = reloadSession();
  if (stored !== null) return stored;
  if (globalThis.document === undefined) return fallback;
  if (sharedStore() === null) {
    memory = cached;
    return cached ?? fallback;
  }
  return null;
}

/**
 * The shared copy, or a per-tab copy left by an older version of this page.
 *
 * The older copy is written into the shared store on the way out, so the
 * next tab does not have to ask again.
 */
function readStored(): Session | null {
  const shared = readFrom(sharedStore());
  if (shared !== null) {
    if (!shared.remembered && !sittingOpen()) {
      clearSession();
      return null;
    }
    return shared;
  }
  const legacy = readFrom(tabStore());
  if (legacy === null) return null;
  return writeSession(legacy);
}

export function writeSession(session: Session): Session {
  const s = sharedStore();
  // Keep repositories already stored when the caller did not bring the list,
  // then make sure the active one is on it. The first write starts the list.
  const stored = parseRepos(s?.getItem(REPOS_KEY) ?? null);
  const repos = connectRepo(session.repos ?? stored, session.repo);
  const saved: Session = { ...session, repos };
  memory = saved;
  if (s !== null) {
    s.setItem(TOKEN_KEY, session.token);
    s.setItem(REPO_KEY, session.repo);
    s.setItem(REPOS_KEY, JSON.stringify(repos));
    s.setItem(REMEMBER_KEY, String(session.remembered));
    if (session.refreshToken !== undefined) s.setItem(REFRESH_KEY, session.refreshToken);
    else s.removeItem(REFRESH_KEY);
    if (session.expiresAt !== undefined) s.setItem(EXPIRES_KEY, String(session.expiresAt));
    else s.removeItem(EXPIRES_KEY);
  }
  // A per-tab copy would not be visible to any other tab, and a later read
  // could bring it back after a sign-out. Only the session keys go; the
  // GitHub trip keeps its own keys until that same tab comes back.
  scrub(tabStore());
  if (!session.remembered) markSitting();
  return saved;
}

export function clearSession(): void {
  memory = null;
  scrub(sharedStore());
  scrub(tabStore());
  endSitting();
}

/** The repository a link names, as `?repo=owner/name`, or null when there is none or it is malformed. */
export function repoFromAddress(search: string): string | null {
  const value = new URLSearchParams(search).get("repo");
  return value !== null && validRepo(value) ? value.trim() : null;
}

/** Whether the address asks for the demo, as `?demo`. */
export function demoFromAddress(search: string): boolean {
  return new URLSearchParams(search).has("demo");
}

/**
 * Start the demo. It is stored for this browser sitting, with a sentinel in
 * place of a token, so a reload or another tab stays in the demo and nothing
 * real is ever kept.
 */
export function startDemo(): Session {
  const session: Session = { token: DEMO_TOKEN, repo: DEMO_REPO, remembered: false };
  return writeSession(session);
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

