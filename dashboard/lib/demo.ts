/**
 * Demo mode: a made-up factory, so the dashboard can be tried before anything
 * is installed.
 *
 * It is a stand-in for GitHub's API, handed to the same client every page
 * already uses. So the pages run their real code on sample records, and nothing
 * here knows about any page. It reads nothing from the network and writes
 * nothing anywhere: every write is refused with a plain sentence.
 *
 * The sign-in the demo uses is a sentinel, not a credential: it is never sent
 * to GitHub, because the client given this fetch cannot reach GitHub.
 */

export const DEMO_TOKEN = "demo-mode-no-token";
export const DEMO_REPO = "demo/storefront";

export function isDemo(token: string | null | undefined, repo?: string | null): boolean {
  return token === DEMO_TOKEN && (repo === undefined || repo === null || repo === DEMO_REPO);
}

export const DEMO_REFUSAL = "This is the demo, so nothing is saved. Connect a repository to do this for real.";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const SHA = "a".repeat(40);

const SAMPLE_SETTINGS = `schema: factory/1
harness: claude-code
pipelines:
  product_work:
    auto_merge: false
  gardening:
    auto_merge: true
    schedule: "0 6 * * *"
    max_prs_per_run: 2
  hardening:
    auto_merge: false
budget:
  monthly_usd: 35
  shares:
    product_work: 60
    gardening: 25
    review_and_benchmarks: 15
`;

