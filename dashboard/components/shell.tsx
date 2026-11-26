"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  readSession, clearSession, writeSession, connectRepo, selectRepo, repoFromAddress, demoFromAddress, startDemo, validRepo, type Session,
} from "@/lib/session";
import { repoBarLabel } from "@/lib/repo-label";
import { isDemo } from "@/lib/demo";
import { completeGithubLogin, needsRefresh, refreshSession, REFRESH_MARGIN_MS } from "@/lib/github-login";
import { GitHubClient } from "@/lib/github";
import { useClient, useFactorySettings, useGuardrails, useIndex, useIssues, useLedger, useLive, usePulls, useWorkItems } from "@/lib/data";
import { runAction, sweep, type Held, type HeldData } from "@/lib/optimistic";
import { needsFrom, requestsFrom, requestIds, statusName } from "@/lib/view";
import type { FirstRequest } from "@/lib/request";
import { SignIn } from "@/components/sign-in";
import { Landing } from "@/components/landing";
import { RequestForm } from "@/components/request-form";
import { BrandCredit } from "@/components/brand-credit";
import { AppProvider, explain, useApp, useTalkBack, type App } from "@/components/app";
import { Chev, Dialog, Mark, SearchIcon } from "@/components/ui";

const NAV = [
  { href: "/", label: "Briefing" },
  { href: "/requests/", label: "Requests" },
  { href: "/runs/", label: "Runs" },
  { href: "/guardrails/", label: "Guardrails" },
  { href: "/spend/", label: "Spend" },
  { href: "/factory/", label: "Factory" },
] as const;

/** Which top-level section a path belongs to, so a request's page lights up Requests. */
function sectionOf(path: string): string {
  const p = path.endsWith("/") ? path : `${path}/`;
  if (p === "/") return "/";
  if (p.startsWith("/request")) return "/requests/";
  return NAV.find((n) => n.href !== "/" && p.startsWith(n.href))?.href ?? "/";
}

