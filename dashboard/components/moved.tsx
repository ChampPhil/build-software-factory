"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** An address from the old dashboard: bookmarks and links in old pull requests still land somewhere useful. */
export function Moved({ to, name }: { to: string; name: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(to);
  }, [router, to]);
  return (
    <main className="wrap">
      <header className="page-head">
        <h1>This page moved</h1>
        <p className="rest">
          What was here is now part of <Link href={to}>{name}</Link>. Taking you there.
        </p>
      </header>
    </main>
  );
}
