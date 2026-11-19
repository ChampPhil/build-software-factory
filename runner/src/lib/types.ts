/** Shared types for the shapes defined in /schema. Doc 09 is the source of truth. */

export type Harness = "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";
export type Pipeline = "product_work" | "gardening" | "hardening" | "definition" | "conflict";
export type Role = "triage" | "spec" | "builder" | "verifier" | "gardener" | "hardener" | "scorer";
export type TriggerClass = "request" | "dev_event" | "signal" | "scheduled" | "self";
export type Association = "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "FIRST_TIME_CONTRIBUTOR" | "NONE";

export type ChangeKind = "code" | "tests" | "guardrails:tighten" | "guardrails" | "definition";

export interface Policy {
  readonly schema: "policy/1";
  readonly trust: {
    readonly associations: readonly Association[];
    readonly accept_label: string;
    readonly harden_label?: string;
    readonly require_write_access?: boolean;
    readonly integration_bots?: readonly string[];
  };
  readonly paths: {
    readonly definition: readonly string[];
    readonly guardrails: readonly string[];
    readonly tests: readonly string[];
    readonly protected: readonly string[];
    readonly baselines?: readonly string[];
    readonly coverage?: readonly string[];
  };
  readonly pipelines: Readonly<Record<string, { readonly may_change: readonly ChangeKind[]; readonly requires?: "trusted_human_approval" }>>;
  readonly tests: { readonly declared_edits: "required" | "off" };
  readonly runner_upgrades?: {
    readonly author?: string;
    readonly may_change?: "runner_pin";
    readonly requires?: "trusted_human_approval";
  };
  readonly weakening: {
    readonly requires: "trusted_human_approval";
    readonly detects: readonly WeakeningKind[];
  };
  readonly protected_files?: {
    readonly policy: "request-review" | "blocked" | "fallback-to-issue" | "allowed";
    readonly exclude: Readonly<Record<string, readonly string[]>>;
  };
}

export type WeakeningKind =
  | "rule_removed" | "rule_loosened" | "baseline_raised" | "native_suppressions_added"
  | "unpruned_suppressions_allowed" | "coverage_floor_lowered" | "skip_without_reason";

export interface Baselines {
  readonly schema: "baselines/1";
  readonly rules: Readonly<Record<string, BaselineRule>>;
}

export interface BaselineRule {
  readonly count: number;
  readonly recorded_at?: string;
  readonly retired?: boolean;
  readonly native?: string;
  readonly by_file?: Readonly<Record<string, number>>;
}

export interface Coverage {
  readonly schema: "coverage/1";
  readonly high_pct: number;
  readonly floor_pct: number;
  readonly tolerance_pts: number;
  readonly diff_min_pct: number;
  readonly skips: { readonly count: number; readonly cap: number };
}

/** A review on a PR, as the policy check sees it. */
export interface Review {
  readonly author: string;
  readonly author_association: Association;
  readonly state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  readonly submitted_at: string;
  readonly commit_sha?: string;
  /** True when the author is a GitHub App (the factory's own, or the recompiler's). */
  readonly is_app?: boolean;
}

/** The pull request facts the policy check reads. It never checks out PR code. */
export interface PullRequestFacts {
  readonly number: number;
  readonly head_sha: string;
  readonly base_ref: string;
  readonly author: string;
  readonly author_association: Association;
  readonly from_fork: boolean;
  readonly labels: readonly string[];
  readonly changed_files: readonly string[];
  /** Files this PR adds. New test files are always allowed; editing an existing one must be declared. */
  readonly added_files?: readonly string[];
  readonly reviews: readonly Review[];
  readonly draft: boolean;
  /** Set for factory PRs; absent on human PRs. */
  readonly pipeline?: Pipeline;
  /** The work item's spec, for the declared-test-edit check. */
  readonly declared_test_edits?: readonly string[];
}
