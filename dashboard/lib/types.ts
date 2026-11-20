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
