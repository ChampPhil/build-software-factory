/** The shapes the dashboard reads, matching /schema. */

export type Pipeline = "product_work" | "gardening" | "hardening" | "definition" | "conflict";
export type Harness = "claude-code" | "cursor-cli" | "kilo-code" | "pi" | "hermes-agent";

export interface IndexFile {
  readonly schema: string;
  readonly updated_at: string;
  readonly factory: {
    readonly runner: string;
    readonly harness: Harness;
    readonly setup_completed_at?: string;
  };
  readonly metrics: {
    readonly window_days: number;
    readonly runs: number;
    readonly merged?: number;
    readonly escalated?: number;
    readonly automation_rate?: number;
    readonly revert_rate?: number;
    readonly cycle_time_p50_sec?: number;
    readonly cycle_time_p90_sec?: number;
    /** Null means no merged PR in the window recorded a count — not zero. */
    readonly human_interactions_per_pr?: number | null;
    readonly spend_usd?: number;
    readonly budget_usd?: number;
    readonly actions_minutes?: number;
    readonly actions_minutes_limit?: number | null;
    readonly by_pipeline?: Readonly<Record<string, PipelineMetrics>>;
  };
  readonly daily?: readonly DailyPoint[];
  readonly recent_runs?: readonly string[];
  readonly guardrails?: {
    readonly rules?: number;
    readonly baselined?: number;
    readonly coverage_floor_pct?: number;
    readonly candidates_pending?: number;
  };
  readonly health?: {
    readonly gardening_schedule_active?: boolean;
    readonly last_review?: string;
    readonly lock_files_current?: boolean;
    readonly sandbox_profile?: string;
    readonly enforcement?: "branch_protection" | "audit";
  };
}

export interface PipelineMetrics {
  readonly runs?: number;
  readonly merged?: number;
  readonly spend_usd?: number;
  readonly actions_minutes?: number;
  readonly revert_rate?: number;
  readonly paused?: boolean;
}

export interface DailyPoint {
  readonly date: string;
  readonly runs?: number;
  readonly merged?: number;
  readonly spend_usd?: number;
  readonly actions_minutes?: number;
}

export interface LedgerFile {
  readonly schema: string;
  readonly updated_at: string;
  readonly open: readonly LedgerOpenItem[];
  readonly recent: readonly LedgerRecentItem[];
  readonly merge_queue: readonly MergeQueueItem[];
}

export interface LedgerOpenItem {
  readonly work_item: string;
  readonly pipeline: Pipeline;
  readonly status: string;
  readonly fingerprint?: string;
  readonly pr?: number | null;
  readonly priority?: "high" | "normal";
  readonly created_at?: string;
  /** The issue or PR it came from, as `#N`. */
  readonly source_ref?: string | null;
  readonly fixes?: readonly string[];
}

export interface LedgerRecentItem {
  readonly work_item: string;
  readonly status: string;
  readonly merged_at?: string;
  readonly pr?: number | null;
}

export interface MergeQueueItem {
  readonly pr: number;
  readonly eligible_at: string;
  readonly pipeline?: Pipeline;
  readonly work_item?: string;
}

export interface LiveFile {
  readonly schema: string;
  readonly run: string;
  readonly work_item: string;
  readonly pipeline: Pipeline;
  readonly step: "triage" | "spec" | "builder" | "verifier" | "gardener" | "hardener" | "scorer" | "gate" | "merge";
  readonly gate?: "static" | "verification" | null;
  readonly attempt?: number;
  readonly of?: number;
  readonly started_at: string;
  readonly cost_usd_so_far?: number;
}

export interface RunFile {
  readonly schema: string;
  readonly id: string;
  readonly work_item: string;
  readonly pipeline: Pipeline;
  readonly actor: { readonly kind: "agent" | "human"; readonly harness?: Harness; readonly login?: string };
  readonly started_at: string;
  readonly ended_at: string;
  readonly duration_sec?: number;
  readonly outcome: string;
  readonly pr?: number | null;
  readonly steps: readonly RunStep[];
  readonly gates: readonly RunGate[];
  readonly artifacts?: {
    readonly stored?: readonly { readonly kind: string; readonly path: string; readonly caption?: string; readonly expires_at?: string }[];
    readonly expiring?: readonly { readonly kind: string; readonly artifact_id: number; readonly expires_at?: string }[];
  };
  readonly cost_usd: number;
  readonly escalated?: boolean;
}

