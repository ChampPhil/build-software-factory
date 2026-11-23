import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { GitHub } from "../lib/github.js";
import { MEDIA_REF } from "../lib/dataref.js";
import { FactoryStore, json, workItemPath } from "../lib/store.js";
import { assertValid } from "../lib/schema.js";
import { clock, mb, processRecordings, VIDEO_EXT as RECORDING_EXT, type RecordedVideo } from "../lib/recordings.js";
import { attributionMarkdown } from "../lib/brand.js";

/**
 * PR reports: what a person sees on every factory PR, setup PR and escalation.
 *
 * A role writes a report (schema/pr-report.json) and the files it points at.
 * The factory stores the files on the media ref, where each has a URL, and
 * renders the PR body from the reports itself, in one layout:
 *
 *   Summary                 three lines at most
 *   Proof                   files and diagrams, in the order the role chose;
 *                           the builder's, then the verifier's
 *   Key things to focus on  the biggest changes
 *   Read more               the spec, a technical and a conceptual breakdown
 *
 * Every proof file stays in the PR. When the body cannot hold them all, the
 * rest continue in one PR comment, never behind a link.
 */

export interface PrReport {
  readonly schema: "pr-report/1";
  readonly summary: readonly string[];
  readonly blocks: readonly Block[];
  readonly focus?: readonly { readonly title: string; readonly detail: string; readonly files?: readonly string[] }[];
  readonly technical?: string;
  readonly conceptual?: string;
}

export type Block =
  | { readonly type: "file"; readonly file: string; readonly caption: string; readonly poster?: string }
  | { readonly type: "diagram"; readonly title: string; readonly mermaid: string };

/** A report as stored on the data ref: where its files went, and text worth showing inline. */
export interface StoredReport {
  readonly role: string;
  readonly attempt: number;
  readonly report: PrReport;
  readonly media_commit: string | null;
  readonly media_prefix: string;
  /** Text proof (a log, an API response), kept so the PR can show it inline. */
  readonly inline: Readonly<Record<string, string>>;
  /** What each stored recording is, so the PR can say how long it runs and how big it is. */
  readonly videos?: readonly { readonly file: string; readonly seconds: number | null; readonly bytes: number }[];
  readonly problems: readonly string[];
  readonly stored_at: string;
}

