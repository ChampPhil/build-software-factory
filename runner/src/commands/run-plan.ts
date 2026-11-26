import type { Pipeline } from "../lib/types.js";

/**
 * `bsf run plan` and `bsf run after-gates` — which roles run, in what order,
 * and what happens when a gate fails (doc 06).
 *
 * `factory-run` is a deterministic workflow: it calls each role as a
 * `workflow_call` job sequenced with `needs:`. A GitHub workflow cannot decide
 * at runtime which jobs exist, so the jobs are all declared and each one's
 * `if:` reads this plan. That keeps the sequence in one tested place instead
 * of spread across eleven YAML conditions.
 */

export type Role = "triage" | "spec" | "builder" | "verifier" | "gardener" | "hardener" | "scorer";

/** The role sequence per pipeline. */
const SEQUENCE: Readonly<Record<Pipeline, readonly Role[]>> = {
  product_work: ["triage", "spec", "builder", "verifier"],
  // The gardener picks the work once a night, in factory-garden; each item it
  // files is then built and verified like any other.
  gardening: ["builder", "verifier"],
  hardening: ["hardener", "spec", "builder", "verifier"],
  // A conflict is a rebase and a re-clear: no new intent to triage or spec.
  conflict: ["builder", "verifier"],
  // A definition change comes from a /practice comment; the builder writes the
  // change itself, and a trusted human approves the PR.
  definition: ["builder"],
  // Never dispatched: a person decides what a problem with the factory needs.
  factory_health: [],
};

export interface PlanInput {
  readonly pipeline: Pipeline;
  readonly attempt: number;
  readonly maxAttempts?: number;
  /** Set when this attempt follows a gate failure. */
  readonly lastFailure?: { readonly gate: "static" | "verification"; readonly summary: string };
  /** A revision asked for by a human on the PR. */
  readonly revision?: boolean;
}

export interface Plan {
  readonly roles: readonly Role[];
  readonly skipped: readonly Role[];
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly escalate: boolean;
  readonly reason: string;
}

export function planRun(input: PlanInput): Plan {
  const maxAttempts = input.maxAttempts ?? 3;
  const full = SEQUENCE[input.pipeline];

  if (input.attempt > maxAttempts) {
    return {
      roles: [],
      skipped: full,
      attempt: input.attempt,
      maxAttempts,
      escalate: true,
      reason: `attempt ${input.attempt} is past the cap of ${maxAttempts}: escalate to a human rather than spend another run`,
    };
  }

  // A later attempt does not re-triage or re-spec: the intent has not changed,
  // only the code. Re-running them would spend two models to reach the same
  // plan, and worse, might reach a different one mid-flight.
  if (input.attempt > 1 || input.revision === true) {
    const roles: readonly Role[] = full.filter((r) => r === "builder" || r === "verifier");
    return {
      roles,
      skipped: full.filter((r) => !roles.includes(r)),
      attempt: input.attempt,
      maxAttempts,
      escalate: false,
      reason:
        input.revision === true
          ? "a revision changes the code, not the intent: the builder applies it and the verifier re-checks"
          : `attempt ${input.attempt} after a ${input.lastFailure?.gate ?? "gate"} failure: the builder fixes and the verifier re-checks`,
    };
  }

  return {
    roles: full,
    skipped: [],
    attempt: input.attempt,
    maxAttempts,
    escalate: false,
    reason: `first attempt at a ${input.pipeline} run`,
  };
}

/* --------------------------------------------------------------- after gates */

export interface AfterGatesInput {
  readonly staticGate: "passed" | "failed" | "skipped";
  readonly verificationGate: "passed" | "failed" | "skipped" | "not_run";
  readonly attempt: number;
  readonly maxAttempts?: number;
  readonly failureSummary?: string;
}

export type AfterGates =
  | { readonly next: "verify"; readonly reason: string }
  | { readonly next: "retry"; readonly attempt: number; readonly reason: string }
  | { readonly next: "escalate"; readonly reason: string }
  | { readonly next: "clear"; readonly reason: string };

/**
 * Both gates pass → cleared. Either fails → back to the builder, up to the
 * cap, then a human. The cap is per work item, not per gate, so a run cannot
 * get six attempts by failing each gate three times.
 */
export function afterGates(input: AfterGatesInput): AfterGates {
  const max = input.maxAttempts ?? 3;

  if (input.staticGate === "failed" || input.verificationGate === "failed") {
    const which = input.staticGate === "failed" ? "static" : "verification";
    if (input.attempt >= max) {
      return {
        next: "escalate",
        reason: `the ${which} gate failed on attempt ${input.attempt} of ${max}: a human takes it from here`,
      };
    }
    return {
      next: "retry",
      attempt: input.attempt + 1,
      reason: `the ${which} gate failed${input.failureSummary === undefined ? "" : `: ${input.failureSummary}`}`,
    };
  }

  if (input.staticGate === "passed" && input.verificationGate === "not_run") {
    return { next: "verify", reason: "static gate passed; verification has not run yet" };
  }

  // A skipped gate is one that was already decided for this commit, which is
  // a pass that is not being paid for twice — not an unknown.
  const staticOk = input.staticGate === "passed" || input.staticGate === "skipped";
  const verifyOk = input.verificationGate === "passed" || input.verificationGate === "skipped";
  if (staticOk && verifyOk) {
    return { next: "clear", reason: "both gates are satisfied on this commit" };
  }

  return {
    next: "verify",
    reason: `static ${input.staticGate}, verification ${input.verificationGate}: run what is outstanding`,
  };
}

export { SEQUENCE as ROLE_SEQUENCE };