export interface RunStep {
  readonly role: string;
  readonly model?: string;
  readonly attempt?: number;
  readonly duration_sec?: number;
  readonly tokens?: { readonly in: number; readonly out: number; readonly cached?: number };
  readonly cost_usd?: number;
  readonly transcript?: string | null;
  readonly exit?: "ok" | "error" | "timeout" | "refused";
}

export interface RunGate {
  readonly gate: "static" | "verification";
  readonly attempt: number;
  readonly commit?: string;
  readonly result: "pass" | "fail" | "skipped";
  readonly failures?: readonly { readonly rule: string; readonly file?: string; readonly line?: number; readonly message?: string }[];
  readonly coverage?: { readonly diff_pct?: number; readonly total_pct?: number };
}

export interface BaselinesFile {
  readonly schema: string;
  readonly rules: Readonly<Record<string, {
    readonly count: number;
    readonly recorded_at?: string;
    readonly retired?: boolean;
    readonly native?: string;
    readonly by_file?: Readonly<Record<string, number>>;
  }>>;
}

export interface CoverageFile {
  readonly schema: string;
  readonly high_pct: number;
  readonly floor_pct: number;
  readonly tolerance_pts: number;
  readonly diff_min_pct: number;
  readonly skips: { readonly count: number; readonly cap: number };
}

export interface CandidatesFile {
  readonly schema: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly problem_class: string;
    readonly occurrences: number;
    readonly first_seen?: string;
    readonly last_seen?: string;
    readonly sources: readonly { readonly kind: string; readonly quote?: string; readonly pr?: number; readonly commit?: string }[];
    readonly proposed_fix: "api_change" | "static_rule" | "verification" | "context";
    readonly status: "pending" | "accepted" | "rejected" | "installed";
    readonly critical_logic?: boolean;
  }[];
}

/** A scheduled review, as the runner writes it. */
export interface ReviewFile {
  readonly schema: "review/1";
  readonly id: string;
  readonly window: { readonly from: string; readonly to: string; readonly runs: number };
  readonly scores: readonly {
    readonly run: string;
    readonly criterion: string;
    readonly score: number;
    readonly tags?: readonly string[];
    readonly note?: string;
  }[];
  readonly problems: readonly {
    readonly title: string;
    readonly runs: readonly string[];
    readonly route: "hardening";
    readonly work_item?: string;
    readonly change?: string;
    readonly pr?: number;
  }[];
  /** Failures the review saw but did not file work for: found in a hardening run. */
  readonly unrouted?: readonly {
    readonly run: string;
    readonly tag: string;
    readonly reason: string;
    readonly detail?: string;
  }[];
}

/** A role's report as the runner stores it: which files it kept, and where. */
export interface StoredRoleReport {
  readonly role: string;
  readonly attempt: number;
  readonly media_prefix: string;
  readonly report: {
    readonly blocks?: readonly (
      | { readonly type: "file"; readonly file: string; readonly caption: string; readonly poster?: string }
      | { readonly type: string }
    )[];
  };
  readonly videos?: readonly { readonly file: string; readonly seconds: number | null; readonly bytes: number }[];
}

/** What people decided about candidates on the dashboard, kept on the data ref. */
export interface DecisionsFile {
  readonly schema: string;
  readonly decisions: Readonly<Record<string, { readonly status: "accepted" | "rejected"; readonly by: string; readonly at: string }>>;
}

/** The part of a work item the corrections list reads. */
export interface WorkItemDoc {
  readonly id: string;
  readonly created_at: string;
  readonly pipeline: Pipeline;
  readonly title: string;
  readonly body: string | null;
  readonly status: string;
  readonly pr: number | null;
  readonly parent: string | null;
  readonly source: { readonly kind: string; readonly ref: string | null; readonly actor: string };
  readonly goal?: string;
  readonly success_check?: string;
  readonly routing?: RoutingDoc;
}

/** Who chose a request's pipeline, and why. */
export interface RoutingDoc {
  readonly by: "chief_of_staff" | "table" | "person";
  readonly reason: string;
  readonly at: string;
  readonly from?: string;
  readonly pending?: boolean;
  readonly overrides?: readonly { readonly by: string; readonly at: string; readonly from: string; readonly to: string }[];
}

/** The standing goals file on the data ref. */
export interface StandingGoalsFile {
  readonly schema: string;
  readonly goals: readonly { readonly id: string; readonly text: string; readonly lane: string | null; readonly by: string; readonly at: string; readonly until: string | null }[];
}
