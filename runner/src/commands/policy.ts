import type { Association, ChangeKind, Policy, PullRequestFacts, Review } from "../lib/types.js";
import { matchesAny, filesMatching } from "../lib/paths.js";

/**
 * `bsf policy` — the `factory/policy` check.
 *
 * It runs on `pull_request_target`, so GitHub always uses main's copy of the
 * workflow and this code, and it loads `policy.yaml` from main. It never
 * checks out or runs the PR's code: it reads only the changed-file list,
 * reviews and labels (doc 07). That is what stops a PR, a fork's above all,
 * from rewriting the gates that judge it.
 */

export type PolicyFailureKind =
  | "protected_path"
  | "definition_without_approval"
  | "path_not_allowed_for_pipeline"
  | "undeclared_test_edit"
  | "guardrail_change_not_allowed"
  | "runner_upgrade_scope"
  | "fork_agent_work";

export interface PolicyFailure {
  readonly kind: PolicyFailureKind;
  readonly files: readonly string[];
  readonly message: string;
}

export type PolicyResult =
  | { readonly conclusion: "success"; readonly notes: readonly string[] }
  | { readonly conclusion: "failure"; readonly failures: readonly PolicyFailure[]; readonly notes: readonly string[] };

export interface PolicyContext {
  readonly policy: Policy;
  readonly pr: PullRequestFacts;
  /** Logins that are the factory's or recompiler's App, whose reviews never count as approval. */
  readonly appLogins?: readonly string[];
}

/** Trust belongs to people, never integrations (doc 02). */
export function isTrustedActor(
  policy: Policy,
  actor: string,
  association: Association,
  opts: { readonly isBot?: boolean } = {},
): boolean {
  const bots = policy.trust.integration_bots ?? [];
  if (opts.isBot === true) return false;
  if (bots.includes(actor)) return false;
  // A bot login is never trusted, however its association reads.
  if (/\[bot\]$/.test(actor)) return false;
  return policy.trust.associations.includes(association);
}

/**
 * An approval from a trusted human. Approvals from the factory App never
 * count (doc 06), and an approval is only current for the commit it was
 * submitted on, so a later push re-opens the question.
 */
export function hasTrustedHumanApproval(ctx: PolicyContext): boolean {
  return ctx.pr.reviews.some((r) => approves(ctx, r));
}

function approves(ctx: PolicyContext, r: Review): boolean {
  if (r.state !== "APPROVED") return false;
  if (r.is_app === true) return false;
  if ((ctx.appLogins ?? []).includes(r.author)) return false;
  if (/\[bot\]$/.test(r.author)) return false;
  if (!ctx.policy.trust.associations.includes(r.author_association)) return false;
  // An approval on an older commit does not carry to new code.
  if (r.commit_sha !== undefined && r.commit_sha !== ctx.pr.head_sha) return false;
  return true;
}

/**
 * A REQUEST_CHANGES review authored by one of the Apps is gh-aw's
 * protected-file check speaking, not a human objecting (spike §6). The merge
 * queue treats it as a gate signal; it is reported here as a note so a
 * reviewer can see why the PR is held.
 */
export function appRequestedChanges(ctx: PolicyContext): readonly Review[] {
  return ctx.pr.reviews.filter(
    (r) =>
      r.state === "CHANGES_REQUESTED" &&
      (r.is_app === true || (ctx.appLogins ?? []).includes(r.author)),
  );
}

function allowed(may: readonly ChangeKind[], kind: ChangeKind): boolean {
  if (may.includes(kind)) return true;
  if (kind === "guardrails" && may.includes("guardrails:tighten")) return true;
  return false;
}

/** Files a PR may always change, in any pipeline: lowering counts, raising the floor. */
function isOneWayGuardrailFile(policy: Policy, file: string): boolean {
  const baselines = policy.paths.baselines ?? [".factory/guardrails/baselines.json"];
  const coverage = policy.paths.coverage ?? [".factory/guardrails/coverage.json"];
  return matchesAny(file, baselines) || matchesAny(file, coverage);
}

