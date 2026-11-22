import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

/**
 * Screen recordings for a PR: finding what a role recorded, and making it fit.
 *
 * A role records a browser session with `playwright-cli video-start`. What it
 * leaves behind is a `.webm` of whatever length and size the session came to,
 * which is no use on a PR as it stands: GitHub will not play a video that is
 * only in a repository, and a ten-minute recording is not something a person
 * watches. So each recording becomes two files:
 *
 *   - the video, re-encoded to fit the size and length limits, which the
 *     dashboard plays and the PR links to;
 *   - a short animated GIF of it, which the PR shows inline. A recording longer
 *     than the GIF allows is sped up rather than cut, so the preview still
 *     shows the whole session.
 *
 * Everything here is deterministic and runs after the role has exited, on the
 * runner, so the model does not choose whether a recording is trimmed, and a
 * runaway session cannot fill the data ref.
 */

export const VIDEO_EXT: ReadonlySet<string> = new Set([".webm", ".mp4", ".mov"]);

export interface RecordingLimits {
  /** The longest a stored recording runs; the rest is cut. */
  readonly clipSeconds: number;
  /** The most one stored recording may weigh. Under the 10 MB a proof file may be. */
  readonly clipBytes: number;
  /** The most every recording on one PR may weigh together. */
  readonly totalBytes: number;
  /** The most the inline GIF may weigh. */
  readonly previewBytes: number;
  /** How long the GIF plays. Longer recordings are sped up to fit. */
  readonly previewSeconds: number;
}

export const RECORDING_LIMITS: RecordingLimits = {
  clipSeconds: 180,
  clipBytes: 8 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  previewBytes: 4 * 1024 * 1024,
  previewSeconds: 20,
};

/** Output names carry this, so a second pass never mistakes them for new recordings. */
const STORED = ".pr";

export interface RecordedVideo {
  /** The file the role wrote, relative to the report directory. */
  readonly source: string;
  /** What the PR links to and the dashboard plays, relative to the report directory. */
  readonly file: string;
  /** The animated GIF (or a still, when a GIF would not fit) shown inline; null when none could be made. */
  readonly poster: string | null;
  readonly seconds: number | null;
  readonly bytes: number;
}

export interface ProcessedRecordings {
  readonly items: readonly RecordedVideo[];
  /** Things the PR check should say, such as a recording left out for its size. */
  readonly problems: readonly string[];
}

