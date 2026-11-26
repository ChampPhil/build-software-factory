/** Shared types for the shapes defined in /schema. Doc 09 is the source of truth. */

export type Harness = "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";
/**
 * `factory_health` is not work the factory does: it is a problem with the
 * factory itself (a checker that never started, a gate that never reported),
 * filed for a person and never dispatched (fix 8).
 */
export type Pipeline = "product_work" | "gardening" | "hardening" | "definition" | "conflict" | "factory_health";
export type Role = "triage" | "spec" | "builder" | "verifier" | "gardener" | "hardener" | "scorer";
export type TriggerClass = "request" | "dev_event" | "signal" | "scheduled" | "self";
export type Association = "OWNER" | "MEMBER" | "COLLABORATOR" | "CONTRIBUTOR" | "FIRST_TIME_CONTRIBUTOR" | "NONE";

export type ChangeKind = "code" | "tests" | "guardrails:tighten" | "guardrails" | "definition" | "prose";

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
  readonly sandbox_repairs?: "automatic" | "reviewed";
  /**
   * The repo's own prose: the files its owners write for agents. Absent, the
   * factory resolves the names agents already read (`AGENTS.md` and friends).
   * `targets` adds paths a repo keeps somewhere of its own; it is also the list
   * hardening may write a practice into, and `.factory/` is never eligible.
   */
  readonly prose?: {
    readonly targets?: readonly string[];
    readonly budget_bytes?: number;
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
  /** The PR's description, for the evidence a prose practice has to carry. */
  readonly body?: string | null;
  /** Set for factory PRs; absent on human PRs. */
  readonly pipeline?: Pipeline;
  /** The work item's spec, for the declared-test-edit check. */
  readonly declared_test_edits?: readonly string[];
  /**
   * Set when a PR labelled `factory:settings` changes the factory's settings
   * file: what moved, judged against the list of settings a person may change.
   */
  readonly settings_edit?: {
    readonly changed: readonly string[];
    readonly outside: readonly string[];
    readonly invalid: readonly string[];
    /** The author's association after correcting it from their real permission. */
    readonly author_association: Association;
    readonly author_is_bot: boolean;
    /** Whether the author actually holds write access, read from their permission and not their association. */
    readonly author_has_write: boolean;
    /** True when the garden workflow is untouched, or only its cron line changed. */
    readonly workflow_ok: boolean;
  };
}

/**
 * A guardrail candidate as `candidates.json` holds it — wider than what
 * mining produces, because the shared file also carries candidates from the
 * repository's own history, from reviews and from escalations, and carries
 * the status a human gave them.
 */
export type CandidateSourceKind =
  | "agent_chat"
  | "review_comment"
  | "revert"
  | "fix_commit"
  | "bug"
  | "prose_rule"
  | "escalation"
  | "review_failure";

export interface CandidateSource {
  readonly kind: CandidateSourceKind;
  readonly harness?: Harness;
  readonly session?: string;
  readonly quote?: string;
  readonly pr?: number;
  readonly commit?: string;
  readonly issue?: number;
  readonly path?: string;
  readonly at?: string;
}

export interface Candidate {
  readonly id: string;
  readonly problem_class: string;
  readonly occurrences: number;
  readonly first_seen?: string;
  readonly last_seen?: string;
  readonly sources: readonly CandidateSource[];
  readonly proposed_fix: "api_change" | "static_rule" | "verification" | "context";
  readonly status: "pending" | "accepted" | "rejected" | "installed";
  /**
   * Whether this is about the repository or about the factory itself. Nothing
   * routes on it yet; it is recorded so the question can be asked of history
   * rather than re-mined, and so a person can see which of their guardrails
   * are really factory bugs wearing a local disguise.
   */
  readonly target?: "repo" | "factory";
  readonly installed_as?: string | null;
  readonly critical_logic?: boolean;
  /** Who submitted it with `bsf contribute-corrections`; absent if setup mined it. */
  readonly contributed_by?: string | null;
}

export interface CandidatesFile {
  readonly schema: "candidates/1";
  readonly candidates: readonly Candidate[];
}
