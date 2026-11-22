import type { StoredRoleReport } from "./types";

export type EvidenceKind = "video" | "image" | "text";

export interface EvidenceItem {
  readonly kind: EvidenceKind;
  readonly file: string;
  readonly caption: string;
  /** Where on the media ref the file lives. */
  readonly path: string;
  readonly seconds: number | null;
  readonly bytes: number | null;
  /** A still or GIF to show before the video is loaded. */
  readonly posterPath: string | null;
}

const VIDEO = /\.(mp4|webm)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|svg)$/i;

export const kindOf = (file: string): EvidenceKind =>
  VIDEO.test(file) ? "video" : IMAGE.test(file) ? "image" : "text";

/** The files a verifier report kept, videos first, because they are what a reviewer opens. */
export function evidenceOf(report: StoredRoleReport | null): readonly EvidenceItem[] {
  if (report === null) return [];
  const sizes = new Map((report.videos ?? []).map((v) => [v.file, v] as const));
  const items: EvidenceItem[] = [];
  for (const b of report.report.blocks ?? []) {
    if (b.type !== "file") continue;
    const f = b as { file: string; caption: string; poster?: string };
    const v = sizes.get(f.file);
    items.push({
      kind: kindOf(f.file),
      file: f.file,
      caption: f.caption,
      path: `${report.media_prefix}/${f.file}`,
      seconds: v?.seconds ?? null,
      bytes: v?.bytes ?? null,
      posterPath: f.poster === undefined ? null : `${report.media_prefix}/${f.poster}`,
    });
  }
  const rank = { video: 0, image: 1, text: 2 } as const;
  return items.map((x, i) => ({ x, i })).sort((a, b) => rank[a.x.kind] - rank[b.x.kind] || a.i - b.i).map((e) => e.x);
}
