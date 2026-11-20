"use client";

import { useState } from "react";
import { GitHubClient } from "@/lib/github";
import { looksLikeToken, validRepo, writeSession, type Session } from "@/lib/session";

/**
 * Sign-in with a fine-grained token the user pastes.
 *
 * The token is checked against the repo before it is stored, so a wrong scope
 * is reported here rather than as a 404 three pages later.
 */
export function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function connect(): Promise<void> {
    setProblem(null);
    setWarning(null);

    if (!validRepo(repo)) {
      setProblem("Give the repository as owner/name.");
      return;
    }
    if (!looksLikeToken(token)) {
      setProblem("That does not look like a GitHub token. A fine-grained one starts with github_pat_.");
      return;
    }

    setBusy(true);
    try {
      const client = new GitHubClient({ token: token.trim(), repo: repo.trim() });
      const access = await client.checkAccess();
      if (!access.ok) {
        setProblem(access.reason);
        return;
      }
      if (access.readOnly) setWarning(access.reason ?? null);
      const session: Session = { token: token.trim(), repo: repo.trim(), remembered: remember };
      writeSession(session);
      onSignedIn(session);
    } catch (err) {
      setProblem((err as Error).message ?? "Could not reach GitHub.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ paddingTop: 64 }}>
      <h1 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.025em", margin: "0 0 8px" }}>
        Connect your repository
      </h1>
      <p style={{ color: "var(--ink-dim)", margin: "0 0 24px", maxWidth: "58ch" }}>
        The dashboard talks to GitHub from your browser. Nothing passes through a server anyone else
        runs, and the token is kept for this tab only unless you ask otherwise.
      </p>

      <div style={{ display: "grid", gap: 16 }}>
        <label className="field">
          Repository
          <input
            type="text"
            value={repo}
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setRepo(e.target.value)}
          />
        </label>

        <label className="field">
          Fine-grained access token
          <input
            type="password"
            value={token}
            placeholder="github_pat_…"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setToken(e.target.value)}
          />
          <span style={{ color: "var(--ink-faint)", fontSize: 12 }}>
            Scoped to this repository, with contents, pull requests, issues and actions read and
            write, plus metadata read.
          </span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--ink-dim)" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember on this device
        </label>

        {problem !== null && <div className="note bad">{problem}</div>}
        {warning !== null && <div className="note">{warning}</div>}

        <div>
          <button className="btn primary" onClick={() => void connect()} disabled={busy}>
            {busy ? "Checking…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}
