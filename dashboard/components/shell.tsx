"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  readSession, clearSession, writeSession, repoFromAddress, demoFromAddress, startDemo, validRepo, type Session,
} from "@/lib/session";
import { isDemo } from "@/lib/demo";
import { completeGithubLogin, needsRefresh, refreshSession, REFRESH_MARGIN_MS } from "@/lib/github-login";
import { GitHubClient } from "@/lib/github";
import { useClient, useLedger } from "@/lib/data";
import { SignIn } from "@/components/sign-in";
import { NewRequest } from "@/components/request";
import { BrandCredit } from "@/components/brand-credit";

const PAGES = [
  { href: "/", label: "Waiting on you" },
  { href: "/dashboard", label: "Dashboard" },
  { href: "/live", label: "Live" },
  { href: "/work", label: "Work items" },
  { href: "/runs", label: "Runs" },
  { href: "/guardrails", label: "Guardrails" },
  { href: "/improvement", label: "Improvement" },
  { href: "/factory", label: "Factory" },
  { href: "/sessions", label: "Sessions" },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();

  // A link can name a repository (`?repo=owner/name`) or ask for the demo (`?demo`).
  const [linkRepo, setLinkRepo] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // What the sign-in page needs when GitHub has just sent the person back, or when a sign-in ended.
  const [resume, setResume] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // Coming back from GitHub: the sign-in page checks the repository and lets the person in.
      const back = await completeGithubLogin();
      if (!live) return;
      if (back.handled) {
        if (back.session !== undefined) setResume(back.session);
        else if (back.error !== undefined) setNotice(back.error);
        setSession(null);
        setReady(true);
        return;
      }

      let current = readSession();
      const search = window.location.search;
      if (current === null && demoFromAddress(search)) current = startDemo();

      // A GitHub sign-in lasts 8 hours; renew it before the first request rather than after a failure.
      if (current !== null && needsRefresh(current)) {
        const renewed = await refreshSession(current);
        if (!live) return;
        if (renewed.ok) current = renewed.session;
        else if (renewed.reason === "ended") {
          clearSession();
          current = null;
          setNotice("Your sign-in with GitHub ended. Sign in again to carry on.");
        }
      }

      setSession(current);
      const named = repoFromAddress(search);
      if (current !== null && named !== null && named !== current.repo) setLinkRepo(named);
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Keep a GitHub sign-in alive while the tab stays open: renew just before it expires,
  // and again when the tab wakes up, since a sleeping tab's timer can run late.
  const refreshToken = session?.refreshToken ?? null;
  const expiresAt = session?.expiresAt ?? null;
  useEffect(() => {
    if (session === null || refreshToken === null || expiresAt === null) return;
    const renew = async (): Promise<void> => {
      const current = readSession();
      if (current === null || !needsRefresh(current)) return;
      const renewed = await refreshSession(current);
      if (renewed.ok) setSession(renewed.session);
      else if (renewed.reason === "ended") {
        clearSession();
        setSession(null);
        setNotice("Your sign-in with GitHub ended. Sign in again to carry on.");
      }
    };
    const timer = window.setTimeout(() => void renew(), Math.max(0, expiresAt - REFRESH_MARGIN_MS - Date.now()));
    const onVisible = (): void => {
      if (!document.hidden) void renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // The session object itself is not a dependency: a renewal replaces these two values, which re-arms the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, expiresAt]);

  /** Move to the repository a link names, with the token already held, if that token can see it. */
  async function switchTo(repoName: string): Promise<void> {
    if (session === null || !validRepo(repoName)) return;
    setSwitching(null);
    try {
      const access = await new GitHubClient({ token: session.token, repo: repoName }).checkAccess();
      if (!access.ok) {
        setSwitching(access.reason);
        return;
      }
      const next: Session = { ...session, repo: repoName };
      writeSession(next);
      setSession(next);
      setLinkRepo(null);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (err) {
      setSwitching((err as Error).message);
    }
  }

  // Depending on the two fields keeps the identity of `auth` stable across a
  // re-render that produced an equal session object.
  const token = session?.token ?? null;
  const repo = session?.repo ?? null;
  const auth = useMemo(
    () => (token === null || repo === null ? null : { token, repo }),
    [token, repo],
  );
  const client = useClient(auth);
  const ledger = useLedger(client);
  const [composing, setComposing] = useState(false);

  const openCount = ledger.state === "ready" ? (ledger.data?.open.length ?? 0) : null;
  const queueCount = ledger.state === "ready" ? (ledger.data?.merge_queue.length ?? 0) : null;

  if (!ready) {
    // The session is read after hydration, so this frame exists either way.
    // Rendering the sign-in form here would flash it past a signed-in user;
    // rendering nothing leaves a blank page. So: the wordmark, which is true
    // in both cases.
    return (
      <div className="main" style={{ maxWidth: 560, paddingTop: 64 }}>
        <div className="rail-mark" style={{ padding: 0 }}>
          <b>Software Factory</b>
        </div>
      </div>
    );
  }

  if (session === null) {
    return (
      <div className="main" style={{ maxWidth: 560 }}>
        <SignIn
          onSignedIn={(s) => {
            setResume(null);
            setNotice(null);
            setSession(s);
          }}
          resume={resume}
          notice={notice}
        />
        <div style={{ marginTop: 32, color: "var(--ink-faint)", fontSize: 12 }}>
          <BrandCredit />
        </div>
      </div>
    );
  }

  const counts: Partial<Record<string, { n: number; attention?: boolean; live?: boolean }>> = {
    "/live": openCount === null ? undefined : { n: openCount, live: openCount > 0 },
    "/work": openCount === null ? undefined : { n: openCount },
    "/runs": queueCount === null || queueCount === 0 ? undefined : { n: queueCount },
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          <b>Software Factory</b>
        </div>
        <button
          className="btn"
          style={{ margin: "0 12px 16px" }}
          onClick={() => setComposing(true)}
        >
          New request
        </button>
        <nav aria-label="Pages">
          {PAGES.map((p) => {
            const current = pathname === p.href || (p.href !== "/" && pathname.startsWith(p.href));
            const count = counts[p.href];
            return (
              <Link key={p.href} href={p.href} {...(current ? { "aria-current": "page" as const } : {})}>
                <span>{p.label}</span>
                {count !== undefined && (
                  <span className={`count${count.attention === true ? " attention" : ""}${count.live === true ? " live" : ""}`}>{count.n}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="rail-foot">
          <div className="mono">{session.repo}</div>
          <BrandCredit />
          <button
            className="btn"
            style={{ marginTop: 10, padding: "4px 9px", fontSize: 13 }}
            onClick={() => {
              clearSession();
              setSession(null);
            }}
          >
            {isDemo(session.token, session.repo) ? "Leave the demo" : "Sign out"}
          </button>
        </div>
      </aside>
      <main className="main" key={session.repo}>
        {isDemo(session.token, session.repo) && (
          <div className="note quiet" style={{ marginBottom: 16 }}>
            This is a demo with made-up records. Nothing here is saved, and nothing is sent to GitHub.
          </div>
        )}
        {linkRepo !== null && !isDemo(session.token, session.repo) && (
          <div className="note" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              This link is for <b className="mono">{linkRepo}</b>. You are connected to{" "}
              <b className="mono">{session.repo}</b>.
            </span>
            <button className="btn" style={{ padding: "4px 9px", fontSize: 13 }} onClick={() => void switchTo(linkRepo)}>
              Switch to it
            </button>
            <button className="btn" style={{ padding: "4px 9px", fontSize: 13 }} onClick={() => setLinkRepo(null)}>
              Stay here
            </button>
            {switching !== null && <span style={{ flexBasis: "100%" }}>{switching}</span>}
          </div>
        )}
        {composing && client !== null && <NewRequest client={client} onClose={() => setComposing(false)} />}
        {children}
      </main>
    </div>
  );
}
