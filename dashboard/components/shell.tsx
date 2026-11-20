"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { readSession, type Session } from "@/lib/session";
import { useClient, useLedger } from "@/lib/data";
import { SignIn } from "@/components/sign-in";

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

  useEffect(() => {
    setSession(readSession());
    setReady(true);
  }, []);

  const auth = useMemo(
    () => (session === null ? null : { token: session.token, repo: session.repo }),
    [session?.token, session?.repo],
  );
  const client = useClient(auth);
  const ledger = useLedger(client);

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
        <SignIn onSignedIn={setSession} />
      </div>
    );
  }

  const counts: Partial<Record<string, { n: number; attention?: boolean }>> = {
    "/live": openCount === null ? undefined : { n: openCount, attention: openCount > 0 },
    "/work": openCount === null ? undefined : { n: openCount },
    "/runs": queueCount === null || queueCount === 0 ? undefined : { n: queueCount },
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          <b>Software Factory</b>
        </div>
        <nav aria-label="Pages">
          {PAGES.map((p) => {
            const current = pathname === p.href || (p.href !== "/" && pathname.startsWith(p.href));
            const count = counts[p.href];
            return (
              <Link key={p.href} href={p.href} {...(current ? { "aria-current": "page" as const } : {})}>
                <span>{p.label}</span>
                {count !== undefined && (
                  <span className={count.attention === true ? "count attention" : "count"}>{count.n}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="rail-foot">
          <div className="mono">{session.repo}</div>
          <button
            className="btn"
            style={{ marginTop: 10, padding: "4px 9px", fontSize: 13 }}
            onClick={() => {
              const { clearSession } = require("@/lib/session") as typeof import("@/lib/session");
              clearSession();
              setSession(null);
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
