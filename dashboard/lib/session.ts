"use client";

/**
 * Where the user's token lives.
 *
 * Default is `sessionStorage`, cleared when the tab closes, because a token
 * with write access to someone's repo should not outlive the sitting unless
 * they ask for it. `localStorage` only on an explicit "remember on this
 * device".
 */

import { DEMO_REPO, DEMO_TOKEN } from "./demo";

const TOKEN_KEY = "bsf.token";
const REPO_KEY = "bsf.repo";
const REPOS_KEY = "bsf.repos";
const REMEMBER_KEY = "bsf.remember";
const REFRESH_KEY = "bsf.refresh";
const EXPIRES_KEY = "bsf.expires";

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

export function readSession(): Session | null {
  if (memory !== null) return memory;
  if (typeof window === "undefined") return null;
  for (const remember of [false, true]) {
    const s = store(remember);
    if (s === null) continue;
    const token = s.getItem(TOKEN_KEY);
    const repo = s.getItem(REPO_KEY);
    if (token !== null && token !== "" && repo !== null && repo !== "") {
      const refreshToken = s.getItem(REFRESH_KEY);
      const expires = Number(s.getItem(EXPIRES_KEY));
      // A session saved before the list existed still has one repository: this one.
      const repos = connectRepo(parseRepos(s.getItem(REPOS_KEY)), repo);
      return {
        token,
        repo,
        repos,
        remembered: remember,
        ...(refreshToken !== null && refreshToken !== "" ? { refreshToken } : {}),
        ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: expires } : {}),
      };
    }
  }
  return null;
}

export function writeSession(session: Session): Session {
  const s = store(session.remembered);
  // Keep repositories already stored when the caller did not bring the list,
  // then make sure the active one is on it. The first write starts the list.
  const stored = parseRepos(s?.getItem(REPOS_KEY) ?? null);
  const repos = connectRepo(session.repos ?? stored, session.repo);
  const saved: Session = { ...session, repos };
  memory = saved;
  if (s === null) return saved;
  s.setItem(TOKEN_KEY, session.token);
  s.setItem(REPO_KEY, session.repo);
  s.setItem(REPOS_KEY, JSON.stringify(repos));
  s.setItem(REMEMBER_KEY, String(session.remembered));
  if (session.refreshToken !== undefined) s.setItem(REFRESH_KEY, session.refreshToken);
  else s.removeItem(REFRESH_KEY);
  if (session.expiresAt !== undefined) s.setItem(EXPIRES_KEY, String(session.expiresAt));
  else s.removeItem(EXPIRES_KEY);
  // Never leave a copy in the other store.
  const other = store(!session.remembered);
  other?.removeItem(TOKEN_KEY);
  other?.removeItem(REFRESH_KEY);
  other?.removeItem(EXPIRES_KEY);
  other?.removeItem(REPOS_KEY);
  return saved;
}

export function clearSession(): void {
  memory = null;
  for (const remember of [false, true]) {
    const s = store(remember);
    s?.removeItem(TOKEN_KEY);
    s?.removeItem(REPO_KEY);
    s?.removeItem(REPOS_KEY);
    s?.removeItem(REMEMBER_KEY);
    s?.removeItem(REFRESH_KEY);
    s?.removeItem(EXPIRES_KEY);
  }
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
 * Start the demo. It is stored for this tab only, with a sentinel in place of a
 * token, so a reload stays in the demo and nothing real is ever kept.
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

