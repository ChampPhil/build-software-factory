/**
 * Every check that reads a user's repository answers in one of three ways.
 *
 * Before this, a check that could not apply returned the same empty list as a
 * check that found nothing — on a Go repo, a check of npm scripts "passed".
 * Across many repositories most checks do not apply to most of them, so a
 * factory that treats "did not look" as "clean" reports clean on things it
 * never examined. `not_applicable` must say why, so the difference is visible.
 */
export type CheckOutcome<F> =
  | { readonly check: string; readonly state: "clean" }
  | { readonly check: string; readonly state: "findings"; readonly findings: readonly F[] }
  | { readonly check: string; readonly state: "not_applicable"; readonly because: string };

export function outcome<F>(check: string, findings: readonly F[]): CheckOutcome<F> {
  return findings.length === 0 ? { check, state: "clean" } : { check, state: "findings", findings };
}

export function notApplicable<F>(check: string, because: string): CheckOutcome<F> {
  return { check, state: "not_applicable", because };
}

/** One line per check, so a reader sees what was examined, not just what was found. */
export function describeOutcomes<F>(outcomes: readonly CheckOutcome<F>[]): string {
  const width = Math.max(...outcomes.map((o) => o.check.length), 0);
  return outcomes
    .map((o) => {
      const name = o.check.padEnd(width);
      if (o.state === "clean") return `${name}  clean`;
      if (o.state === "findings") return `${name}  ${o.findings.length} finding(s)`;
      return `${name}  not applicable: ${o.because}`;
    })
    .join("\n");
}

export function allFindings<F>(outcomes: readonly CheckOutcome<F>[]): readonly F[] {
  return outcomes.flatMap((o) => (o.state === "findings" ? o.findings : []));
}
