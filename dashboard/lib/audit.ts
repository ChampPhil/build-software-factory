/**
 * Whether the factory audit is still failed.
 *
 * Purpose:
 *   factory-audit re-runs the gates on every push to main. When that
 *   workflow fails, the briefing should say so in red until a later run
 *   of the same workflow succeeds. The dashboard already loads recent
 *   Actions runs for the Factory and Runs pages. This module reads that
 *   same list. It does not call GitHub itself.
 *
 * Key terms:
 *   - factory-audit: the GitHub Actions workflow whose file is
 *     factory-audit.yml. Its run name is factory-audit.
 *   - Green: the run completed with conclusion "success". That is the
 *     only result that clears a failure.
 *   - Failed: the run completed with "failure" or "timed_out".
 *   - Workflow run: one execution of a workflow, as GitHub Actions
 *     reports it (status, conclusion, when it started, link to the log).
 *
 * Exports:
 *   - AuditWorkflowRun: the fields this check needs from a workflow run.
 *   - failedFactoryAudit: the newest failed audit run that a later success
 *     has not cleared, or null.
 */

/** The slice of a GitHub Actions run this check needs. */
export interface AuditWorkflowRun {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly html_url: string;
}

const FAILED = new Set(["failure", "timed_out"]);

/**
 * Whether this run is the factory audit, from its file path or its name.
 *
 * path: the workflow file, such as .github/workflows/factory-audit.yml.
 * name: the workflow's display name.
 */
function isFactoryAudit(path: string | undefined, name: string): boolean {
  return /factory-audit/.test(`${path ?? ""} ${name}`);
}

/**
 * The failed factory-audit run the briefing should keep showing.
 *
 * Runs are taken newest first. Only a completed success clears the
 * failure. A newer run that is still going, or that was cancelled, does
 * not hide an older failure. Null when there is no audit run, or the
 * newest decisive audit run is green.
 *
 * runs: recent workflow runs already loaded by the dashboard. Any workflow
 * that is not factory-audit is ignored.
 */
export function failedFactoryAudit<T extends AuditWorkflowRun>(runs: readonly T[]): T | null {
  const audits = runs.filter((run) => isFactoryAudit(run.path, run.name));
  const ranked = [...audits].sort((a, b) => {
    const aTime = Date.parse(a.created_at);
    const bTime = Date.parse(b.created_at);
    const delta = (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    return delta !== 0 ? delta : b.id - a.id;
  });

  for (const run of ranked) {
    if (run.status !== "completed" || run.conclusion === null) continue;
    // Green clears every older failure.
    if (run.conclusion === "success") return null;
    if (FAILED.has(run.conclusion)) return run;
  }
  return null;
}
