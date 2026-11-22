import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHub } from "../lib/github.js";
import { detectionUsd, type BudgetDoc, type BudgetMeasure } from "./budget.js";

/**
 * Holds whose step has ended but never settled: settled from what the step
 * measured, and charged at the ceiling only when nothing was measured.
 *
 * A hold outlives its step when the settle job did not run (the workflow was
 * cancelled) or when its record was lost to a concurrent write. Charging
 * those at the ceiling, as the sweep did, charged a step that was already
 * paid for a second time at the most it could have cost: on trinsports, four
 * finished steps held $15.60 and blocked a sandbox repair. The step's own
 * measure is still in its run's artifacts, so it is read from there.
 */

export interface StaleHold {
  readonly key: string;
  readonly model?: string;
  readonly started_at: string;
}

export interface HoldVerdict {
  readonly key: string;
  readonly agentUsd: number | null;
  readonly detectionUsd: number | null;
  readonly pipeline?: string;
  readonly why: string;
}

/** The run and attempt a budget key names: `<run_id>-<attempt>-<job>`. */
export function runOfKey(key: string): { run: number; attempt: number } | null {
  const m = /^(\d+)-(\d+)-/.exec(key);
  return m === null ? null : { run: Number(m[1]), attempt: Number(m[2]) };
}

export interface SweepDeps {
  /** The run attempt's status, or null when GitHub does not know it. */
  readonly runStatus: (run: number, attempt: number) => Promise<{ status: string; updated_at: string } | null>;
  /** Unpack the run's artifact with this name into a fresh directory, or null when there is none. */
  readonly artifact: (run: number, name: string) => Promise<string | null>;
  readonly log: (l: string) => void;
}

/** Settle after this long past the run's end: its own settle job would have run by then. */
const GRACE_MS = 20 * 60 * 1000;

/**
 * Which holds can be settled now, and with what. A hold is stale once its
 * run has ended (plus a grace period for its own settle job) or once it is
 * older than maxAgeSec whatever GitHub says.
 */
export async function staleHolds(doc: BudgetDoc, now: string, maxAgeSec: number, deps: SweepDeps): Promise<readonly HoldVerdict[]> {
  const out: HoldVerdict[] = [];
  for (const h of doc.inflight) {
    const ref = runOfKey(h.key);
    const tooOld = Date.parse(now) - Date.parse(h.started_at) > maxAgeSec * 1000;
    let ended = false;
    if (ref !== null) {
      const st = await deps.runStatus(ref.run, ref.attempt).catch(() => null);
      ended = st !== null && st.status === "completed" && Date.parse(now) - Date.parse(st.updated_at) > GRACE_MS;
    }
    if (!ended && !tooOld) continue;
    let agentUsd: number | null = null;
    let detUsd: number | null = null;
    let pipeline: string | undefined;
    if (ref !== null) {
      const dir = await deps.artifact(ref.run, `budget-${h.key}`).catch(() => null);
      const file = dir === null ? null : join(dir, "measure.json");
      if (file !== null && existsSync(file)) {
        try {
          const m = JSON.parse(readFileSync(file, "utf8")) as BudgetMeasure;
          if (m.key === h.key) {
            agentUsd = typeof m.agent_usd === "number" ? m.agent_usd : null;
            if (typeof m.pipeline === "string") pipeline = m.pipeline;
            if (m.detection_artifact !== "") {
              const det = await deps.artifact(ref.run, m.detection_artifact).catch(() => null);
              if (det !== null) detUsd = detectionUsd(det, "claude-haiku-5-5", deps.log);
            }
          }
        } catch {
          /* unreadable: charged at the ceiling */
        }
      }
    }
    out.push({
      key: h.key,
      agentUsd,
      detectionUsd: detUsd,
      ...(pipeline === undefined ? {} : { pipeline }),
      why: `${ended ? "its run ended" : "older than the limit"}; ${agentUsd === null ? "no measure found, charged at the ceiling" : `measured $${agentUsd.toFixed(4)}`}`,
    });
  }
  return out;
}

/** The real lookups, through the gh CLI. */
export function githubSweepDeps(gh: GitHub, log: (l: string) => void): SweepDeps {
  return {
    runStatus: async (run, attempt) => {
      const r = await gh.get<{ status: string; updated_at: string }>(`repos/${gh.repo}/actions/runs/${run}/attempts/${attempt}`);
      return { status: r.status, updated_at: r.updated_at };
    },
    artifact: async (run, name) => {
      const list = await gh.get<{ artifacts: { id: number; name: string; expired: boolean }[] }>(
        `repos/${gh.repo}/actions/runs/${run}/artifacts?name=${encodeURIComponent(name)}&per_page=5`,
      );
      const a = list.artifacts.find((x) => x.name === name && !x.expired);
      if (a === undefined) return null;
      const dir = mkdtempSync(join(tmpdir(), "bsf-artifact-"));
      const zip = join(dir, "a.zip");
      const dl = spawnSync("gh", ["api", `repos/${gh.repo}/actions/artifacts/${a.id}/zip`], { maxBuffer: 64 * 1024 * 1024 });
      if (dl.status !== 0) return null;
      writeFileSync(zip, dl.stdout);
      const out = join(dir, "out");
      mkdirSync(out);
      const u = spawnSync("unzip", ["-q", "-o", zip, "-d", out]);
      if (u.status !== 0) {
        log(`could not unpack ${name}`);
        return null;
      }
      return out;
    },
    log,
  };
}
