"use client";

import { useEffect, useState } from "react";
import type { GitHubClient } from "@/lib/github";
import { evidenceOf, type EvidenceItem } from "@/lib/evidence";
import type { StoredRoleReport } from "@/lib/types";

const size = (b: number | null): string => (b === null ? "" : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const clock = (s: number | null): string => (s === null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

/** Loads one file from the media ref into an object URL, and frees it when it goes. */
function useMedia(client: GitHubClient, path: string | null): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    let made: string | null = null;
    client.mediaFile(path).then(
      (blob) => {
        if (!alive) return;
        if (blob === null) return setState({ url: null, error: "this file is no longer on the media ref" });
        made = URL.createObjectURL(blob);
        setState({ url: made, error: null });
      },
      (e: unknown) => alive && setState({ url: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      alive = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [client, path]);
  return state;
}

function Video({ client, item }: { client: GitHubClient; item: EvidenceItem }) {
  const [open, setOpen] = useState(false);
  const clip = useMedia(client, open ? item.path : null);
  const poster = useMedia(client, item.posterPath);
  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)} aria-label={`Play ${item.caption}`}>
        {poster.url !== null && <img src={poster.url} alt="" style={{ maxWidth: 320, display: "block", marginBottom: 6 }} />}
        ▶ Play {[clock(item.seconds), size(item.bytes)].filter((x) => x !== "").join("  ")}
      </button>
    );
  }
  if (clip.error !== null) return <span className="row-meta">Could not load the recording: {clip.error}</span>;
  if (clip.url === null) return <span className="row-meta">Loading the recording…</span>;
  return <video src={clip.url} controls autoPlay style={{ maxWidth: "100%", borderRadius: 6 }} />;
}

function Image({ client, item }: { client: GitHubClient; item: EvidenceItem }) {
  const img = useMedia(client, item.path);
  if (img.error !== null) return <span className="row-meta">{img.error}</span>;
  if (img.url === null) return <span className="row-meta">Loading…</span>;
  return <img src={img.url} alt={item.caption} style={{ maxWidth: "100%", borderRadius: 6 }} />;
}

/** What the verifier kept as proof: recordings first, played in place; then screenshots. */
export function Evidence({ client, report }: { client: GitHubClient; report: StoredRoleReport | null }) {
  const items = evidenceOf(report).filter((i) => i.kind !== "text");
  if (items.length === 0) return null;
  return (
    <div className="rows">
      {items.map((item) => (
        <div className="row" key={item.path} style={{ display: "grid", gap: 8 }}>
          <span>{item.caption}</span>
          {item.kind === "video" ? <Video client={client} item={item} /> : <Image client={client} item={item} />}
        </div>
      ))}
    </div>
  );
}
