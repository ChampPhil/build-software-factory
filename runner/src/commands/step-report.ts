import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * `bsf step-report` — writes one role's step report (doc 09).
 *
 * This runs in the role workflow's `post-steps`, after the agent has finished.
 * Where the harness wrote a usage file, the numbers come from it; where it did
 * not, the report says the cost is unknown rather than estimating one. A cost
 * invented here would be averaged into the spend the budget pauses on, which
 * is the one number in the factory nobody should be guessing.
 */

/** The harnesses the schemas name (schema/_common.json). */
export type Harness = "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";

export interface StepReportInput {
  readonly harness: Harness;
  readonly role: string;
  readonly model: string;
  readonly exit: "ok" | "failed" | "timeout" | "cancelled";
  readonly durationSec: number;
  readonly filesChanged: readonly string[];
  readonly transcript: string;
  /** The harness's own usage file, when it wrote one. */
  readonly usagePath?: string;
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
  const usage = input.usagePath === undefined ? null : readUsage(input.usagePath);

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