/** The sample records, dated relative to `now` so "3 days ago" stays true. */
export function sampleFactory(now: number): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly dirs: Readonly<Record<string, readonly string[]>>;
  readonly repoFiles: Readonly<Record<string, unknown>>;
  readonly live: Readonly<Record<string, unknown>>;
  readonly comments: Readonly<Record<string, unknown>>;
} {
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  const day = (n: number): string => new Date(now - n * DAY).toISOString().slice(0, 10);
  const run = (n: number): string => `run-${String(n).padStart(4, "0")}`;

  const daily = Array.from({ length: 14 }, (_, i) => {
    const n = 13 - i;
    return { date: day(n), runs: 2 + ((i * 3) % 4), merged: 1 + ((i * 2) % 3), spend_usd: Number((0.9 + ((i * 7) % 10) / 10).toFixed(2)), actions_minutes: 40 + ((i * 11) % 30) };
  });

  const runIds = [run(31), run(30), run(29), run(28), run(27)];
  const runDocs = Object.fromEntries(
    runIds.map((id, i) => {
      const pipeline = i === 2 ? "gardening" : i === 4 ? "hardening" : "product_work";
      return [
        `runs/${id}.json`,
        {
          schema: "run/1",
          id,
          work_item: `wi-${String(140 - i).padStart(4, "0")}`,
          pipeline,
          actor: { kind: "agent", harness: "claude-code" },
          started_at: at((i + 1) * 9 * HOUR),
          ended_at: at((i + 1) * 9 * HOUR - 24 * 60_000),
          duration_sec: 1440,
          outcome: i === 3 ? "escalated" : "merged",
          pr: 50 + (4 - i),
          steps: [
            { role: "triage", model: "claude-haiku-5-5", duration_sec: 40, cost_usd: 0.02, exit: "ok" },
            { role: "spec", model: "claude-opus-5-5", duration_sec: 210, cost_usd: 0.74, exit: "ok" },
            { role: "builder", model: "claude-sonnet-5-5", attempt: 1, duration_sec: 820, cost_usd: 1.31, exit: "ok" },
            { role: "verifier", model: "claude-haiku-5-5", duration_sec: 310, cost_usd: 0.18, exit: "ok" },
          ],
          gates: [
            { gate: "static", attempt: 1, result: i === 3 ? "fail" : "pass", coverage: { diff_pct: 91, total_pct: 84 } },
            { gate: "verification", attempt: 1, result: i === 3 ? "skipped" : "pass" },
          ],
          cost_usd: 2.25,
          ...(i === 3 ? { escalated: true } : {}),
        },
      ];
    }),
  );

  const workItem = (id: string, pipeline: string, title: string, status: string, extra: Record<string, unknown> = {}): [string, unknown] => [
    `work-items/${id}.json`,
    {
      id, created_at: at(2 * DAY), pipeline, title, body: null, status, pr: null, parent: null,
      source: { kind: "issue", ref: null, actor: "maya" }, ...extra,
    },
  ];

  const data: Record<string, unknown> = {
    "index.json": {
      schema: "index/1",
      updated_at: at(5 * 60_000),
      factory: { runner: "0.1.0", harness: "claude-code", setup_completed_at: at(21 * DAY) },
      metrics: {
        window_days: 30, runs: 42, merged: 31, escalated: 3, automation_rate: 0.88, revert_rate: 0.03,
        cycle_time_p50_sec: 1860, cycle_time_p90_sec: 5400, human_interactions_per_pr: 0.4,
        spend_usd: 21.4, budget_usd: 35, actions_minutes: 1180, actions_minutes_limit: 2000,
        by_pipeline: {
          product_work: { runs: 24, merged: 17, spend_usd: 15.2 },
          gardening: { runs: 14, merged: 11, spend_usd: 4.1 },
          hardening: { runs: 4, merged: 3, spend_usd: 2.1 },
        },
      },
      daily,
      recent_runs: runIds,
      guardrails: { rules: 12, baselined: 9, coverage_floor_pct: 78, candidates_pending: 2 },
      health: { gardening_schedule_active: true, last_review: at(2 * DAY), lock_files_current: true, sandbox_profile: "none", enforcement: "branch_protection" },
    },
    "ledger.json": {
      schema: "ledger/1",
      updated_at: at(60_000),
      open: [
        { work_item: "wi-0143", pipeline: "product_work", status: "needs_info", created_at: at(3 * DAY), source_ref: "#42" },
        { work_item: "wi-0145", pipeline: "product_work", status: "building", created_at: at(40 * 60_000), source_ref: "#44", priority: "high" },
        { work_item: "wi-0144", pipeline: "gardening", status: "queued", created_at: at(5 * HOUR) },
      ],
      recent: [
        { work_item: "wi-0140", status: "merged", merged_at: at(6 * HOUR), pr: 57 },
        { work_item: "wi-0139", status: "merged", merged_at: at(1 * DAY), pr: 56 },
        { work_item: "wi-0138", status: "merged", merged_at: at(2 * DAY), pr: 55 },
        { work_item: "wi-0137", status: "escalated", pr: 54 },
      ],
      merge_queue: [{ pr: 57, eligible_at: at(-2 * HOUR), pipeline: "product_work", work_item: "wi-0140" }],
    },
    "standing-goals.json": {
      schema: "standing-goals/1",
      goals: [{ id: "g-1", text: "Focus hardening on checkout this month", lane: "hardening", by: "maya", at: at(4 * DAY), until: null }],
    },
    "reviews/2026-review-0003.json": {
      schema: "review/1",
      id: "review-0003",
      window: { from: at(5 * DAY), to: at(2 * DAY), runs: 18 },
      scores: [{ run: run(30), criterion: "tests_match_behaviour", score: 4, note: "Covers the new path and one edge." }],
      problems: [{ title: "Price rounding differs between cart and receipt", runs: [run(28)], route: "hardening", work_item: "wi-0142" }],
    },
    ...runDocs,
    ...Object.fromEntries([
      workItem("wi-0143", "product_work", "Let customers filter order history by date", "needs_info", {
        goal: "A customer can narrow order history to a date range", success_check: "Open orders, pick last 30 days, only those orders show",
        routing: { by: "chief_of_staff", reason: "A new capability on an existing page.", at: at(3 * DAY) },
      }),
      workItem("wi-0145", "product_work", "Add a dark mode toggle", "building", {
        routing: { by: "person", reason: "Started from the dashboard.", at: at(40 * 60_000) },
      }),
      workItem("wi-0144", "gardening", "Remove unused helpers in the cart module", "queued"),
    ]),
  };

  const comments: Record<string, unknown> = {};
  comments["42"] = [
    { id: 1, body: "Should the date range also apply to refunds, or only to orders?", created_at: at(3 * DAY), user: { login: "software-factory[bot]", type: "Bot" } },
  ];

  const dirs: Record<string, readonly string[]> = {
    reviews: ["2026-review-0003.json"],
    runs: runIds.map((id) => `${id}.json`),
  };

  const repoFiles: Record<string, unknown> = {
    ".factory/guardrails/baselines.json": {
      schema: "baselines/1",
      rules: {
        "no-console-log": { count: 4, recorded_at: at(20 * DAY) },
        "no-any": { count: 11, recorded_at: at(20 * DAY), by_file: { "src/cart.ts": 6, "src/search.ts": 5 } },
      },
    },
    ".factory/guardrails/coverage.json": { schema: "coverage/1", high_pct: 86, floor_pct: 78, tolerance_pts: 1, diff_min_pct: 80, skips: { count: 2, cap: 10 } },
    ".factory/guardrails/candidates.json": {
      schema: "candidates/1",
      candidates: [
        {
          id: "cand-1", problem_class: "Prices rounded differently in two places", occurrences: 3, last_seen: at(2 * DAY),
          sources: [{ kind: "pr_comment", quote: "This rounds down here but up in the receipt.", pr: 55 }],
          proposed_fix: "static_rule", status: "pending",
        },
        {
          id: "cand-2", problem_class: "Tests that never fail", occurrences: 2, last_seen: at(6 * DAY),
          sources: [{ kind: "pr_comment", quote: "This test passes even if I delete the feature.", pr: 52 }],
          proposed_fix: "verification", status: "pending",
        },
      ],
    },
  };

  const live: Record<string, unknown> = {
    [`refs/factory/live/${run(32)}`]: {
      schema: "live/1", run: run(32), work_item: "wi-0145", pipeline: "product_work", step: "builder",
      attempt: 1, of: 3, started_at: at(18 * 60_000), cost_usd_so_far: 0.64,
    },
  };

  return { data, dirs, repoFiles, live, comments };
}

