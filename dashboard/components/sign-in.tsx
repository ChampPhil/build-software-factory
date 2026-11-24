"use client";

import { useCallback, useEffect, useState } from "react";
import { GitHubClient } from "@/lib/github";
import { fetchAuthConfig, startGithubLogin, type AuthConfig } from "@/lib/github-login";
import { PERMISSIONS, levelWords, tokenLink } from "@/lib/permissions";
import { looksLikeToken, repoFromAddress, startDemo, validRepo, writeSession, type Session } from "@/lib/session";

/**
 * Signing in.
 *
 * The main way is one button: "Sign in with GitHub". GitHub asks the person to
 * approve the Software Factory app, and they land back here signed in. When a
 * link from setup already names the repository, that is the whole job.
 *
 * Two things can stand in the way and each is said in words. If the app is not
 * installed on the repository yet, the page links to where to install it and
 * checks again, without making the person sign in twice. And a site that has
 * not set the button up shows the other way, a fine-grained token made from a
 * link that fills in GitHub's form, which also stays available for anyone who
 * prefers not to install an app.
 */
export function SignIn({
  onSignedIn,
  resume = null,
  notice = null,
}: {
  onSignedIn: (s: Session) => void;
  /** A session GitHub has just handed back, not yet checked against the repository. */
  resume?: Session | null;
  /** Something that happened on the way here, such as a sign-in that ended. */
  notice?: string | null;
}) {
  const [repo, setRepo] = useState(resume?.repo ?? "");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(resume?.remembered ?? false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  // undefined: still asking. null: this site has no GitHub button.
  const [auth, setAuth] = useState<AuthConfig | null | undefined>(undefined);
  // The session waiting for the app to be installed.
  const [waiting, setWaiting] = useState<Session | null>(null);
  // A signed-in session that has no repository yet, and the choices for it.
  const [picking, setPicking] = useState<Session | null>(null);
  const [choices, setChoices] = useState<readonly string[] | null>(null);

  // A link from setup names the repository, so the first step is already done.
  useEffect(() => {
    if (resume !== null) return;
    const fromLink = repoFromAddress(window.location.search);
    if (fromLink !== null) setRepo(fromLink);
  }, [resume]);

  useEffect(() => {
    let live = true;
    void fetchAuthConfig().then((config) => {
      if (live) setAuth(config);
    });
    return () => {
      live = false;
    };
  }, []);

  const repoOk = validRepo(repo);
  const sso = auth !== undefined && auth !== null;

  /** Check the repository is reachable with this session, then let the person in. */
  const accept = useCallback(
    async (session: Session): Promise<void> => {
      setBusy(true);
      setProblem(null);
      setWarning(null);
      try {
        const access = await new GitHubClient({ token: session.token, repo: session.repo }).checkAccess();
        if (!access.ok) {
          if (session.refreshToken !== undefined) {
            if (access.missing !== undefined) {
              const names = access.missing.map((m) => m.label).join(", ");
              setProblem(
                `The Software Factory app is missing permissions: ${names}. That is a problem with how the app was set up, not with your account.`,
              );
            } else {
              // Signed in, but GitHub shows nothing at this name: the app is not installed on it.
              setWaiting(session);
            }
          } else {
            setProblem(access.reason);
          }
          return;
        }
        if (access.readOnly) {
          setWarning(
            session.refreshToken !== undefined
              ? "You can read this repository but not change it, so approving and commenting are unavailable."
              : (access.reason ?? null),
          );
        }
        writeSession(session);
        setWaiting(null);
        onSignedIn(session);
      } catch (err) {
        setProblem((err as Error).message ?? "Could not reach GitHub.");
      } finally {
        setBusy(false);
      }
    },
    [onSignedIn],
  );

  /**
   * Signed in, but we do not know which repository yet.
   *
   * Offer the ones the app is installed on. Every entry is a repository the
   * dashboard can really open, so this is both shorter than typing and more
   * truthful than a free-text box that accepts anything.
   */
  const pickRepo = useCallback(async (session: Session): Promise<void> => {
    setPicking(session);
    setChoices(null);
    const names = await new GitHubClient({ token: session.token, repo: "" }).installedRepos();
    if (names.length === 1 && names[0] !== undefined) {
      setPicking(null);
      await accept({ ...session, repo: names[0] });
      return;
    }
    setChoices(names);
    if (names.length === 0) {
      setProblem(
        "You are signed in, but the Software Factory app is not installed on any repository yet. Install it, then sign in again.",
      );
    }
  }, [accept]);

  // GitHub has just sent the person back: finish the job.
  useEffect(() => {
    if (resume === null) return;
    if (resume.repo === "") void pickRepo(resume);
    else void accept(resume);
  }, [resume, accept, pickRepo]);

  async function withGithub(): Promise<void> {
    setProblem(null);
    setWarning(null);
    if (repo.trim() !== "" && !repoOk) {
      setProblem("Give the repository as owner/name, or leave it empty and pick from a list after signing in.");
      return;
    }
    setBusy(true);
    // An empty repository is allowed: the person picks from their installations
    // once GitHub has sent them back.
    const started = await startGithubLogin(repo.trim(), remember);
    if (!started.ok || started.url === undefined) {
      setBusy(false);
      setProblem(started.error ?? "Could not start the sign-in.");
      return;
    }
    window.location.assign(started.url);
  }

  async function withToken(): Promise<void> {
    setProblem(null);
    setWarning(null);

    if (!repoOk) {
      setProblem("Give the repository as owner/name.");
      return;
    }
    if (!looksLikeToken(token)) {
      setProblem("That does not look like a GitHub token. A fine-grained one starts with github_pat_.");
      return;
    }
    await accept({ token: token.trim(), repo: repo.trim(), remembered: remember });
  }

  const tokenForm = (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "grid", gap: 8 }}>
        <div className="field" style={{ display: "grid", gap: 8 }}>
          Make a token
          {repoOk ? (
            <a
              className="btn"
              href={tokenLink(repo.trim())}
              target="_blank"
              rel="noopener noreferrer"
              style={{ justifySelf: "start", textDecoration: "none" }}
            >
              Open GitHub's token form, filled in
            </a>
          ) : (
            <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>Enter the repository first.</span>
          )}
          <span style={{ color: "var(--ink-faint)", fontSize: 12, maxWidth: "62ch" }}>
            The form opens with the name, the lifetime and every permission already chosen. Under
            Repository access, pick Only select repositories and choose{" "}
            <b>{repoOk ? repo.trim() : "your repository"}</b>. Then press Generate token and copy it.
          </span>
        </div>
        <details style={{ fontSize: 12, color: "var(--ink-dim)" }}>
          <summary style={{ cursor: "pointer" }}>What the token is allowed to do</summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, display: "grid", gap: 4 }}>
            {PERMISSIONS.map((p) => (
              <li key={p.key}>
                <b>{p.label}</b>, {levelWords(p.level).toLowerCase()}: {p.why}.
              </li>
            ))}
            <li>
              For a repository an organization owns, the organization may need to allow tokens like
              this, or approve this one, before it works.
            </li>
          </ul>
        </details>
      </div>

      <label className="field">
        Paste the token
        <input
          type="password"
          value={token}
          placeholder="github_pat_…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>

      <div>
        <button className="btn" onClick={() => void withToken()} disabled={busy}>
          {busy ? "Checking…" : "Connect with this token"}
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ paddingTop: 64 }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.025em", margin: "0 0 8px" }}>
        Connect your repository
      </h1>
      <p style={{ color: "var(--ink-dim)", margin: "0 0 24px", maxWidth: "58ch" }}>
        This page talks to GitHub straight from your browser. Nothing is stored on a server, and the
        sign-in is kept for this tab only unless you ask otherwise.
      </p>

      {notice !== null && (
        <div className="note" style={{ marginBottom: 16 }}>
          {notice}
        </div>
      )}

      <div style={{ display: "grid", gap: 20 }}>
        {picking !== null && choices !== null && choices.length > 1 && (
          <div style={{ display: "grid", gap: 10 }}>
            <span className="field">Which repository?</span>
            <div style={{ display: "grid", gap: 6 }}>
              {choices.map((name) => (
                <button
                  key={name}
                  className="btn"
                  disabled={busy}
                  style={{ justifyContent: "flex-start", textAlign: "left" }}
                  onClick={() => {
                    setPicking(null);
                    void accept({ ...picking, repo: name });
                  }}
                >
                  <span className="mono">{name}</span>
                </button>
              ))}
            </div>
            <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>
              These are the repositories the Software Factory app is installed on.
            </span>
          </div>
        )}

        {picking !== null && choices === null && (
          <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>Finding your repositories…</span>
        )}

        {picking === null && (
          <label className="field">
            Which repository?
            <input
              type="text"
              value={repo}
              placeholder="owner/name — or leave this and sign in to pick from a list"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setRepo(e.target.value)}
            />
          </label>
        )}

        {waiting !== null && (
          <div className="note" style={{ display: "grid", gap: 10 }}>
            <span>
              You are signed in to GitHub, but the Software Factory app cannot see{" "}
              <b className="mono">{waiting.repo}</b> yet. Install it on that repository, then check
              again.
            </span>
            <span style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {auth?.installUrl != null && (
                <a className="btn" href={auth.installUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                  Install the app
                </a>
              )}
              <button className="btn primary" onClick={() => void accept(waiting)} disabled={busy}>
                {busy ? "Checking…" : "Check again"}
              </button>
            </span>
          </div>
        )}

        {auth === undefined && <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>One moment…</span>}

        {sso && (
          <div style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn primary" onClick={() => void withGithub()} disabled={busy || waiting !== null || picking !== null}>
                {busy && waiting === null ? "Opening GitHub…" : "Sign in with GitHub"}
              </button>
              <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>or</span>
              <button className="btn" onClick={() => onSignedIn(startDemo())}>
                Look around with a demo
              </button>
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--ink-dim)" }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this device
            </label>
            <span style={{ color: "var(--ink-faint)", fontSize: 12, maxWidth: "62ch" }}>
              GitHub will ask you to approve the Software Factory app. It can only reach the
              repositories you install it on.
            </span>
          </div>
        )}

        {problem !== null && <div className="note bad">{problem}</div>}
        {warning !== null && <div className="note">{warning}</div>}

        {auth !== undefined && (
          <details open={!sso} style={{ display: "grid", gap: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--ink-dim)" }}>
              {sso ? "Use a token instead" : "Sign in with a token"}
            </summary>
            <div style={{ marginTop: 16, display: "grid", gap: 16 }}>{tokenForm}</div>
          </details>
        )}

        {auth === null && (
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--ink-dim)" }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this device
            </label>
            <span style={{ color: "var(--ink-faint)", fontSize: 13 }}>or</span>
            <button className="btn" onClick={() => onSignedIn(startDemo())}>
              Look around with a demo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