type Theme = "system" | "light" | "dark";
const THEME_KEY = "bsf.theme";
function readTheme(): Theme {
  try {
    const t = window.localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
function applyTheme(t: Theme): void {
  if (t === "system") delete document.documentElement.dataset["theme"];
  else document.documentElement.dataset["theme"] = t;
}

export function Shell({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  // A link can name a repository (`?repo=owner/name`) or ask for the demo (`?demo`).
  const [linkRepo, setLinkRepo] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  // What the sign-in page needs when GitHub has just sent the person back, or when a sign-in ended.
  const [resume, setResume] = useState<Session | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(readTheme());
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

  /**
   * Show a connected repository, or connect one and then show it.
   *
   * The first sign-in already started the list. This appends a new name
   * and selects it, after the token is checked against that repository.
   */
  async function switchTo(repoName: string): Promise<void> {
    if (session === null) return;
    if (!validRepo(repoName)) {
      setSwitching("Give the repository as owner/name.");
      return;
    }
    const name = repoName.trim();
    if (name === session.repo) return;
    setSwitching(null);
    try {
      const access = await new GitHubClient({ token: session.token, repo: name }).checkAccess();
      if (!access.ok) {
        setSwitching(access.reason);
        return;
      }
      // Connect first, then choose. selectRepo only accepts a name on the list.
      const repos = connectRepo(session.repos ?? [session.repo], name);
      const active = selectRepo(repos, session.repo, name);
      const next = writeSession({ ...session, repo: active, repos });
      setSession(next);
      setLinkRepo(null);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (err) {
      setSwitching((err as Error).message);
    }
  }

  const [wantsSignIn, setWantsSignIn] = useState(false);

  if (!ready) {
    // The session is read after hydration, so this frame exists either way.
    // Rendering the sign-in form here would flash it past a signed-in user;
    // rendering nothing leaves a blank page. So: the mark, which is true in
    // both cases.
    return (
      <div className="boot" aria-busy="true">
        <span className="brand">
          <Mark />
          Software Factory
        </span>
      </div>
    );
  }

  if (session === null) {
    // Two audiences, told apart by the link rather than by a guess about
    // where somebody came from. A link that names a repository is the one
    // setup hands over, so that person wants the sign-in and nothing else.
    // Anybody else arrived at the root because a friend sent it, and wants to
    // know what this is before giving an agent commit rights.
    const handedOver =
      new URL(window.location.href).searchParams.get("repo") !== null ||
      window.location.pathname.replace(/\/+$/, "") !== "" ||
      resume !== null ||
      notice !== null;
    if (!handedOver && !wantsSignIn) {
      return (
        <Landing
          onSignIn={() => setWantsSignIn(true)}
          onDemo={() => {
            setResume(null);
            setNotice(null);
            setSession(startDemo());
          }}
        />
      );
    }
    return (
      <SignIn
        onSignedIn={(s) => {
          setResume(null);
          setNotice(null);
          setSession(s);
        }}
        resume={resume}
        notice={notice}
      />
    );
  }

  return (
    <SignedIn
      key={session.repo}
      session={session}
      linkRepo={linkRepo}
      switching={switching}
      onSwitch={(r) => void switchTo(r)}
      onStay={() => setLinkRepo(null)}
      onSignOut={() => {
        clearSession();
        setSession(null);
      }}
    >
      {children}
    </SignedIn>
  );
}

function SignedIn({
  session, linkRepo, switching, onSwitch, onStay, onSignOut, children,
}: {
  session: Session;
  linkRepo: string | null;
  switching: string | null;
  onSwitch: (repo: string) => void;
  onStay: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const demo = isDemo(session.token, session.repo);
  // Depending on the two fields keeps the identity of `auth` stable across a
  // re-render that produced an equal session object.
  const auth = useMemo(() => ({ token: session.token, repo: session.repo }), [session.token, session.repo]);
  const client = useClient(auth);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const index = useIndex(client);
  const ledger = useLedger(client, true);
  const live = useLive(client);
  const pulls = usePulls(client, version);
  const issues = useIssues(client, version);
  const guardrails = useGuardrails(client);
  const settings = useFactorySettings(client);
  const installed = settings.state === "ready" ? settings.data !== null : null;

  const { toast, ask, layer } = useTalkBack();
  const [composing, setComposing] = useState<(FirstRequest & { kind?: string }) | null | false>(false);
  const [palette, setPalette] = useState(false);

  // What the page has already shown as done, until the records say so (or sixty seconds pass).
  const [held, setHeld] = useState<Held>({});
  const act = useCallback(
    (fn: () => Promise<unknown>, done: string, key?: string): Promise<boolean> =>
      runAction(
        fn,
        done,
        {
          say: toast,
          refresh: bump,
          hold: (k) => setHeld((h) => ({ ...h, [k]: Date.now() })),
          release: (k) =>
            setHeld((h) => {
              const { [k]: _gone, ...rest } = h;
              return rest;
            }),
        },
        key,
        explain,
      ),
    [toast, bump],
  );
  const heldData: HeldData = {
    pulls: pulls.state === "ready" ? pulls.data : null,
    issues: issues.state === "ready" ? issues.data : null,
    open: ledger.state === "ready" ? (ledger.data?.open ?? []) : null,
    pendingCandidates: guardrails.state === "ready" ? (guardrails.data.candidates?.candidates ?? []).filter((c) => c.status === "pending").map((c) => c.id) : null,
  };
  const heldNow = useRef(heldData);
  heldNow.current = heldData;
  useEffect(() => {
    if (Object.keys(held).length === 0) return;
    const check = (): void => {
      const r = sweep(held, Date.now(), heldNow.current);
      if (r.timedOut.length > 0) toast("That did not go through. It is back on the list.");
      if (Object.keys(r.held).length !== Object.keys(held).length) setHeld(r.held);
    };
    check();
    const id = window.setInterval(check, 5_000);
    return () => window.clearInterval(id);
  }, [held, pulls, issues, ledger, guardrails, toast]);

  // Every 15 seconds while the page is visible, ask whether the factory's records moved. A 304 costs nothing.
  useEffect(() => {
    if (client === null || demo) return;
    let etag: string | null = null;
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const r = await client.dataRefChanged(etag);
        etag = r.etag;
        if (r.changed) bump();
      } catch {
        /* a failed poll is not worth a message; the next one tries again */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [client, demo, bump]);

  // "/" or Ctrl-K opens the palette from anywhere that is not a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      const typing = t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setPalette(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const needs = needsFrom({
    ledger: ledger.state === "ready" ? ledger.data : null,
    pulls: pulls.state === "ready" ? pulls.data : [],
    issues: issues.state === "ready" ? issues.data : [],
    candidates: guardrails.state === "ready" ? (guardrails.data.candidates?.candidates ?? []) : [],
  }).length;

  if (client === null) {
    return (
      <div className="boot" aria-busy="true">
        <span className="brand">
          <Mark />
          Software Factory
        </span>
      </div>
    );
  }

  const app: App = {
    repo: session.repo, demo, client, version, bump, index, ledger, live, pulls, issues, guardrails, settings, installed,
    toast, act, held: (key) => key in held, ask, compose: (initial) => setComposing(initial ?? null),
  };

  return (
    <AppProvider value={app}>
      <a className="skip" href="#content">
        Skip to the page
      </a>
      <TopBar repo={session.repo} repos={session.repos ?? [session.repo]} needs={needs} demo={demo} repoNote={switching} onPalette={() => setPalette(true)} onCompose={() => setComposing(null)} onSignOut={onSignOut} onUseRepo={onSwitch} />
      {(demo || linkRepo !== null) && (
        <div className="notes">
          {demo && (
            <p className="note">
              This is a demo with made-up records. Nothing here is saved, and nothing is sent to GitHub.{" "}
              <button className="link" type="button" onClick={onSignOut}>
                Leave the demo
              </button>
            </p>
          )}
          {linkRepo !== null && !demo && (
            <p className="note">
              <span>
                This link is for <b>{linkRepo}</b>. You are connected to <b>{session.repo}</b>.
              </span>
              <button className="btn small" type="button" onClick={() => onSwitch(linkRepo)}>
                Switch to it
              </button>
              <button className="btn small quiet" type="button" onClick={onStay}>
                Stay here
              </button>
              {switching !== null && <span className="warn">{switching}</span>}
            </p>
          )}
        </div>
      )}
      <div id="content">{children}</div>
      <footer className="foot">
        <BrandCredit />
        <small className="muted" title="The build this page is running">Build {(process.env["NEXT_PUBLIC_BUILD_SHA"] ?? "dev").slice(0, 7)}</small>
      </footer>
      {composing !== false && (
        <Dialog title="New request" onClose={() => setComposing(false)} size="sheet">
          <RequestForm initial={composing ?? undefined} onCancel={() => setComposing(false)} />
        </Dialog>
      )}
      {palette && <Palette onClose={() => setPalette(false)} onCompose={() => { setPalette(false); setComposing(null); }} />}
      {layer}
    </AppProvider>
  );
}

function TopBar({
  repo, repos, needs, demo, repoNote, onPalette, onCompose, onSignOut, onUseRepo,
}: {
  repo: string;
  repos: readonly string[];
  needs: number;
  demo: boolean;
  repoNote: string | null;
  onPalette: () => void;
  onCompose: () => void;
  onSignOut: () => void;
  onUseRepo: (repo: string) => void;
}) {
  const path = usePathname();
  const here = sectionOf(path);
  const [owner, name] = repo.split("/");
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => setTheme(readTheme()), []);
  const shownName = repoBarLabel(name ?? "");

  return (
    <header className="top">
      <div className="top-in">
        <Link className="repo" href="/" aria-label={`${repo}, the briefing`}>
          <Mark />
          <span>
            <span className="repo-name" title={name}>{shownName}</span>
            <small>{owner}</small>
          </span>
        </Link>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} {...(here === n.href ? { "aria-current": "page" as const } : {})}>
              {n.label}
              {n.href === "/" && needs > 0 && (
                <span className="count" aria-label={`${needs} waiting on you`}>
                  {needs}
                </span>
              )}
            </Link>
          ))}
        </nav>
        <span className="gap" />
        <button className="btn search" type="button" onClick={onPalette}>
          <SearchIcon />
          <span className="lbl">Search or do anything</span>
          <kbd>/</kbd>
        </button>
        <button className="btn go" type="button" onClick={onCompose}>
          <span aria-hidden="true">+</span>
          <span className="lbl">New request</span>
        </button>
        <div className="menu-wrap">
          <button className="avatar" type="button" aria-haspopup="menu" aria-expanded={menu} aria-label="Your account and settings" onClick={() => setMenu((m) => !m)}>
            {(owner ?? "?").slice(0, 2).toUpperCase()}
            <Chev />
          </button>
          {menu && (
            <>
              <div className="scrim clear" onClick={() => setMenu(false)} aria-hidden="true" />
              <div className="pop" role="menu">
                <p className="muted small">Connected to <b>{repo}</b></p>
                {!demo && (
                  <div className="repo-switch" role="group" aria-label="Connected repositories">
                    {repos.map((r) => (
                      <button key={r} type="button" role="menuitem" onClick={() => onUseRepo(r)} aria-current={r === repo ? "true" : undefined}>
                        {r}
                        {r === repo && <span>Showing</span>}
                      </button>
                    ))}
                    {adding ? (
                      <form
                        className="connect"
                        onSubmit={(e) => {
                          e.preventDefault();
                          onUseRepo(draft);
                        }}
                      >
                        <input
                          className="field"
                          aria-label="Repository to connect, as owner/name"
                          placeholder="owner/name"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        <button className="btn small" type="submit">Connect</button>
                      </form>
                    ) : (
                      <button type="button" role="menuitem" onClick={() => setAdding(true)}>
                        Connect another repository
                      </button>
                    )}
                    {repoNote !== null && <p className="warn">{repoNote}</p>}
                  </div>
                )}
                <div className="theme-pick" role="radiogroup" aria-label="Appearance">
                  {(["system", "light", "dark"] as const).map((t) => (
                    <label key={t}>
                      <input
                        type="radio"
                        name="theme"
                        checked={theme === t}
                        onChange={() => {
                          setTheme(t);
                          applyTheme(t);
                          try { window.localStorage.setItem(THEME_KEY, t); } catch { /* private mode: it lasts this visit */ }
                        }}
                      />
                      {t === "system" ? "Auto" : t === "light" ? "Light" : "Dark"}
                    </label>
                  ))}
                </div>
                <hr />
                {!demo && (
                  <a className="out" role="menuitem" href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
                    The repository on GitHub
                  </a>
                )}
                <a className="out" role="menuitem" href="https://github.com/ChampPhil/build-software-factory#readme" target="_blank" rel="noopener noreferrer">
                  How the factory works
                </a>
                <hr />
                <button type="button" role="menuitem" onClick={onSignOut}>
                  {demo ? "Leave the demo" : "Sign out"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * Search or do anything: every page, every action that needs no context, and
 * every request by its title or number. The quickest way to anything for a
 * person who knows what they want.
 */
function Palette({ onClose, onCompose }: { onClose: () => void; onCompose: () => void }) {
  const app = useApp();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const ledger = app.ledger.state === "ready" ? app.ledger.data : null;
  const docs = useWorkItems(app.client, requestIds(ledger, 60));
  const requests = requestsFrom(ledger, docs.state === "ready" ? docs.data : {}, app.issues.state === "ready" ? app.issues.data : []);

  type Entry = { label: string; hint: string; run: () => void };
  const go = (href: string) => () => {
    onClose();
    router.push(href);
  };
  const entries: Entry[] = [
    { label: "New request", hint: "Ask the factory for something", run: onCompose },
    ...NAV.map((n) => ({ label: n.label, hint: "Page", run: go(n.href) })),
    { label: "Settings", hint: "Factory", run: go("/factory/#settings") },
    { label: "Standing goals", hint: "Factory", run: go("/factory/#goals") },
    { label: "Workflows", hint: "Factory", run: go("/factory/#workflows") },
    { label: "Rules it could add", hint: "Guardrails", run: go("/guardrails/") },
    ...requests.map((r) => ({
      label: r.title,
      hint: `${r.issue === null ? r.id : `#${r.issue}`}, ${statusName(r.status).toLowerCase()}`,
      run: go(`/request/?id=${encodeURIComponent(r.id)}`),
    })),
  ];
  const needle = q.trim().toLowerCase();
  const shown = (needle === "" ? entries.slice(0, 12) : entries.filter((e) => `${e.label} ${e.hint}`.toLowerCase().includes(needle.replace(/^#/, "")))).slice(0, 14);
  const pick = shown[Math.min(at, shown.length - 1)];

  return (
    <Dialog onClose={onClose} size="pal" label="Search or do anything">
      <div className="palette">
        <input
          className="field"
          data-autofocus
          value={q}
          placeholder="Search requests, pages and actions"
          aria-label="Search or do anything"
          aria-controls="pal-list"
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt((a) => Math.min(a + 1, shown.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setAt((a) => Math.max(a - 1, 0)); }
            if (e.key === "Enter" && pick !== undefined) { e.preventDefault(); pick.run(); }
          }}
        />
        <ul id="pal-list" role="listbox" aria-label="Results">
          {shown.map((e, i) => (
            <li key={`${e.label}-${i}`} role="option" aria-selected={i === Math.min(at, shown.length - 1)} onClick={e.run} onMouseEnter={() => setAt(i)}>
              {e.label}
              <span>{e.hint}</span>
            </li>
          ))}
          {shown.length === 0 && <li className="muted" aria-disabled="true">Nothing matches. Press Escape to close.</li>}
        </ul>
        <p className="muted small">Arrow keys to move, Enter to open, Escape to close.</p>
      </div>
    </Dialog>
  );
}