function pulls(now: number): unknown[] {
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return [
    {
      number: 58, title: "Add a dark mode toggle", draft: true, html_url: "#", created_at: at(30 * 60_000), updated_at: at(10 * 60_000),
      user: { login: "software-factory[bot]" }, labels: [{ name: "factory:product" }], head: { ref: "factory/wi-0145", sha: SHA },
    },
    {
      number: 57, title: "Show the order total on the receipt", draft: false, html_url: "#", created_at: at(7 * HOUR), updated_at: at(6 * HOUR),
      user: { login: "software-factory[bot]" }, labels: [{ name: "factory:product" }, { name: "factory:cleared" }], head: { ref: "factory/wi-0140", sha: SHA },
    },
  ];
}

function issues(now: number): unknown[] {
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  return [
    { number: 44, title: "[Feature] Add a dark mode toggle", html_url: "#", created_at: at(40 * 60_000), user: { login: "maya" }, labels: [], author_association: "OWNER" },
    { number: 42, title: "[Feature] Filter order history by date", html_url: "#", created_at: at(3 * DAY), user: { login: "maya" }, labels: [{ name: "factory:needs-info" }], author_association: "OWNER" },
  ];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notFound = (): Response => json({ message: "Not Found" }, 404);

/** A fetch that answers as GitHub would for the sample factory, and refuses every write. */
export function demoFetch(now: () => number = Date.now): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") throw new Error(DEMO_REFUSAL);

    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.origin !== "https://api.github.com") return notFound();
    const prefix = `/repos/${DEMO_REPO}`;
    if (!url.pathname.startsWith(prefix)) return notFound();
    const rest = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\//, "");
    const t = now();
    const sample = sampleFactory(t);

    if (rest === "") {
      return json({ default_branch: "main", private: true, permissions: { push: true, admin: true, pull: true } });
    }
    if (rest === "pulls") return json(pulls(t));
    if (rest === "issues") return json(issues(t));
    const comment = /^issues\/(\d+)\/comments$/.exec(rest);
    if (comment !== null) return json(sample.comments[comment[1]!] ?? []);
    if (rest === "collaborators") {
      return json([
        { login: "maya", role_name: "admin", permissions: { admin: true, push: true } },
        { login: "devon", role_name: "write", permissions: { admin: false, push: true } },
      ]);
    }
    if (rest === "git/matching-refs/factory/live") {
      return json(Object.keys(sample.live).map((ref) => ({ ref, object: { sha: SHA } })));
    }

    if (rest.startsWith("contents")) {
      const path = rest.replace(/^contents\/?/, "");
      const ref = url.searchParams.get("ref");
      if (ref !== null && ref.startsWith("refs/factory/live/")) {
        const doc = sample.live[ref];
        return doc === undefined || path !== "status.json" ? notFound() : json({ content: b64(JSON.stringify(doc)), encoding: "base64", sha: SHA });
      }
      if (ref === "refs/factory/data") {
        const names = sample.dirs[path];
        if (names !== undefined) return json(names.map((name) => ({ name, type: "file" })));
        const doc = sample.data[path];
        if (doc !== undefined) return json({ content: b64(JSON.stringify(doc)), encoding: "base64", sha: SHA });
        return notFound();
      }
      if (ref === null) {
        if (path === ".factory/definition/factory.yaml") return json({ content: b64(SAMPLE_SETTINGS), encoding: "base64", sha: SHA });
        const doc = sample.repoFiles[path];
        if (doc !== undefined) return json({ content: b64(JSON.stringify(doc)), encoding: "base64", sha: SHA });
      }
      return notFound();
    }
    return notFound();
  };
}