/* -------------------------------------------------------------------- tools */

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string, args: readonly string[]): Ran {
  const r = spawnSync(cmd, [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function hasTool(cmd: "ffmpeg" | "ffprobe"): boolean {
  return run(cmd, ["-version"]).status === 0;
}

export interface Probe {
  readonly seconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** What a video is, or null when it is not one. A webm cut short can have no duration; that is not unreadable. */
export function probe(file: string): Probe | null {
  const r = run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const video = (j.streams ?? []).find((s) => s.codec_type === "video");
    if (video === undefined) return null;
    const d = Number(j.format?.duration);
    return {
      seconds: Number.isFinite(d) && d > 0 ? d : null,
      width: video.width ?? null,
      height: video.height ?? null,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ finding */

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

/** Every recording under a directory, as paths relative to it, skipping what this module already made. */
export function findRecordings(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const abs of walk(dir)) {
    const name = basename(abs);
    if (!VIDEO_EXT.has(extname(name).toLowerCase())) continue;
    if (name.includes(`${STORED}.`)) continue;
    out.push(relative(dir, abs));
  }
  return out.sort();
}

/* ----------------------------------------------------------------- encoding */

/** Strongest last: each step is smaller and softer than the one before it. */
const VIDEO_LADDER: readonly { readonly width: number; readonly crf: number }[] = [
  { width: 960, crf: 30 },
  { width: 720, crf: 34 },
  { width: 540, crf: 38 },
  { width: 420, crf: 42 },
];

const GIF_LADDER: readonly { readonly fps: number; readonly width: number }[] = [
  { fps: 8, width: 480 },
  { fps: 6, width: 400 },
  { fps: 5, width: 320 },
  { fps: 4, width: 260 },
];

/** H.264 in an mp4 plays everywhere, and a screen recording compresses to very little. */
function encodeVideo(src: string, out: string, lim: RecordingLimits): number | null {
  for (const { width, crf } of VIDEO_LADDER) {
    const r = run("ffmpeg", [
      "-y", "-v", "error", "-i", src,
      "-t", String(lim.clipSeconds), "-an",
      "-vf", `fps=15,scale='min(${width},iw)':-2`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", String(crf),
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ]);
    if (r.status !== 0) return null;
    const size = statSync(out).size;
    if (size <= lim.clipBytes) return size;
  }
  return null;
}

function encodeGif(src: string, out: string, seconds: number | null, lim: RecordingLimits): number | null {
  // Speed a long recording up to the preview's length rather than cutting it:
  // the point of the preview is to show the whole session.
  const factor = seconds !== null && seconds > lim.previewSeconds ? lim.previewSeconds / seconds : 1;
  const speed = factor < 1 ? `setpts=${factor.toFixed(5)}*(PTS-STARTPTS),` : "";
  for (const { fps, width } of GIF_LADDER) {
    const vf = `${speed}fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
    const r = run("ffmpeg", ["-y", "-v", "error", "-i", src, "-t", String(lim.previewSeconds + 1), "-an", "-vf", vf, "-loop", "0", out]);
    if (r.status !== 0 || !existsSync(out)) return null;
    const size = statSync(out).size;
    if (size <= lim.previewBytes) return size;
  }
  return null;
}

/** A single frame, for when even the smallest GIF would be too heavy. */
function encodeStill(src: string, out: string, seconds: number | null): boolean {
  const at = seconds === null ? 0 : Math.min(1, seconds / 2);
  const r = run("ffmpeg", ["-y", "-v", "error", "-ss", at.toFixed(2), "-i", src, "-frames:v", "1", out]);
  return r.status === 0 && existsSync(out);
}

/* ---------------------------------------------------------------- the whole */

export interface ProcessOptions {
  readonly limits?: Partial<RecordingLimits>;
  /** Where originals go once a smaller copy exists. Default: `raw-recordings` beside the directory. */
  readonly rawDir?: string;
}

const slugOf = (rel: string): string =>
  rel
    .slice(0, rel.length - extname(rel).length)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "recording";

/**
 * Make every recording under `dir` fit a PR. Each becomes `recordings/<name>.pr.mp4`
 * and `recordings/<name>.pr.gif`; the original is moved out of `dir`, so the data
 * ref keeps the small copy and the workflow's artifact keeps the original.
 */
export function processRecordings(dir: string, opts: ProcessOptions = {}): ProcessedRecordings {
  const lim: RecordingLimits = { ...RECORDING_LIMITS, ...opts.limits };
  const sources = findRecordings(dir);
  if (sources.length === 0) return { items: [], problems: [] };

  const problems: string[] = [];
  const items: RecordedVideo[] = [];
  const canEncode = hasTool("ffmpeg") && hasTool("ffprobe");
  if (!canEncode) {
    problems.push("ffmpeg is not installed on this runner, so recordings are kept as they were written, with no preview");
  }
  const rawDir = opts.rawDir ?? join(dirname(dir), "raw-recordings");
  const outDir = join(dir, "recordings");
  const used = new Set<string>();
  let total = 0;

  for (const rel of sources) {
    const abs = join(dir, rel);
    const size = statSync(abs).size;
    if (size === 0) {
      problems.push(`${rel} is empty: the recording never got any frames`);
      continue;
    }

    let slug = slugOf(rel);
    for (let n = 2; used.has(slug); n++) slug = `${slugOf(rel)}-${n}`;
    used.add(slug);

    if (!canEncode) {
      if (size > lim.clipBytes) {
        problems.push(`${rel} is ${mb(size)} and cannot be shrunk without ffmpeg; the limit is ${mb(lim.clipBytes)}`);
        continue;
      }
      if (total + size > lim.totalBytes) {
        problems.push(`${rel} was left out: the recordings on one PR may weigh ${mb(lim.totalBytes)} together`);
        continue;
      }
      total += size;
      items.push({ source: rel, file: rel, poster: null, seconds: null, bytes: size });
      continue;
    }

    const info = probe(abs);
    if (info === null) {
      problems.push(`${rel} could not be read as a video`);
      continue;
    }

    mkdirSync(outDir, { recursive: true });
    const mp4 = join(outDir, `${slug}${STORED}.mp4`);
    const bytes = encodeVideo(abs, mp4, lim);
    if (bytes === null) {
      problems.push(`${rel} stays over ${mb(lim.clipBytes)} even at the lowest quality, so it was left out`);
      continue;
    }
    if (total + bytes > lim.totalBytes) {
      problems.push(`${rel} was left out: the recordings on one PR may weigh ${mb(lim.totalBytes)} together`);
      continue;
    }
    total += bytes;

    let poster: string | null = null;
    const gif = join(outDir, `${slug}${STORED}.gif`);
    if (encodeGif(abs, gif, info.seconds, lim) !== null) {
      poster = relative(dir, gif);
    } else {
      const still = join(outDir, `${slug}${STORED}.png`);
      if (encodeStill(abs, still, info.seconds)) poster = relative(dir, still);
      else problems.push(`${rel} has no preview: the GIF and the still both failed`);
    }

    mkdirSync(rawDir, { recursive: true });
    renameSync(abs, join(rawDir, `${slug}${extname(rel).toLowerCase()}`));
    items.push({
      source: rel,
      file: relative(dir, mp4),
      poster,
      seconds: info.seconds === null ? null : Math.min(info.seconds, lim.clipSeconds),
      bytes,
    });
  }
  return { items, problems };
}

/* ---------------------------------------------------------------- formatting */

export const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
