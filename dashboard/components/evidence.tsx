"use client";

import { useEffect, useState } from "react";
import type { GitHubClient } from "@/lib/github";
import { evidenceOf, type EvidenceItem } from "@/lib/evidence";
import type { StoredRoleReport } from "@/lib/types";
import { PlayIcon } from "@/components/ui";

/**
 * The proof a verifier kept: the recording first, then stills. Files live on
 * the media ref and are read as blobs with the same sign-in, so a private
 * repository's proof plays here when GitHub's own page can only link to it.
 */

const size = (b: number | null): string => (b === null ? "" : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const clock = (s: number | null): string => (s === null ? "" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

function useMedia(client: GitHubClient, path: string | null): { url: string | null; error: string | null } {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  useEffect(() => {
    if (path === null) return;
    let alive = true;
    let made: string | null = null;
    client.mediaFile(path).then(
      (blob) => {
        if (!alive) return;
        if (blob === null) {
          setState({ url: null, error: "This file is no longer kept." });
          return;
        }
        made = URL.createObjectURL(blob);
        setState({ url: made, error: null });
      },
      (e: unknown) => {
        if (alive) setState({ url: null, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [client, path]);
  return state;
}

/** A recording, with its poster and a play button until someone asks for it. */
export function Film({ client, item }: { client: GitHubClient; item: EvidenceItem }) {
  const [open, setOpen] = useState(false);
  const clip = useMedia(client, open ? item.path : null);
  const poster = useMedia(client, item.posterPath);
  const length = clock(item.seconds);
  return (
    <figure className="film-fig">
      <div className={open ? "film playing" : "film"}>
        {open && clip.url !== null ? (
          // A recording of an interface has no speech to caption; the caption below says what it shows.
          <video src={clip.url} controls autoPlay playsInline />
        ) : (
          <>
            {poster.url !== null ? <img src={poster.url} alt="" /> : <div className="film-blank" />}
            <button className="play" type="button" onClick={() => setOpen(true)} aria-label={`Play the recording${length === "" ? "" : `, ${length}`}: ${item.caption}`}>
              <span className="disc">
                <PlayIcon />
              </span>
            </button>
            <div className="bar">
              <span>{open ? (clip.error ?? "Loading the recording…") : "Recording"}</span>
              <span className="track"><i /></span>
              <span>{[length, size(item.bytes)].filter((x) => x !== "").join(", ")}</span>
            </div>
          </>
        )}
      </div>
      <figcaption className="caption">{item.caption}</figcaption>
    </figure>
  );
}

function Still({ client, item }: { client: GitHubClient; item: EvidenceItem }) {
  const img = useMedia(client, item.path);
  return (
    <figure className="still">
      <div className="block-img">{img.url !== null ? <img src={img.url} alt={item.caption} /> : <p className="muted small">{img.error ?? "Loading…"}</p>}</div>
      <figcaption className="caption">{item.caption}</figcaption>
    </figure>
  );
}

/** Everything a report kept, or nothing at all when it kept nothing. */
export function Evidence({ client, report, max }: { client: GitHubClient; report: StoredRoleReport | null; max?: number }) {
  const items = evidenceOf(report).filter((i) => i.kind !== "text").slice(0, max ?? 99);
  if (items.length === 0) return null;
  return (
    <div className="evidence">
      {items.map((item) => (item.kind === "video" ? <Film key={item.path} client={client} item={item} /> : <Still key={item.path} client={client} item={item} />))}
    </div>
  );
}

export const hasEvidence = (report: StoredRoleReport | null): boolean => evidenceOf(report).some((i) => i.kind !== "text");
