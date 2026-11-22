import { activeGoals, goalLines, readGoals } from "./standing-goals.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { GitHub } from "../lib/github.js";
import { FactoryStore, json, workItemPath, runPath } from "../lib/store.js";
import { MEDIA_REF, type Change } from "../lib/dataref.js";
import { stripUntrustedText } from "./intake.js";
import { assertValid } from "../lib/schema.js";
import { specProblems, type SpecGateInput } from "./spec-gate.js";

/**
 * The steps that run around an agent, inside a role workflow.
 *
 * A role's agent cannot reach the data refs: it has a read-only token and no
 * write path except gh-aw safe outputs (doc 06). So everything it needs is
 * fetched into a file before it starts, and everything it produces is read out
 * of a file afterwards, by these commands.
 *
 * The fetch half is also where untrusted text is stripped. An issue body from
 * someone outside the repo must never reach a prompt, and the only reliable
 * place to enforce that is the step that writes the prompt's input — not the
 * prompt itself, which is a document an agent could be talked into ignoring.
 */

/* --------------------------------------------------------------- work items */

export interface WorkItemFile {
  schema: "work-item/1";
  id: string;
  pipeline: string;
  title: string;
  body: string | null;
  status: string;
  trigger_class: string;
  source: { kind: string; ref: string | null; actor: string; via: string | null };
  spec: unknown;
  related?: readonly string[];
  runs?: readonly string[];
  pr?: number | null;
  [k: string]: unknown;
}

export interface FetchWorkItemOptions {
  readonly gh: GitHub;
  readonly id: string;
  readonly out: string;
  /** The verifier gets the spec and the result, never the request's prose. */
  readonly specOnly?: boolean;
  /** The spec role gets triage's notes as well. */
  readonly withTriage?: boolean;
  /**
   * Triage gets the open items that may be the same request, so it can decide
   * whether this one is a duplicate. Computed here from the ledger: intake
   * shortlists by fingerprint but never stored the result, so the flag triage
   * passed asked for something that did not exist.
   */
  readonly withShortlist?: boolean;
  /** Associations the policy trusts, for deciding whether the body may be used. */
  readonly trustedAssociations?: readonly string[];
}

export interface FetchWorkItemReport {
  readonly id: string;
  readonly wrote: string;
  readonly strippedBody: boolean;
  readonly includedTriage: boolean;
  readonly specOnly: boolean;
}

export async function fetchWorkItem(opts: FetchWorkItemOptions): Promise<FetchWorkItemReport> {
  const store = new FactoryStore(opts.gh);
  const item = await store.get<WorkItemFile>(workItemPath(opts.id), "work-item");
  if (item === null) throw new Error(`${opts.id} is not on the data ref`);

  if (opts.specOnly === true) {
    // The verifier never sees the builder's transcript, and it does not need
    // the original request either: it checks the spec's acceptance checks
    // against the running app (doc 06).
    const payload = {
      id: item.id,
      pipeline: item.pipeline,
      title: item.title,
      spec: item.spec,
    };
    write(opts.out, json(payload));
    return { id: item.id, wrote: opts.out, strippedBody: true, includedTriage: false, specOnly: true };
  }

  // A body only reaches a prompt when its author is trusted. `waiting_trust`
  // is the status intake gives an item whose author is not.
  const trusted = item.status !== "waiting_trust";
  const { body, stripped } = stripUntrustedText(
    typeof item.body === "string" ? item.body : undefined,
    trusted,
  );

  const lane = (["product_work", "gardening", "hardening"] as const).find((l) => l === item.pipeline);
  const standing = goalLines(activeGoals(await readGoals(store).catch(() => null), new Date().toISOString(), lane));
  const extra = item as unknown as { goal?: unknown; success_check?: unknown };
  const triage = opts.withTriage === true ? await readTriageNotes(store, item) : null;
  const shortlist = opts.withShortlist === true ? await duplicateShortlist(store, item) : null;

  const payload = {
    id: item.id,
    pipeline: item.pipeline,
    trigger_class: item.trigger_class,
    title: item.title,
    // Marked, not merely included: a prompt that cannot tell the request from
    // the instructions is one an issue can rewrite.
    request: body === null ? null : { source: "user-supplied, untrusted", text: body },
    body_withheld: stripped
      ? "this item's author is not a trusted member, so their text is withheld"
      : null,
    related: item.related ?? [],
    spec: item.spec,
    // What done means, as the person and the chief of staff wrote it. The spec
    // makes at least one acceptance check prove it.
    ...(typeof extra.goal === "string" ? { goal: extra.goal } : {}),
    ...(typeof extra.success_check === "string" ? { success_check: extra.success_check } : {}),
    ...(standing.length === 0 ? {} : { standing_goals: standing }),
    ...(triage === null ? {} : { triage }),
    ...(shortlist === null ? {} : { possible_duplicates: shortlist }),
  };
  write(opts.out, json(payload));
  return {
    id: item.id,
    wrote: opts.out,
    strippedBody: stripped,
    includedTriage: triage !== null,
    specOnly: false,
  };
}