export function runPolicy(ctx: PolicyContext): PolicyResult {
  const { policy, pr } = ctx;
  const failures: PolicyFailure[] = [];
  const notes: string[] = [];

  const approvedByHuman = hasTrustedHumanApproval(ctx);

  const appChanges = appRequestedChanges(ctx);
  if (appChanges.length > 0) {
    notes.push(
      "An App requested changes on this PR. That is gh-aw's protected-file check, not a human objection: " +
        "either this pipeline's protected-files.exclude is wrong, or the attempt touched a path it may not.",
    );
  }

  // Runner upgrade PRs (Dependabot): may change only the pinned SHA, and never
  // merge without a trusted human, whatever the auto-merge toggles say.
  const upgrade = policy.runner_upgrades;
  if (upgrade?.author !== undefined && pr.author === upgrade.author) {
    const workflowFiles = filesMatching(pr.changed_files, policy.paths.protected);
    const nonWorkflow = pr.changed_files.filter((f) => !matchesAny(f, policy.paths.protected));
    if (nonWorkflow.length > 0) {
      failures.push({
        kind: "runner_upgrade_scope",
        files: nonWorkflow,
        message:
          `A runner upgrade PR may change only the runner pin in workflow files; ` +
          `these are outside that scope: ${nonWorkflow.join(", ")}`,
      });
    }
    if (!approvedByHuman) {
      failures.push({
        kind: "definition_without_approval",
        files: workflowFiles,
        message: "A runner upgrade needs a trusted human's approval and is never auto-merged.",
      });
    }
    return failures.length > 0
      ? { conclusion: "failure", failures, notes }
      : { conclusion: "success", notes };
  }

  // Protected paths: workflows and dependabot config. The factory never changes
  // these; a human's own push may, with approval.
  const protectedHits = filesMatching(pr.changed_files, policy.paths.protected);
  if (protectedHits.length > 0 && !approvedByHuman) {
    failures.push({
      kind: "protected_path",
      files: protectedHits,
      message:
        `This PR changes protected paths, which needs a trusted human's approval: ${protectedHits.join(", ")}. ` +
        `The check that judges this runs from main's copy of the workflow, so editing it in the PR changes nothing.`,
    });
  }

  // Definition paths: only a PR a trusted human approved may change them.
  const definitionHits = filesMatching(pr.changed_files, policy.paths.definition);
  if (definitionHits.length > 0) {
    const rule = policy.pipelines["definition"];
    // A PR from no pipeline (a person's, or the factory's own setup) may
    // change the definition with a trusted human's approval, like the
    // definition pipeline. A pipeline that may not change it never may.
    const pipelineMayChangeDefinition =
      pr.pipeline === undefined || allowed(policy.pipelines[pr.pipeline]?.may_change ?? [], "definition");
    if (!pipelineMayChangeDefinition) {
      failures.push({
        kind: "path_not_allowed_for_pipeline",
        files: definitionHits,
        message:
          `The ${pr.pipeline ?? "unknown"} pipeline may not change the factory definition: ` +
          `${definitionHits.join(", ")}`,
      });
    } else if (rule?.requires === "trusted_human_approval" && !approvedByHuman) {
      failures.push({
        kind: "definition_without_approval",
        files: definitionHits,
        message: `Changes to the factory definition need a trusted human's approval: ${definitionHits.join(", ")}`,
      });
    }
  }

  // Per-pipeline path rules, for factory PRs.
  if (pr.pipeline !== undefined) {
    if (pr.from_fork) {
      failures.push({
        kind: "fork_agent_work",
        files: [],
        message: "Agent work never starts from a fork.",
      });
    }
    const may = policy.pipelines[pr.pipeline]?.may_change ?? [];
    const guardrailHits = filesMatching(pr.changed_files, policy.paths.guardrails).filter(
      (f) => !isOneWayGuardrailFile(policy, f) && !matchesAny(f, policy.paths.definition),
    );
    if (guardrailHits.length > 0 && !allowed(may, "guardrails")) {
      failures.push({
        kind: "guardrail_change_not_allowed",
        files: guardrailHits,
        message:
          `The ${pr.pipeline} pipeline may not change guardrails: ${guardrailHits.join(", ")}. ` +
          `Only hardening may add or tighten them, and any weakening still needs a human.`,
      });
    }

    const testHits = filesMatching(pr.changed_files, policy.paths.tests);
    if (!allowed(may, "tests") && testHits.length > 0) {
      failures.push({
        kind: "path_not_allowed_for_pipeline",
        files: testHits,
        message: `The ${pr.pipeline} pipeline may not change tests: ${testHits.join(", ")}`,
      });
    }

    const codeHits = pr.changed_files.filter(
      (f) =>
        !matchesAny(f, policy.paths.tests) &&
        !matchesAny(f, policy.paths.guardrails) &&
        !matchesAny(f, policy.paths.definition) &&
        !matchesAny(f, policy.paths.protected),
    );
    if (codeHits.length > 0 && !allowed(may, "code")) {
      failures.push({
        kind: "path_not_allowed_for_pipeline",
        files: codeHits,
        message: `The ${pr.pipeline} pipeline may not change code: ${codeHits.join(", ")}`,
      });
    }
  }

  // Declared test edits. New test files are always allowed; modifying or
  // deleting an existing one must be listed in the spec's tests_changed.
  if (policy.tests.declared_edits === "required" && pr.pipeline !== undefined) {
    const norm = (f: string): string => f.replace(/^\.\//, "");
    const declared = new Set((pr.declared_test_edits ?? []).map(norm));
    const added = new Set((pr.added_files ?? []).map(norm));
    const existingTestEdits = filesMatching(pr.changed_files, policy.paths.tests).filter(
      (f) => !added.has(norm(f)) && !declared.has(norm(f)),
    );
    if (existingTestEdits.length > 0) {
      failures.push({
        kind: "undeclared_test_edit",
        files: existingTestEdits,
        message:
          `These existing test files are not listed in the spec's tests_changed: ${existingTestEdits.join(", ")}. ` +
          `New test files are always allowed; editing or deleting an existing one must be declared.`,
      });
    }
  }

  return failures.length > 0
    ? { conclusion: "failure", failures, notes }
    : { conclusion: "success", notes };
}
