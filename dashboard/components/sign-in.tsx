"use client";

import { useCallback, useEffect, useState } from "react";
import { GitHubClient } from "@/lib/github";
import { fetchAuthConfig, startGithubLogin, type AuthConfig } from "@/lib/github-login";
import { PERMISSIONS, levelWords, missingPermissionSentence, tokenLink, tokenSteps } from "@/lib/permissions";
import { looksLikeToken, repoFromAddress, startDemo, validRepo, writeSession, type Session } from "@/lib/session";
import { Mark, Out } from "@/components/ui";
import { BrandCredit } from "@/components/brand-credit";

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
            setProblem(access.missing !== undefined && access.missing.length > 0 ? missingPermissionSentence(access.missing) : access.reason);
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
        const saved = writeSession(session);
        setWaiting(null);
        onSignedIn(saved);
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
    <div className="fallback">
      <div className="step">
        <b>1. Make a token</b>
        {repoOk ? (
          <a className="btn" href={tokenLink(repo.trim())} target="_blank" rel="noopener noreferrer">
            Open GitHub&rsquo;s token form, filled in
          </a>
        ) : (
          <span className="muted small">Enter the repository first.</span>
        )}
        <ol className="token-steps">
          {tokenSteps(repo).map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ol>
        <details className="perms">
          <summary>What the token is allowed to do</summary>
          <ul className="plain-list">
            {PERMISSIONS.map((p) => (
              <li key={p.key}>
                <b>{p.label}</b>, {levelWords(p.level).toLowerCase()}: {p.why}.
              </li>
            ))}
            <li>
              For a repository an organization owns, the organization may need to allow tokens like this, or approve
              this one, before it works.
            </li>
          </ul>
        </details>
      </div>
      <label className="step">
        <b>2. Paste the token</b>
        <input
          className="field"
          type="password"
          value={token}
          placeholder="github_pat_…"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <div>
        <button className="btn go" type="button" onClick={() => void withToken()} disabled={busy}>
          {busy ? "Checking…" : "Connect with this token"}
        </button>
      </div>
    </div>
  );

  const rememberBox = (
    <label className="check-line">
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      Remember on this device
    </label>
  );

  return (
    <div className="signin">
      <main className="l">
        <span className="brand">
          <Mark />
          Software Factory
        </span>
        <div className="grow">
          <h1>Connect your repository</h1>
          <p>
            This page talks to GitHub straight from your browser. Nothing is stored on a server, and the sign-in is
            kept for this tab only unless you ask otherwise.
          </p>

          {notice !== null && <p className="note">{notice}</p>}

          {picking !== null && choices !== null && choices.length > 1 && (
            <div className="pick-block">
              <b>Which repository?</b>
              <div className="pick">
                {choices.map((name) => (
                  <button
                    key={name}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPicking(null);
                      void accept({ ...picking, repo: name });
                    }}
                  >
                    {name}
                    <span>Open</span>
                  </button>
                ))}
              </div>
              <span className="muted small">These are the repositories the Software Factory app is installed on.</span>
            </div>
          )}

          {picking !== null && choices === null && <p className="muted">Finding your repositories…</p>}

          {picking === null && (
            <label className="step">
              <b>Which repository?</b>
              <input
                className="field"
                type="text"
                value={repo}
                placeholder="owner/name"
                aria-describedby="repo-hint"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setRepo(e.target.value)}
              />
              <span id="repo-hint" className="muted small">
                {sso ? "Or leave it empty and pick from a list after signing in." : "As owner/name, the way it appears on GitHub."}
              </span>
            </label>
          )}

          {waiting !== null && (
            <div className="callout">
              <p>
                You are signed in to GitHub, but the Software Factory app cannot see <b>{waiting.repo}</b> yet.
                Install it on that repository, then check again.
              </p>
              <div className="acts">
                {auth?.installUrl != null && (
                  <a className="btn" href={auth.installUrl} target="_blank" rel="noopener noreferrer">
                    Install the app
                  </a>
                )}
                <button className="btn go" type="button" onClick={() => void accept(waiting)} disabled={busy}>
                  {busy ? "Checking…" : "Check again"}
                </button>
              </div>
            </div>
          )}

          {auth === undefined && <p className="muted">One moment…</p>}

          {sso && (
            <div className="sso">
              <button className="btn gh-btn" type="button" onClick={() => void withGithub()} disabled={busy || waiting !== null || picking !== null}>
                <GitHubMark />
                {busy && waiting === null ? "Opening GitHub…" : "Sign in with GitHub"}
              </button>
              {rememberBox}
              <span className="muted small">
                GitHub will ask you to approve the Software Factory app. It can only reach the repositories you install
                it on.
              </span>
            </div>
          )}

          {problem !== null && <p className="callout stop" role="alert">{problem}</p>}
          {warning !== null && <p className="callout">{warning}</p>}

          {auth !== undefined && (
            <details className="token" open={!sso}>
              <summary>{sso ? "Or use a token" : "Sign in with a token"}</summary>
              {tokenForm}
            </details>
          )}

          <div className="acts">
            {auth === null && rememberBox}
            <button className="btn quiet" type="button" onClick={() => onSignedIn(startDemo())}>
              Look around with a demo
            </button>
          </div>
        </div>
        <BrandCredit />
      </main>
      <aside className="r" aria-label="What happens next">
        <p>
          Once you&rsquo;re in, this is where you&rsquo;ll answer the factory&rsquo;s questions, watch the recording of
          each change working, and merge it, without opening GitHub.
        </p>
        <ol className="how dark">
          <li><b>It asks.</b> One question at a time, until it can say back what it&rsquo;s about to build.</li>
          <li><b>It builds and proves.</b> In your own GitHub Actions, inside the budget you set.</li>
          <li><b>You merge.</b> From the briefing, with the proof beside the button.</li>
        </ol>
        <small>
          Open source, Apache 2.0. <Out href="https://github.com/ChampPhil/build-software-factory">Read the code</Out>
        </small>
      </aside>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}