/**
 * Open items with this item's fingerprint, as intake's shortlist computes it.
 * Titles only: triage compares requests, and an untrusted author's body would
 * otherwise reach a prompt through another item's entry.
 */
async function duplicateShortlist(
  store: FactoryStore,
  item: WorkItemFile,
): Promise<readonly { id: string; title: string | null; status: string }[]> {
  const fp = (item as { fingerprint?: string }).fingerprint;
  if (fp === undefined) return [];
  const ledger = await store.ledger(new Date().toISOString());
  const same = ledger.open.filter((o) => o.fingerprint === fp && o.work_item !== item.id);
  const out: { id: string; title: string | null; status: string }[] = [];
  for (const o of same) {
    const other = await store.get<WorkItemFile>(workItemPath(o.work_item), "work-item");
    out.push({ id: o.work_item, title: typeof other?.title === "string" ? other.title : null, status: o.status });
  }
  return out;
}

interface StepReportLike {
  readonly role?: string;
  readonly transcript?: string;
  readonly files_changed?: readonly string[];
}

/** Triage's own step report, which is the one report the spec role may read. */
async function readTriageNotes(store: FactoryStore, item: WorkItemFile): Promise<unknown> {
  const runs = item.runs ?? [];
  const latest = runs[runs.length - 1];
  if (latest === undefined) return null;
  const report = await store.data.readJson<StepReportLike>(`runs/${latest}/steps/triage.json`);
  if (report === null) return null;
  // Deliberately not the transcript: a role reads another role's conclusion,
  // never its reasoning, so one agent cannot inherit another's mistakes.
  return { role: report.role ?? "triage", files_changed: report.files_changed ?? [] };
}

/* ------------------------------------------------------------------- the spec */

export interface Spec {
  plan: string;
  acceptance_checks: string[];
  /** Whether the change alters what a person sees or does in a browser; if so the PR needs a video. */
  ui_change?: boolean;
  files?: string[];
  feature_folders?: string[];
  tests_added?: string[];
  tests_changed?: string[];
  research?: { claim: string; source: string }[];
}

export interface WriteSpecReport {
  readonly id: string;
  readonly declaredTestEdits: readonly string[];
  readonly commit: string;
}

/**
 * Store the spec role's output on the work item.
 *
 * `tests_changed` is the field that matters: the policy check fails any edit
 * to an existing test that is not listed here, so this is where a build
 * declares, before it starts, which tests it intends to change.
 */
export async function writeSpec(
  gh: GitHub,
  id: string,
  from: string,
  _now: string,
  gate?: Omit<SpecGateInput, "spec">,
): Promise<WriteSpecReport> {
  const store = new FactoryStore(gh);
  const item = await store.get<WorkItemFile>(workItemPath(id), "work-item");
  if (item === null) throw new Error(`${id} is not on the data ref`);

  const spec = JSON.parse(readFileSync(from, "utf8")) as Spec;
  if (typeof spec.plan !== "string" || spec.plan.trim() === "") {
    throw new Error(`${from} has no plan`);
  }
  if (!Array.isArray(spec.acceptance_checks) || spec.acceptance_checks.length === 0) {
    // A spec with no checkable acceptance is a spec the verifier cannot act
    // on, which is how a run passes without having been verified.
    throw new Error(`${from} lists no acceptance checks`);
  }
  if (gate !== undefined) {
    const problems = specProblems({ ...gate, spec });
    if (problems.length > 0) {
      // Rejected before any code is written: the builder would otherwise
      // spend an attempt on a plan that was going to fail.
      throw new Error(`the spec was rejected:\n  - ${problems.join("\n  - ")}`);
    }
  }

  // No updated_at: the work-item schema sets additionalProperties false, and
  // the file's own history on the data ref is the record of when it changed.
  const next = { ...item, spec };
  assertValid("work-item", next);
  const commit = await store.put(
    [{ path: workItemPath(id), content: json(next) }],
    `spec: ${id}`,
  );
  return { id, declaredTestEdits: spec.tests_changed ?? [], commit };
}