export const REPORT_FILE = "report.json";
const FILE_CAP_BYTES = 10 * 1024 * 1024;
const INLINE_CAP = 4000;
const TEXT_EXT = new Set([".json", ".txt", ".log", ".md", ".html", ".xml", ".csv", ".yaml", ".yml"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);
const VIDEO_EXT = RECORDING_EXT;

export const reportPath = (workItem: string, role: string): string => `reports/${workItem}/${role}.json`;

function inside(dir: string, rel: string): string | null {
  const p = normalize(join(dir, rel));
  return p.startsWith(normalize(dir) + "/") ? p : null;
}

/** Every file a report points at, in order, without repeats. */
export function filesOf(r: PrReport): string[] {
  const out: string[] = [];
  const add = (f: string | undefined) => {
    if (f !== undefined && !out.includes(f)) out.push(f);
  };
  for (const b of r.blocks) {
    if (b.type === "file") {
      add(b.file);
      add(b.poster);
    }
  }
  add(r.technical);
  add(r.conceptual);
  return out;
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

/**
 * Put the recordings a role made into its report. A recording the report
 * already names is swapped for its stored copy and preview; one it never
 * mentioned is added at the front, because a person should see the video
 * before anything else. Either way the model does not decide whether a
 * recording reaches the PR: if it recorded, it is shown.
 */
export function attachRecordings(report: PrReport, items: readonly RecordedVideo[]): PrReport {
  if (items.length === 0) return report;
  const bySource = new Map(items.map((i) => [i.source, i]));
  const named = new Set<string>();
  const blocks = report.blocks.map((b): Block => {
    if (b.type !== "file") return b;
    const item = bySource.get(b.file);
    if (item === undefined) return b;
    named.add(item.source);
    const poster = item.poster ?? b.poster;
    return { type: "file", file: item.file, caption: b.caption, ...(poster === undefined ? {} : { poster }) };
  });
  const added = items
    .filter((i) => !named.has(i.source))
    .map((i): Block => ({
      type: "file",
      file: i.file,
      caption: `Screen recording of the running app (${i.source.replace(/^.*\//, "").replace(/\.[^.]+$/, "")})`,
      ...(i.poster === null ? {} : { poster: i.poster }),
    }));
  return { ...report, blocks: [...added, ...blocks] };
}

/**
 * Shorten what an agent wrote past the report's lengths and counts, rather
 * than throw the whole report away. A summary line three words too long is
 * not worth failing a verification gate over; what was shortened is listed as
 * a problem, so the check still says so.
 */
export function fitReport(raw: PrReport): { readonly report: PrReport; readonly trimmed: readonly string[] } {
  const trimmed: string[] = [];
  const note = (what: string, before: number, after: number): void => {
    if (before !== after) trimmed.push(`${what} was shortened to fit (${before} → ${after})`);
  };
  const summary = (raw.summary ?? []).slice(0, 3).map((line, i) => {
    const out = clip(line, 200);
    note(`summary line ${i + 1}`, line.length, out.length);
    return out;
  });
  if ((raw.summary ?? []).length > 3) trimmed.push(`${raw.summary.length - 3} summary line(s) past the third were dropped`);
  const blocks = (raw.blocks ?? []).map((b, i): Block => {
    if (b.type === "file") {
      const caption = clip(b.caption, 300);
      note(`block ${i + 1}'s caption`, b.caption.length, caption.length);
      return { ...b, caption };
    }
    const title = clip(b.title, 200);
    note(`block ${i + 1}'s title`, b.title.length, title.length);
    return { ...b, title };
  });
  const focus = raw.focus?.slice(0, 6).map((f, i) => {
    const title = clip(f.title, 120);
    const detail = clip(f.detail, 1000);
    note(`focus ${i + 1}'s title`, f.title.length, title.length);
    note(`focus ${i + 1}'s detail`, f.detail.length, detail.length);
    return { ...f, title, detail };
  });
  if ((raw.focus?.length ?? 0) > 6) trimmed.push(`${raw.focus!.length - 6} focus item(s) past the sixth were dropped`);
  return { report: { ...raw, summary, blocks, ...(focus === undefined ? {} : { focus }) }, trimmed };
}

/**
 * Store a role's report: validate it, put its files on the media ref and the
 * report on the data ref. A file it names but did not write is a problem the
 * check reports, not a crash: the rest of the report is still worth showing.
 */
export async function storeReport(opts: {
  readonly gh: GitHub;
  readonly dir: string;
  readonly role: string;
  readonly workItem: string;
  readonly attempt: number;
  readonly now: string;
}): Promise<StoredReport | null> {
  const file = join(opts.dir, REPORT_FILE);
  if (!existsSync(file)) return null;
  const fitted = fitReport(JSON.parse(readFileSync(file, "utf8")) as PrReport);
  const trimmed = fitted.trimmed;
  // Recordings are made to fit before anything is stored, so the data ref only
  // ever holds the small copy and a runaway session cannot fill it.
  const recorded = processRecordings(opts.dir);
  const report = attachRecordings(fitted.report, recorded.items);
  assertValid("pr-report", report);

  // Dated, because the monthly media squash decides expiry from the date in the
  // path, and recordings are the files most worth expiring.
  const prefix = `reports/${opts.now.slice(0, 10)}/${opts.workItem}/${opts.role}-${opts.attempt}`;
  const changes: { path: string; content: string; encoding: "base64" }[] = [];
  const inline: Record<string, string> = {};
  const problems: string[] = [...trimmed, ...recorded.problems];
  for (const rel of filesOf(report)) {
    const abs = inside(opts.dir, rel);
    if (abs === null || !existsSync(abs)) {
      problems.push(`${opts.role} names ${rel}, which it did not write`);
      continue;
    }
    const size = statSync(abs).size;
    if (size > FILE_CAP_BYTES) {
      problems.push(`${rel} is ${Math.round(size / 1024 / 1024)} MB, over the 10 MB a proof file may be`);
      continue;
    }
    changes.push({ path: `${prefix}/${rel}`, content: readFileSync(abs, "base64"), encoding: "base64" });
    if (TEXT_EXT.has(extname(rel).toLowerCase()) && !rel.endsWith(".md")) {
      inline[rel] = readFileSync(abs, "utf8").slice(0, INLINE_CAP);
    }
  }
  const media = new FactoryStore(opts.gh, MEDIA_REF);
  const commit = changes.length === 0 ? null : await media.data.commit(changes, `${opts.role} report for ${opts.workItem}`);
  const stored: StoredReport = {
    role: opts.role,
    attempt: opts.attempt,
    report,
    media_commit: commit,
    media_prefix: prefix,
    inline,
    ...(recorded.items.length === 0 ? {} : { videos: recorded.items.map((v) => ({ file: v.file, seconds: v.seconds, bytes: v.bytes })) }),
    problems,
    stored_at: opts.now,
  };
  await new FactoryStore(opts.gh).put(
    [{ path: reportPath(opts.workItem, opts.role), content: json(stored) }],
    `${opts.role} report for ${opts.workItem}`,
  );
  return stored;
}

/* ------------------------------------------------------------------- render */

export interface RenderInput {
  readonly repo: string;
  readonly kind: "change" | "setup" | "escalation";
  readonly reports: readonly StoredReport[];
  /** Links to the spec and anything else under Read more. */
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  /** A footer line, such as the work item and run. */
  readonly footer?: string;
  /** For an escalation: why it stopped, shown first. */
  readonly lead?: readonly string[];
  /** The change touches what a person can see, so the PR must carry a video of it working. */
  readonly needsVideo?: boolean;
}

export interface Rendered {
  readonly body: string;
  /** Proof that did not fit in the body; it goes in one PR comment. */
  readonly continued: string | null;
  readonly problems: readonly string[];
}

export const MARKER = "<!-- bsf:pr-report v1 -->";
export const CONTINUED_MARKER = "<!-- bsf:pr-report-continued v1 -->";
/** GitHub's limit is 65,536 characters; this leaves room for its own additions. */
const BODY_LIMIT = 60_000;

const ROLE_HEADING: Readonly<Record<string, string>> = {
  builder: "From the builder",
  verifier: "Checked independently by the verifier",
  setup: "From setup",
};

function url(repo: string, stored: StoredReport, rel: string, raw: boolean): string {
  const path = `${stored.media_prefix}/${rel}`.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/${stored.media_commit ?? "HEAD"}/${path}${raw ? "?raw=true" : ""}`;
}

function fence(text: string, lang: string): string {
  const ticks = text.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${text.replace(/\s+$/, "")}\n${ticks}`;
}

export function renderBlock(repo: string, stored: StoredReport, b: Block): string {
  if (b.type === "diagram") return `**${b.title}**\n\n${fence(b.mermaid, "mermaid")}`;
  const ext = extname(b.file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return `![${b.caption}](${url(repo, stored, b.file, true)})\n<sub>${b.caption}</sub>`;
  if (VIDEO_EXT.has(ext)) {
    // GitHub plays a video only from its own uploads, so an animated GIF (or a
    // still) of it stands in, linking to the file.
    const info = stored.videos?.find((v) => v.file === b.file);
    const meta = info === undefined ? "" : ` · ${[info.seconds === null ? null : clock(info.seconds), mb(info.bytes)].filter((x) => x !== null).join(" · ")}`;
    const video = url(repo, stored, b.file, true);
    return b.poster !== undefined
      ? `[![${b.caption} — play the video](${url(repo, stored, b.poster, true)})](${video})\n<sub>▶ ${b.caption}${meta} · [open the video](${video})</sub>`
      : `▶ [${b.caption} (video)](${video})${meta}`;
  }
  const text = stored.inline[b.file];
  if (text !== undefined) {
    const lang = ext === ".json" ? "json" : ext === ".yml" || ext === ".yaml" ? "yaml" : ext === ".xml" || ext === ".html" ? ext.slice(1) : "";
    const cut = text.length >= INLINE_CAP ? `\n\n[The whole file](${url(repo, stored, b.file, false)})` : "";
    return `<details open><summary>${b.caption}</summary>\n\n${fence(text, lang)}${cut}\n\n</details>`;
  }
  return `📎 [${b.caption}](${url(repo, stored, b.file, false)})`;
}

/** The PR body (and, when the proof will not fit, the comment it continues in). */
export function renderReport(input: RenderInput): Rendered {
  const problems: string[] = [];
  const builder = input.reports.find((r) => r.role === "builder" || r.role === "setup") ?? input.reports[0];
  if (builder === undefined) problems.push("no role wrote a report");
  for (const r of input.reports) problems.push(...r.problems);

  const summary = builder?.report.summary ?? [];
  const head: string[] = [MARKER, ""];
  if (input.lead !== undefined && input.lead.length > 0) {
    head.push("### Why this stopped", "", ...input.lead.map((l) => `> ${l}`), "");
  }
  head.push("### Summary", "", ...summary.map((l) => `> ${l}  `), "");

  const proof: string[] = [];
  for (const r of input.reports) {
    if (r.report.blocks.length === 0) continue;
    proof.push(`#### ${ROLE_HEADING[r.role] ?? r.role}`, "");
    for (const b of r.report.blocks) proof.push(renderBlock(input.repo, r, b), "");
  }
  if (proof.length === 0) problems.push("there is no proof: no screenshot, recording, log or diagram");
  if (input.needsVideo === true) {
    const hasVideo = input.reports.some((r) => r.report.blocks.some((b) => b.type === "file" && VIDEO_EXT.has(extname(b.file).toLowerCase())));
    if (!hasVideo) problems.push("this change touches the UI, and no role recorded a video of it working");
  }

  const focus = input.reports.flatMap((r) => r.report.focus ?? []);
  const tail: string[] = [];
  if (focus.length > 0) {
    tail.push("### Key things to focus on", "");
    for (const f of focus) {
      const files = (f.files ?? []).map((x) => `\`${x}\``).join(", ");
      tail.push(`- **${f.title}** — ${f.detail}${files === "" ? "" : ` (${files})`}`);
    }
    tail.push("");
  } else if (input.kind !== "escalation") {
    problems.push("there are no key things to focus on");
  }

  const more: string[] = [...(input.links ?? []).map((l) => `[${l.label}](${l.url})`)];
  if (builder !== undefined) {
    if (builder.report.technical !== undefined) more.push(`[Technical breakdown](${url(input.repo, builder, builder.report.technical, false)})`);
    else if (input.kind !== "escalation") problems.push("there is no technical breakdown");
    if (builder.report.conceptual !== undefined) more.push(`[Conceptual breakdown](${url(input.repo, builder, builder.report.conceptual, false)})`);
    else if (input.kind !== "escalation") problems.push("there is no conceptual breakdown");
  }
  if (more.length > 0) tail.push("### Read more", "", more.join(" · "), "");
  if (input.footer !== undefined) tail.push(`<sub>${input.footer}</sub>`);
  // The setup PR is a person's first sight of the factory, so it carries the byline.
  if (input.kind === "setup") tail.push("", `<sub>${attributionMarkdown()}</sub>`);

  const headText = head.join("\n");
  const tailText = tail.join("\n");
  // Proof blocks go in whole: the body takes as many as fit, the comment the rest.
  const blocks = splitBlocks(proof);
  const room = BODY_LIMIT - headText.length - tailText.length - 400;
  let used = 0;
  let cut = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    if (used + blocks[i]!.length > room) {
      cut = i;
      break;
    }
    used += blocks[i]!.length;
  }
  const inBody = blocks.slice(0, cut).join("\n");
  const rest = blocks.slice(cut).join("\n");
  const proofHeading = proof.length === 0 ? "" : `### Proof\n\n${inBody}${rest === "" ? "" : "\n_The rest of the proof continues in the comment below._\n"}\n`;
  return {
    body: `${headText}\n${proofHeading}${tailText}`,
    continued: rest === "" ? null : `${CONTINUED_MARKER}\n\n### Proof, continued\n\n${rest}`,
    problems,
  };
}

/** Proof lines grouped so a block (heading, image, caption) is never split. */
function splitBlocks(lines: readonly string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    cur.push(l);
    if (l === "") {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  if (cur.length > 0) out.push(cur.join("\n"));
  return out;
}

/* ------------------------------------------------------------------ publish */

export const REPORT_CHECK = "factory/pr-report";

interface SpecDoc {
  readonly title?: string;
  readonly spec?: Record<string, unknown> | null;
  readonly id: string;
  readonly pipeline?: string;
}

/**
 * Whether a PR must carry a video: product work whose spec says it touches
 * the UI. Gardening and hardening change no behavior on purpose, so their
 * proof is the gates' before-and-after, not a recording.
 */
export function needsVideo(item: SpecDoc | null): boolean {
  return item?.pipeline === "product_work" && item.spec?.["ui_change"] === true;
}

/** The spec, as markdown a person reads. */
export function specMarkdown(item: SpecDoc): string {
  const spec = item.spec ?? {};
  const lines = [`# ${item.title ?? item.id}`, ""];
  for (const [k, v] of Object.entries(spec)) {
    lines.push(`## ${k.replace(/_/g, " ")}`, "");
    if (Array.isArray(v)) for (const x of v) lines.push(`- ${typeof x === "string" ? x : `\`${JSON.stringify(x)}\``}`);
    else if (typeof v === "object" && v !== null) lines.push(fence(JSON.stringify(v, null, 2), "json"));
    else lines.push(String(v));
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Render a factory PR from its work item's reports: set the body, keep the
 * continued proof in one comment, and report factory/pr-report.
 */
export async function publishReport(opts: {
  readonly gh: GitHub;
  readonly workItem: string;
  readonly pr: number;
  readonly now: string;
  readonly footer?: string;
}): Promise<Rendered> {
  const store = new FactoryStore(opts.gh);
  const reports: StoredReport[] = [];
  for (const role of ["builder", "verifier"]) {
    const r = await store.data.readJson<StoredReport>(reportPath(opts.workItem, role));
    if (r !== null) reports.push(r);
  }
  const item = await store.get<SpecDoc>(workItemPath(opts.workItem), "work-item");
  const links: { label: string; url: string }[] = [];
  if (item?.spec != null) {
    const media = new FactoryStore(opts.gh, MEDIA_REF);
    const path = `reports/${opts.workItem}/spec.md`;
    const commit = await media.data.commit([{ path, content: specMarkdown(item) }], `spec for ${opts.workItem}`);
    links.push({ label: "Full spec", url: `https://github.com/${opts.gh.repo}/blob/${commit}/${path}` });
  }
  const rendered = renderReport({
    repo: opts.gh.repo,
    kind: "change",
    reports,
    links,
    needsVideo: needsVideo(item),
    footer: opts.footer ?? `Work item ${opts.workItem}`,
  });
  await opts.gh.send("PATCH", `repos/${opts.gh.repo}/pulls/${opts.pr}`, { body: rendered.body });
  await upsertContinued(opts.gh, opts.pr, rendered.continued);
  await reportCheck(opts.gh, opts.pr, rendered.problems);
  return rendered;
}

async function upsertContinued(gh: GitHub, pr: number, text: string | null): Promise<void> {
  const comments = await gh.get<{ id: number; body?: string }[]>(`repos/${gh.repo}/issues/${pr}/comments?per_page=100`);
  const mine = comments.find((c) => (c.body ?? "").startsWith(CONTINUED_MARKER));
  if (text === null) {
    if (mine !== undefined) await gh.send("DELETE", `repos/${gh.repo}/issues/comments/${mine.id}`);
    return;
  }
  if (mine !== undefined) await gh.send("PATCH", `repos/${gh.repo}/issues/comments/${mine.id}`, { body: text });
  else await gh.send("POST", `repos/${gh.repo}/issues/${pr}/comments`, { body: text });
}

/* -------------------------------------------------------------------- setup */

/**
 * A setup PR's report: the setup agent's own, with the trial's screenshot of
 * the app running in the frozen sandbox put first, because that is the proof
 * a person most needs. Stored on the media ref under the setup run.
 */
/** Fields the schema caps, and the cap. Text past it is cut, not refused. */
const TEXT_CAPS: readonly { readonly path: readonly string[]; readonly max: number }[] = [
  { path: ["summary", "*"], max: 200 },
  { path: ["blocks", "*", "caption"], max: 300 },
  { path: ["blocks", "*", "title"], max: 200 },
  { path: ["focus", "*", "title"], max: 120 },
  { path: ["focus", "*", "detail"], max: 1000 },
];

function clampAt(node: unknown, path: readonly string[], max: number, label: string, out: string[]): void {
  if (path.length === 0 || node === null || typeof node !== "object") return;
  const [head, ...rest] = path;
  const holder = node as Record<string, unknown>;
  const keys = head === "*" ? (Array.isArray(node) ? node.map((_, i) => String(i)) : []) : [head as string];
  for (const k of keys) {
    const v = holder[k];
    if (rest.length === 0) {
      if (typeof v === "string" && v.length > max) {
        holder[k] = `${v.slice(0, max - 1).trimEnd()}…`;
        out.push(`${label}${k} was ${v.length} characters; the limit is ${max}`);
      }
    } else {
      clampAt(v, rest, max, `${label}${k}/`, out);
    }
  }
}

/** The setup agent's report, cut to the schema's limits where it ran over. */
export function readReportFile(file: string): { report: PrReport | null; clamped: string[]; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { report: null, clamped: [], why: `it is not JSON (${(e as Error).message})` };
  }
  const clamped: string[] = [];
  for (const c of TEXT_CAPS) clampAt(raw, c.path, c.max, "", clamped);
  try {
    assertValid("pr-report", raw);
  } catch (e) {
    return { report: null, clamped, why: (e as Error).message.split("\n").slice(0, 3).join("; ") };
  }
  return { report: raw as PrReport, clamped, why: "" };
}

export async function renderSetupReport(opts: {
  readonly gh: GitHub;
  readonly dir: string;
  readonly trialDir: string;
  readonly runId: string;
  readonly tier: string;
  readonly extraFocus: readonly { readonly title: string; readonly detail: string }[];
  readonly links: readonly { readonly label: string; readonly url: string }[];
  readonly now: string;
}): Promise<Rendered> {
  const file = join(opts.dir, REPORT_FILE);
  const problems: string[] = [];
  let report: PrReport;
  if (existsSync(file)) {
    const parsed = readReportFile(file);
    if (parsed.report === null) {
      // The agent's write-up is prose around a sandbox that has already been
      // measured. A write-up that will not parse must not stop the sandbox
      // from landing: say so, and describe the sandbox mechanically.
      problems.push(`the setup agent's report could not be used: ${parsed.why}`);
      report = { schema: "pr-report/1", summary: [`The factory's sandbox for this repo, measured at tier ${opts.tier}.`], blocks: [] };
    } else {
      report = parsed.report;
      // Shortened text is not missing proof, so it is not a problem on the PR.
      for (const c of parsed.clamped) process.stdout.write(`  report text shortened: ${c}\n`);
    }
  } else {
    problems.push("the setup agent wrote no report");
    report = { schema: "pr-report/1", summary: [`The factory's sandbox for this repo, measured at tier ${opts.tier}.`], blocks: [] };
  }
  const shot = join(opts.trialDir, "screenshot.png");
  const blocks: Block[] = [
    ...(existsSync(shot)
      ? [{ type: "file" as const, file: "trial/screenshot.png", caption: `The app running in the frozen sandbox, as the trial measured it (tier ${opts.tier})` }]
      : []),
    ...report.blocks,
  ];
  const full: PrReport = { ...report, blocks, focus: [...(report.focus ?? []), ...opts.extraFocus] };

  const prefix = `reports/${opts.now.slice(0, 10)}/setup-${opts.runId}/setup-1`;
  const changes: { path: string; content: string; encoding: "base64" }[] = [];
  const inline: Record<string, string> = {};
  for (const rel of filesOf(full)) {
    const abs = rel === "trial/screenshot.png" ? shot : inside(opts.dir, rel);
    if (abs === null || !existsSync(abs)) {
      problems.push(`setup names ${rel}, which it did not write`);
      continue;
    }
    changes.push({ path: `${prefix}/${rel}`, content: readFileSync(abs, "base64"), encoding: "base64" });
    if (TEXT_EXT.has(extname(rel).toLowerCase()) && !rel.endsWith(".md")) inline[rel] = readFileSync(abs, "utf8").slice(0, INLINE_CAP);
  }
  const commit = changes.length === 0 ? null : await new FactoryStore(opts.gh, MEDIA_REF).data.commit(changes, `setup report for run ${opts.runId}`);
  const stored: StoredReport = {
    role: "setup", attempt: 1, report: full, media_commit: commit, media_prefix: prefix, inline, problems, stored_at: opts.now,
  };
  return renderReport({ repo: opts.gh.repo, kind: "setup", reports: [stored], links: opts.links, footer: `Setup run ${opts.runId}` });
}

/** factory/pr-report on a PR, from the problems its render found. */
export async function reportCheck(gh: GitHub, pr: number, problems: readonly string[]): Promise<void> {
  const head = (await gh.pull(pr)).head.sha;
  await gh.reportCheck({
    name: REPORT_CHECK,
    headSha: head,
    conclusion: problems.length === 0 ? "success" : "failure",
    title: problems.length === 0 ? "The PR shows its proof" : "The PR does not show its proof",
    summary:
      problems.length === 0
        ? "Summary, proof, key things to focus on and the longer breakdowns are all on the PR."
        : `What is missing:\n\n${problems.map((p) => `- ${p}`).join("\n")}`,
  });
}
