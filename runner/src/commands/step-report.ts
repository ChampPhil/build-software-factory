import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { readSessionUsage } from "../lib/session.js";
import type { Harness } from "../lib/types.js";
import { join, dirname } from "node:path";

/**
 * `bsf step-report` — writes one role's step report (doc 09).
 *
 * This runs in the role workflow's `post-steps`, after the agent has finished,
 * and asks four sources in order:
 *
 * 1. **gh-aw's own session evidence** — `agent-session.jsonl` and the API
 *    proxy's `token-usage.jsonl`, both present in the agent job. Proxy
 *    metering beats a CLI's self-report, and gh-aw has already normalized it.
 * 2. **The harness's own session log**, read with memex, when gh-aw's evidence
 *    carried nothing for this step.
 * 3. **The bundled price table**, to price tokens that arrived with no cost.
 * 4. **Nothing** — `cost_source: "unknown"`.
 *
 * The fourth is the point. A cost invented here is averaged into the spend the
 * budget pauses pipelines on, so a guessed zero quietly raises the ceiling on
 * what the factory may spend. gh-aw's session specification states the same
 * rule for the same reason: absence is not zero.
 */

/** The harnesses the schemas name (schema/_common.json). */
export type { Harness } from "../lib/types.js";

export interface StepReportInput {
  readonly harness: Harness;
  readonly role: string;
  readonly model: string;
  readonly exit: "ok" | "failed" | "timeout" | "cancelled";
  readonly durationSec: number;
  readonly filesChanged: readonly string[];
  readonly transcript: string;
  /** The harness's own usage file (memex's output), when it wrote one. */
  readonly usagePath?: string;
  /** Where gh-aw left its session evidence in this job. */
  readonly sessionDirs?: readonly string[];
  readonly priceTable?: Readonly<Record<string, { readonly in: number; readonly out: number }>>;
}

export interface StepReport {
  readonly schema: "step-report/1";
  readonly harness: Harness;
  readonly role: string;
  readonly model: string;
  readonly exit: string;
  readonly duration_sec: number;
  readonly tokens: { readonly in: number; readonly out: number };
  readonly cost_usd: number;
  readonly cost_source: "session_log" | "price_table" | "unknown";
  /** Which evidence the numbers came from, for diagnosing a missing cost. */
  readonly usage_source?: "agent_session" | "token_usage" | "harness_log";
  readonly files_changed: readonly string[];
  readonly transcript: string;
}

interface Usage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_cost_usd?: number;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly cost?: { readonly total_usd?: number };
}

/** Read whichever of the harnesses' usage shapes is present. */
export function readUsage(path: string): { tokensIn: number; tokensOut: number; costUsd: number | null } | null {
  if (!existsSync(path)) return null;
  let doc: Usage;
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as Usage;
  } catch {
    return null;
  }
  const tokensIn = doc.input_tokens ?? doc.usage?.input_tokens ?? 0;
  const tokensOut = doc.output_tokens ?? doc.usage?.output_tokens ?? 0;
  const costUsd = doc.total_cost_usd ?? doc.cost?.total_usd ?? null;
  if (tokensIn === 0 && tokensOut === 0 && costUsd === null) return null;
  return { tokensIn, tokensOut, costUsd };
}

export function buildStepReport(input: StepReportInput): StepReport {
  // gh-aw first, the harness's own log second.
  const session = input.sessionDirs === undefined ? null : readSessionUsage(input.sessionDirs);
  const harnessLog = input.usagePath === undefined ? null : readUsage(input.usagePath);

  const usage: { tokensIn: number; tokensOut: number; costUsd: number | null; from: StepReport["usage_source"] } | null =
    session !== null
      ? { tokensIn: session.tokensIn, tokensOut: session.tokensOut, costUsd: session.costUsd, from: session.from }
      : harnessLog !== null
        ? { tokensIn: harnessLog.tokensIn, tokensOut: harnessLog.tokensOut, costUsd: harnessLog.costUsd, from: "harness_log" }
        : null;

  let cost = 0;
  let source: StepReport["cost_source"] = "unknown";

  if (usage?.costUsd != null) {
    cost = round4(usage.costUsd);
    source = "session_log";
  } else if (usage !== null && input.priceTable?.[input.model] !== undefined) {
    const price = input.priceTable[input.model]!;
    cost = round4((usage.tokensIn / 1_000_000) * price.in + (usage.tokensOut / 1_000_000) * price.out);
    source = "price_table";
  }

  return {
    schema: "step-report/1",
    harness: input.harness,
    role: input.role,
    model: input.model,
    exit: input.exit,
    duration_sec: Math.max(0, Math.round(input.durationSec)),
    tokens: { in: usage?.tokensIn ?? 0, out: usage?.tokensOut ?? 0 },
    cost_usd: cost,
    cost_source: source,
    ...(usage?.from === undefined ? {} : { usage_source: usage.from }),
    files_changed: [...input.filesChanged],
    transcript: input.transcript,
  };
}

/** Write it where the role workflow's upload step expects it. */
export function writeStepReport(path: string, report: StepReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Files the agent changed, from git, so a role cannot under-report its diff. */
export function changedFilesFromGit(root: string): readonly string[] {
  try {
    const out = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((l) => l !== "")
      .map((l) => (l.includes(" -> ") ? l.split(" -> ")[1]! : l));
  } catch {
    return [];
  }
}

/** The path the role workflow uploads from. */
export const stepReportFile = (dir: string, role: string): string => join(dir, `${role}.json`);