/* ---------------------------------------------------------------- artifacts */

export interface FetchArtifactReport {
  readonly name: string;
  readonly wrote: string;
  readonly found: boolean;
}

interface ArtifactList {
  readonly artifacts: readonly { readonly id: number; readonly name: string; readonly expired: boolean }[];
}

/**
 * Fetch one of this run's artifacts by name.
 *
 * Role results travel as artifacts within a run, because gh-aw's
 * `workflow_call` accepts no outputs and a job output is capped at 1 MB
 * anyway (spike §2). This is how the builder reads the gate failures from the
 * attempt before it.
 */
export async function fetchArtifact(
  gh: GitHub,
  name: string,
  out: string,
  runId: string | undefined,
): Promise<FetchArtifactReport> {
  if (runId === undefined || runId === "") {
    throw new Error("no run id: pass --run-id, or run inside Actions where GITHUB_RUN_ID is set");
  }
  const list = await gh.get<ArtifactList>(
    `repos/${gh.repo}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  const match = list.artifacts.find((a) => a.name === name && !a.expired);
  if (match === undefined) {
    // An absent artifact is a legitimate state — the first attempt has no
    // gate failures to read — so this writes an empty result rather than
    // failing the step.
    write(out, json({ artifact: name, found: false, items: [] }));
    return { name, wrote: out, found: false };
  }
  const zip = await gh.get<unknown>(`repos/${gh.repo}/actions/artifacts/${match.id}/zip`);
  write(out, typeof zip === "string" ? zip : json(zip));
  return { name, wrote: out, found: true };
}

/* -------------------------------------------------------------------- media */

export interface StoreMediaReport {
  readonly files: readonly string[];
  readonly bytes: number;
  readonly commit: string | null;
  readonly skipped: readonly { readonly file: string; readonly why: string }[];
}

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|webm|zip|json)$/i;
/** Per-file cap. A run that produced something enormous is a bug, not evidence. */
export const MEDIA_FILE_CAP_BYTES = 10 * 1024 * 1024;

/**
 * Put the verifier's screenshots and clips on the media ref.
 *
 * Stored under a dated prefix because that is what makes expiry decidable
 * without reading every blob — the monthly squash reads the date out of the
 * path (see squashMedia).
 */
export async function storeMedia(
  gh: GitHub,
  runDir: string,
  runId: string,
  now: string,
): Promise<StoreMediaReport> {
  if (!existsSync(runDir)) return { files: [], bytes: 0, commit: null, skipped: [] };

  const media = new FactoryStore(gh, MEDIA_REF);
  const changes: Change[] = [];
  const files: string[] = [];
  const skipped: { file: string; why: string }[] = [];
  let bytes = 0;

  for (const abs of walk(runDir)) {
    const rel = relative(runDir, abs);
    if (!MEDIA_EXT.test(rel)) {
      skipped.push({ file: rel, why: "not an image, clip or trace" });
      continue;
    }
    const size = statSync(abs).size;
    if (size > MEDIA_FILE_CAP_BYTES) {
      skipped.push({ file: rel, why: `${Math.round(size / 1024 / 1024)} MB is over the per-file cap` });
      continue;
    }
    const day = now.slice(0, 10);
    changes.push({ path: `media/${day}/${runId}/${rel}`, content: readFileSync(abs, "base64"), encoding: "base64" });
    files.push(rel);
    bytes += size;
  }

  if (changes.length === 0) return { files: [], bytes: 0, commit: null, skipped };
  const commit = await media.data.commit(changes, `media: ${runId} (${files.length} file(s))`);
  return { files, bytes, commit, skipped };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/* ------------------------------------------------------------------ run file */

/** Attach artifact ids to the run file, so the dashboard can find them. */
export async function recordRunArtifacts(
  gh: GitHub,
  runId: string,
  artifacts: Readonly<Record<string, string>>,
): Promise<string | null> {
  const store = new FactoryStore(gh);
  const run = await store.get<Record<string, unknown>>(runPath(runId), "run");
  if (run === null) return null;
  const next = { ...run, artifacts: { ...(run["artifacts"] as object), ...artifacts } };
  assertValid("run", next);
  return store.put([{ path: runPath(runId), content: json(next) }], `run: artifacts for ${runId}`);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
