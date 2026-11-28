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

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function b64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const SHA = "a".repeat(40);
const SHA59 = "5f3e9c2d1b0a8f7e6d5c4b3a29180f7e6d5c4b3a";
const BOT = { login: "software-factory[bot]", type: "Bot" };
const ME = { login: "maya", type: "User" };

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

/**
 * The words the conversation worked out for the date filter, ranked by how
 * much each changes what gets built. Six here, four shown, as the runner does.
 */
const FRAME_0143 = {
  named: "A date-range filter: narrowing order history, refunds included, to what happened between two dates",
  terms: [
    { term: "Transaction date", means: "The day money moved, as distinct from the day the order was placed", names: "\u201ca refund is part of the order's story\u201d", unlocks: "deciding whether a refund appears under its own date or its order's" },
    { term: "Time zone of record", means: "The zone whose midnight decides which day something happened on", names: "nothing yet. It decides whether an order at 11pm counts as today or tomorrow", unlocks: "dates in the filter that match the dates on the customer's receipts" },
    { term: "Inclusive range", means: "A range that counts both its first and last day", names: "\u201cby date\u201d, which leaves open whether the end day is in", unlocks: "presets like Last 30 days that mean the same thing every time" },
    { term: "Filter state in the URL", means: "The chosen range kept in the page address", names: "nothing yet", unlocks: "a filtered history the customer can bookmark or send to support", prior_art: "most store admin panels, Shopify's among them" },
    { term: "Statement period", means: "A fixed span, usually a month, that a summary covers", names: "what a customer reaching for a month at a time is really after", unlocks: "one-click months as well as free ranges" },
    { term: "Empty state", means: "What a list says when nothing matches", names: "a range with no orders in it", unlocks: "a message that says no orders rather than looking broken" },
  ],
  neighbors: [
    { field: "Bank statements", carries_over: "A date range over a mixed list of payments and refunds, each on the day the money moved", breaks_down: "A statement carries a running balance from one period to the next; order history has no balance to carry", terms: ["posting date", "value date"] },
    { field: "Calendar search", carries_over: "Picking a range of days quickly, with presets for the common ones", breaks_down: "Calendar events have a start and an end; an order happens at one moment" },
  ],
  unmentioned: [
    "Which time zone decides the day an order falls on",
    "Whether the range is kept when the customer comes back",
    "What an empty range should say",
  ],
  readings: [
    { problem: "Narrow the list to a range of dates", term: "date-range filter", tells_it_apart: "the list stays the same, only shorter" },
    { problem: "A downloadable statement for a period", term: "statement", tells_it_apart: "a new document with totals, not a filtered list" },
  ],
  reading_taken: "A filter on the list, because the request is about finding orders, not about a document to keep.",
};

/** The frame turn as the runner writes it into the log: Markdown, ending on the question. */
function frameText(f: typeof FRAME_0143, question: string): string {
  const terms = f.terms.slice(0, 4).map((t) => `- **${t.term}** — ${t.means}.\n  From what you wrote: ${t.names}.\n  Lets you ask for: ${t.unlocks}.`).join("\n");
  const near = f.neighbors.map((n) => `- **${n.field}** — ${n.carries_over}.\n  Where it stops being the same problem: ${n.breaks_down}.`).join("\n");
  return [
    `Before I ask anything else — **${f.named}**`,
    "The four words that change what gets built here:",
    terms,
    "Where this has been solved before, under other names:",
    near,
    "Things you did not mention that will decide something:",
    f.unmentioned.map((u) => `- ${u}.`).join("\n"),
    question,
  ].join("\n\n");
}

/**
 * A small online shop with a factory three weeks old. Every state a request
 * can be in appears once, so every page and every action has something real
 * to show: a question being answered live, a change ready to merge with its
 * proof, one running, one stuck, one from a stranger, one merging itself.
 */
export function sampleFactory(now: number): {
  readonly data: Readonly<Record<string, unknown>>;
  readonly dirs: Readonly<Record<string, readonly string[]>>;
  readonly repoFiles: Readonly<Record<string, unknown>>;
  readonly live: Readonly<Record<string, unknown>>;
  readonly comments: Readonly<Record<string, unknown>>;
  readonly pulls: readonly Record<string, unknown>[];
  readonly issues: readonly Record<string, unknown>[];
} {
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  const dayOf = (n: number): string => new Date(now - n * DAY).toISOString().slice(0, 10);
  const run = (n: number): string => `run-${String(n).padStart(4, "0")}`;

  const daily = Array.from({ length: 21 }, (_, i) => {
    const n = 20 - i;
    return { date: dayOf(n), runs: 1 + ((i * 3) % 4), merged: (i * 2) % 3, spend_usd: Number((0.55 + ((i * 7) % 10) / 9).toFixed(2)), actions_minutes: 40 + ((i * 11) % 30) };
  });

  type Step = { role: string; model: string; attempt?: number; duration_sec: number; cost_usd: number; exit: string; tokens: { in: number; out: number; cached?: number } };
  const step = (role: string, model: string, duration_sec: number, cost_usd: number, exit = "ok", attempt = 1): Step =>
    ({ role, model, attempt, duration_sec, cost_usd, exit, tokens: { in: Math.round(cost_usd * 160_000), out: Math.round(cost_usd * 14_000), cached: Math.round(cost_usd * 90_000) } });
  const product = (builderCost: number, exit = "ok"): Step[] => [
    step("triage", "claude-haiku-5-5", 38, 0.02),
    step("spec", "claude-opus-5-5", 214, 0.71),
    step("builder", "claude-sonnet-5-5", 862, builderCost, exit),
    step("verifier", "claude-sonnet-5-5", 305, 0.33),
  ];
  const runDoc = (id: string, work_item: string, pipeline: string, outcome: string, hoursAgo: number, minutes: number, steps: Step[], extra: Record<string, unknown> = {}) => ({
    schema: "run/1", id, work_item, pipeline,
    actor: { kind: "agent", harness: "claude-code" },
    started_at: at(hoursAgo * HOUR), ended_at: at(hoursAgo * HOUR - minutes * MIN), duration_sec: minutes * 60,
    outcome, steps,
    gates: [
      { gate: "static", attempt: 1, commit: "4c1d9e2", result: "pass", coverage: { diff_pct: 92, total_pct: 86 } },
      { gate: "verification", attempt: 1, commit: "4c1d9e2", result: "pass" },
    ],
    cost_usd: Number(steps.reduce((n, s) => n + s.cost_usd, 0).toFixed(2)),
    ...extra,
  });

  const runs = [
    runDoc(run(31), "wi-0146", "product_work", "draft_pr", 3, 31, product(1.42), { pr: 59, artifacts: { stored: [{ kind: "clip", path: "wi-0146/export.webm", caption: "Exporting March's invoices and opening the file" }] } }),
    runDoc(run(30), "wi-0140", "product_work", "merged", 9, 26, product(1.18), { pr: 57 }),
    runDoc(run(29), "wi-0139", "gardening", "merged", 20, 12, [step("gardener", "claude-sonnet-5-5", 520, 0.41), step("verifier", "claude-haiku-5-5", 140, 0.06)], { pr: 56 }),
    runDoc(run(28), "wi-0147", "product_work", "escalated", 26, 58, [
      ...product(1.05),
      step("builder", "claude-sonnet-5-5", 610, 0.88, "ok", 2),
      step("verifier", "claude-sonnet-5-5", 290, 0.31, "error", 2),
    ], {
      escalated: true,
      gates: [
        { gate: "static", attempt: 1, commit: "9b2e1f0", result: "pass" },
        { gate: "verification", attempt: 1, commit: "9b2e1f0", result: "fail", failures: [{ rule: "session-survives-resume", message: "WebKit signed out after the tab slept for 40 minutes" }] },
        { gate: "static", attempt: 2, commit: "2d7a6c3", result: "pass" },
        { gate: "verification", attempt: 2, commit: "2d7a6c3", result: "fail", failures: [{ rule: "session-survives-resume", message: "Same: the cookie is gone on resume in the sandbox WebKit" }] },
      ],
    }),
    runDoc(run(27), "wi-0138", "hardening", "merged", 44, 19, [step("triage", "claude-haiku-5-5", 30, 0.02), step("hardener", "claude-sonnet-5-5", 700, 0.94), step("verifier", "claude-haiku-5-5", 160, 0.07)], { pr: 55 }),
    runDoc(run(26), "wi-0137", "product_work", "duplicate", 52, 1, [step("triage", "claude-haiku-5-5", 41, 0.02)], { gates: [] }),
    runDoc(run(25), "wi-0136", "gardening", "no_action", 68, 6, [step("gardener", "claude-sonnet-5-5", 330, 0.22)], { gates: [] }),
  ];
  const runDocs = Object.fromEntries(runs.map((r) => [`runs/${r.id}.json`, r]));

  const workItem = (id: string, pipeline: string, title: string, status: string, ageMs: number, extra: Record<string, unknown> = {}): [string, unknown] => [
    `work-items/${id}.json`,
    {
      id, created_at: at(ageMs), pipeline, title, body: null, status, pr: null, parent: null,
      source: { kind: "issue", ref: null, actor: "maya" }, ...extra,
    },
  ];
  const cos = (reason: string, ageMs: number) => ({ routing: { by: "chief_of_staff", reason, at: at(ageMs) } });

  const data: Record<string, unknown> = {
    "env/wait.json": {
      names: [
        { name: "USER", where: "src/config.ts:12", decision: "missing", client: false },
        { name: "CLERK_SECRET_KEY", where: "src/auth.ts:4", decision: "replace", client: false },
        { name: "TMPDIR", where: "src/config.ts:40", decision: "ignore", client: false },
      ],
      dynamic: ["src/load-config.ts"],
      sign_in: ["clerk"],
      queue: [{ workflow: "factory-run.yml", inputs: {} }],
      waiting: 2,
    },
    "index.json": {
      schema: "index/1",
      updated_at: at(4 * MIN),
      factory: { runner: "0.9.2", harness: "claude-code", setup_completed_at: at(21 * DAY) },
      metrics: {
        window_days: 30, runs: 42, merged: 31, escalated: 3, automation_rate: 0.84, revert_rate: 0.032,
        cycle_time_p50_sec: 1860, cycle_time_p90_sec: 5400, human_interactions_per_pr: 0.4,
        spend_usd: 21.4, budget_usd: 35, actions_minutes: 1180, actions_minutes_limit: 2000,
        by_pipeline: {
          product_work: { runs: 24, merged: 17, spend_usd: 15.2, actions_minutes: 760, revert_rate: 0.04 },
          gardening: { runs: 14, merged: 11, spend_usd: 4.1, actions_minutes: 300, revert_rate: 0 },
          hardening: { runs: 4, merged: 3, spend_usd: 2.1, actions_minutes: 120, revert_rate: 0 },
        },
      },
      daily,
      recent_runs: runs.map((r) => r.id),
      guardrails: { rules: 12, baselined: 9, coverage_floor_pct: 78, candidates_pending: 2 },
      health: { gardening_schedule_active: true, last_review: at(2 * DAY), lock_files_current: true, sandbox_profile: "docker", enforcement: "branch_protection" },
    },
    "ledger.json": {
      schema: "ledger/1",
      updated_at: at(MIN),
      open: [
        { work_item: "wi-0143", pipeline: "product_work", status: "needs_info", created_at: at(26 * HOUR), source_ref: "#42" },
        { work_item: "wi-0146", pipeline: "product_work", status: "in_review", created_at: at(5 * HOUR), source_ref: "#45", pr: 59 },
        { work_item: "wi-0145", pipeline: "product_work", status: "running", created_at: at(40 * MIN), source_ref: "#44", priority: "high" },
        { work_item: "wi-0147", pipeline: "product_work", status: "escalated", created_at: at(28 * HOUR), source_ref: "#46" },
        { work_item: "wi-0148", pipeline: "product_work", status: "waiting_trust", created_at: at(7 * HOUR), source_ref: "#47" },
        { work_item: "wi-0149", pipeline: "gardening", status: "queued_to_merge", created_at: at(9 * HOUR), pr: 60 },
        { work_item: "wi-0144", pipeline: "gardening", status: "queued", created_at: at(5 * HOUR) },
      ],
      recent: [
        { work_item: "wi-0140", status: "merged", merged_at: at(6 * HOUR), pr: 57 },
        { work_item: "wi-0139", status: "merged", merged_at: at(19 * HOUR), pr: 56 },
        { work_item: "wi-0138", status: "merged", merged_at: at(42 * HOUR), pr: 55 },
        { work_item: "wi-0137", status: "duplicate" },
        { work_item: "wi-0136", status: "rejected" },
      ],
      merge_queue: [{ pr: 60, eligible_at: at(-2 * HOUR), pipeline: "gardening", work_item: "wi-0149" }],
    },
    "standing-goals.json": {
      schema: "standing-goals/1",
      goals: [{ id: "g-1", text: "Harden checkout this month", lane: "hardening", by: "maya", at: at(4 * DAY), until: null }],
    },
    "brainstorms/wi-0143.json": {
      work_item: "wi-0143",
      turns: [
        { at: at(26 * HOUR - 4 * MIN), who: "factory", text: "When a customer picks a date range, should refunds in that range show too, or only orders?" },
        { at: at(25 * HOUR), who: "person", text: "Both. A refund is part of the order's story." },
        { at: at(25 * HOUR - MIN), who: "factory", text: frameText(FRAME_0143, "Should a refund show under the date it happened, or under the date of the order it refunds?") },
      ],
      understood: null,
      open: ["Which date a refund is filed under"],
      holder: run(33),
      heartbeat_at: at(20_000),
      frame: FRAME_0143,
    },
    "brainstorms/wi-0146.json": {
      work_item: "wi-0146",
      turns: [
        { at: at(5 * HOUR), who: "factory", text: "Should the export keep each amount in the customer's currency, or convert everything to dollars?" },
        { at: at(5 * HOUR - 3 * MIN), who: "person", text: "Keep their currency. Our accountant reconciles per currency." },
      ],
      understood: "Add a CSV export of the invoice list. Each amount stays in the customer's currency, with the exchange rate on the invoice date in its own column.",
      open: [],
      closed_at: at(5 * HOUR - 4 * MIN),
      frame: { named: "A CSV export of invoices that keeps each customer's currency" },
    },
    "reviews/2026-review-0003.json": {
      schema: "review/1",
      id: "review-0003",
      window: { from: at(9 * DAY), to: at(2 * DAY), runs: 18 },
      scores: [
        { run: run(30), criterion: "Tests match the behaviour asked for", score: 4.4 },
        { run: run(30), criterion: "The change stays in scope", score: 4.7 },
        { run: run(29), criterion: "Proof shows the change working", score: 3.9 },
        { run: run(28), criterion: "Asked before guessing", score: 4.2 },
      ],
      problems: [{ title: "Prices rounded differently in cart and receipt", runs: [run(28), run(30)], route: "hardening", work_item: "wi-0138", pr: 55 }],
      unrouted: [{ run: run(28), tag: "verification", reason: "Safari-only bugs can't be checked in the sandbox.", detail: "The sandbox WebKit is not Safari." }],
    },
    "guardrails/candidate-decisions.json": { schema: "decisions/1", decisions: {} },
    ...runDocs,
    ...Object.fromEntries([
      workItem("wi-0143", "product_work", "Let customers filter order history by date", "needs_info", 26 * HOUR, {
        source: { kind: "issue", ref: "#42", actor: "maya" },
        goal: "A customer can narrow order history to a date range", success_check: "Pick last 30 days and only those orders show",
        ...cos("A new capability on an existing page.", 26 * HOUR),
      }),
      workItem("wi-0146", "product_work", "Export invoices to CSV", "in_review", 5 * HOUR, {
        source: { kind: "issue", ref: "#45", actor: "maya" }, pr: 59,
        goal: "The accountant can reconcile a month without retyping", success_check: "March exports to a file that opens in a spreadsheet",
        ...cos("A new feature with a visible result.", 5 * HOUR),
      }),
      workItem("wi-0145", "product_work", "Add a dark mode toggle", "running", 40 * MIN, {
        source: { kind: "dashboard", ref: "#44", actor: "maya" }, routing: { by: "person", reason: "Started from the dashboard.", at: at(40 * MIN) },
      }),
      workItem("wi-0147", "product_work", "Keep shoppers signed in after Safari sleeps", "escalated", 28 * HOUR, {
        source: { kind: "issue", ref: "#46", actor: "devon" }, ...cos("A bug report about sign-in.", 28 * HOUR),
      }),
      workItem("wi-0148", "product_work", "Add Apple Pay at checkout", "waiting_trust", 7 * HOUR, {
        source: { kind: "issue", ref: "#47", actor: "kai-ext" },
      }),
      workItem("wi-0149", "gardening", "Rename cartTotal to subtotal everywhere", "queued_to_merge", 9 * HOUR, {
        source: { kind: "gardener", ref: null, actor: "factory" }, pr: 60,
      }),
      workItem("wi-0144", "gardening", "Remove unused helpers in the cart module", "queued", 5 * HOUR, {
        source: { kind: "schedule", ref: null, actor: "factory" },
      }),
      workItem("wi-0140", "product_work", "Show the order total on the receipt", "merged", 30 * HOUR, { source: { kind: "issue", ref: "#41", actor: "maya" }, pr: 57 }),
      workItem("wi-0139", "gardening", "Split the 600-line checkout component", "merged", 22 * HOUR, { source: { kind: "schedule", ref: null, actor: "factory" }, pr: 56 }),
      workItem("wi-0138", "hardening", "A lint rule for rounding money outside the helper", "merged", 46 * HOUR, { source: { kind: "review", ref: null, actor: "factory" }, pr: 55 }),
      workItem("wi-0137", "product_work", "Filter orders by date", "duplicate", 52 * HOUR, { source: { kind: "issue", ref: "#43", actor: "devon" }, parent: "wi-0143" }),
      workItem("wi-0136", "gardening", "Tidy the search module", "rejected", 68 * HOUR, { source: { kind: "schedule", ref: null, actor: "factory" } }),
    ]),
  };

  const comments: Record<string, unknown> = {
    "42": [
      { id: 1, body: "When a customer picks a date range, should refunds in that range show too, or only orders?", created_at: at(26 * HOUR - 4 * MIN), user: BOT },
      { id: 2, body: "Both. A refund is part of the order's story.", created_at: at(25 * HOUR), user: ME },
      { id: 3, body: "Should a refund show under the date it happened, or under the date of the order it refunds?", created_at: at(25 * HOUR - MIN), user: BOT },
    ],
    "46": [
      { id: 4, body: "Shoppers on Safari are signed out after the laptop sleeps.", created_at: at(28 * HOUR), user: { login: "devon", type: "User" } },
      { id: 5, body: "I tried twice and stopped. In the sandbox, WebKit drops the session cookie when a sleeping tab wakes, on both attempts, though Chrome and Firefox keep it. I can't tell whether real Safari does the same. Should I change the cookie to SameSite=None, or is this something to check on a real device first?", created_at: at(25 * HOUR), user: BOT },
    ],
    "47": [{ id: 6, body: "Could you add Apple Pay? I'd buy more often.", created_at: at(7 * HOUR), user: { login: "kai-ext", type: "User" } }],
    "59": [
      { id: 7, body: "Opened with the recording of March's export. Both gates passed.", created_at: at(3 * HOUR), user: BOT },
    ],
  };

  const dirs: Record<string, readonly string[]> = {
    reviews: ["2026-review-0003.json"],
    runs: runs.map((r) => `${r.id}.json`),
  };

  const repoFiles: Record<string, unknown> = {
    ".factory/guardrails/baselines.json": {
      schema: "baselines/1",
      rules: {
        "money/no-raw-rounding": { count: 3, recorded_at: at(2 * DAY), native: "eslint" },
        "no-console-log": { count: 4, recorded_at: at(20 * DAY), native: "eslint" },
        "no-any": { count: 11, recorded_at: at(20 * DAY), by_file: { "src/cart.ts": 6, "src/search.ts": 5 }, native: "typescript-eslint" },
        "no-floating-promises": { count: 0, recorded_at: at(20 * DAY), retired: true, native: "typescript-eslint" },
      },
    },
    ".factory/guardrails/coverage.json": { schema: "coverage/1", high_pct: 86, floor_pct: 78, tolerance_pts: 1, diff_min_pct: 80, skips: { count: 2, cap: 10 } },
    ".factory/guardrails/candidates.json": {
      schema: "candidates/1",
      candidates: [
        {
          id: "cand-1", problem_class: "Dates shown in UTC instead of the shopper's time zone", occurrences: 3, first_seen: at(12 * DAY), last_seen: at(2 * DAY),
          sources: [{ kind: "pr_comment", quote: "This shows tomorrow's date for anyone west of London.", pr: 52 }],
          proposed_fix: "static_rule", status: "pending",
        },
        {
          id: "cand-2", problem_class: "Tests that pass even with the feature removed", occurrences: 2, first_seen: at(10 * DAY), last_seen: at(6 * DAY),
          sources: [{ kind: "pr_comment", quote: "This test passes even if I delete the feature.", pr: 50 }],
          proposed_fix: "verification", status: "pending",
        },
        {
          id: "cand-0", problem_class: "Money rounded outside the helper", occurrences: 4, sources: [{ kind: "pr_comment", quote: "This rounds down here but up in the receipt.", pr: 48 }],
          proposed_fix: "static_rule", status: "installed",
        },
      ],
    },
  };

  const live: Record<string, unknown> = {
    [`refs/factory/live/${run(32)}`]: {
      schema: "live/1", run: run(32), work_item: "wi-0145", pipeline: "product_work", step: "builder",
      attempt: 2, of: 3, started_at: at(18 * MIN), cost_usd_so_far: 1.12,
    },
  };

  const labels = (...names: string[]) => names.map((name) => ({ name }));
  const pull = (number: number, title: string, ageMs: number, ref: string, draft: boolean, names: string[], sha = SHA) => ({
    number, title, draft, html_url: `https://github.com/${DEMO_REPO}/pull/${number}`, created_at: at(ageMs), updated_at: at(ageMs / 2),
    user: BOT, labels: labels(...names), head: { ref, sha },
  });
  const pulls = [
    pull(59, "Export invoices to CSV", 3 * HOUR, "factory/wi-0146", false, ["factory:product-work", "factory:cleared"], SHA59),
    pull(60, "Rename cartTotal to subtotal everywhere", 8 * HOUR, "factory/wi-0149", false, ["factory:gardening", "factory:cleared"]),
    pull(61, "Practice: round money only through formatMoney()", 20 * HOUR, "factory/practice-money", false, ["factory:definition"]),
  ];
  const issue = (number: number, title: string, ageMs: number, login: string, association: string, names: string[] = []) => ({
    number, title, html_url: `https://github.com/${DEMO_REPO}/issues/${number}`, created_at: at(ageMs), user: { login }, labels: labels(...names), author_association: association,
  });
  const issues = [
    issue(48, "Gift cards", 2 * HOUR, "pat-q", "NONE"),
    issue(47, "[Feature] Add Apple Pay at checkout", 7 * HOUR, "kai-ext", "NONE"),
    issue(46, "[Bug] Signed out after Safari sleeps", 28 * HOUR, "devon", "COLLABORATOR", ["factory:escalated"]),
    issue(45, "[Feature] Export invoices to CSV", 5 * HOUR, "maya", "OWNER"),
    issue(44, "[Feature] Add a dark mode toggle", 40 * MIN, "maya", "OWNER"),
    issue(42, "[Feature] Filter order history by date", 26 * HOUR, "maya", "OWNER", ["factory:needs-info"]),
  ];

  return { data, dirs, repoFiles, live, comments, pulls, issues };
}

/** The pull request the demo shows in full: what the factory writes, and the change it made. */
function pullDetail(now: number, number: number, base: Record<string, unknown>): Record<string, unknown> {
  const bodies: Record<number, string> = {
    59: [
      "Adds **Export to CSV** to the invoice list. Each amount stays in the customer's currency.",
      "- A new column carries the exchange rate on the invoice date, so totals reconcile.",
      "- Rates are fetched once per invoice date and cached for the export.",
      "- Exports of more than 5,000 invoices stream instead of building in memory.",
      "",
      "## Proof",
      "A recording of March's 212 invoices exporting and opening in a spreadsheet.",
    ].join("\n"),
    60: "Renames `cartTotal` to `subtotal` in 14 files, which is what the receipt and the API already call it.\n\nNo behaviour changes; both gates passed.",
    61: "A standing instruction declared with `/practice` on #48's review:\n\n- Round money only through `formatMoney()`, never with `toFixed` or `Math.round`.\n\nEvery agent follows it once a trusted person merges this.",
  };
  return {
    ...base,
    body: bodies[number] ?? "",
    state: "open", merged: false, merged_at: null, mergeable: true, mergeable_state: "clean",
    additions: number === 59 ? 184 : 41, deletions: number === 59 ? 12 : 41, changed_files: number === 59 ? 4 : 14,
    base: { ref: "main" },
    created_at: base["created_at"] ?? new Date(now).toISOString(),
  };
}

const PATCH_59 = `@@ -1,9 +1,18 @@
 import { Invoice } from "./types";
+import { rateOn } from "../money/rates";
+import { formatMoney } from "../money/format";
 
-export function invoiceRows(invoices: Invoice[]) {
-  return invoices.map((i) => [i.number, i.customer, i.total]);
+export async function invoiceRows(invoices: Invoice[]) {
+  const rows = [["Number", "Customer", "Amount", "Currency", "Rate to USD", "Date"]];
+  for (const i of invoices) {
+    const rate = await rateOn(i.currency, i.issuedOn);
+    rows.push([i.number, i.customer, formatMoney(i.total, i.currency), i.currency, rate.toFixed(6), i.issuedOn]);
+  }
+  return rows;
 }`;

function pullFiles(number: number): unknown[] {
  if (number === 59) {
    return [
      { filename: "src/invoices/export.ts", status: "modified", additions: 12, deletions: 3, changes: 15, patch: PATCH_59 },
      { filename: "src/invoices/ExportButton.tsx", status: "added", additions: 64, deletions: 0, changes: 64, patch: "@@ -0,0 +1,6 @@\n+export function ExportButton({ month }: { month: string }) {\n+  return (\n+    <a className=\"btn\" href={`/api/invoices/${month}.csv`} download>\n+      Export to CSV\n+    </a>\n+  );" },
      { filename: "src/money/rates.ts", status: "modified", additions: 38, deletions: 9, changes: 47, patch: "@@ -12,4 +12,9 @@ export async function rateOn(currency: string, day: string) {\n-  return fetchRate(currency, day);\n+  const key = `${currency}:${day}`;\n+  const hit = cache.get(key);\n+  if (hit !== undefined) return hit;\n+  const rate = await fetchRate(currency, day);\n+  cache.set(key, rate);\n+  return rate;" },
      { filename: "test/invoices/export.test.ts", status: "added", additions: 70, deletions: 0, changes: 70, patch: "@@ -0,0 +1,5 @@\n+it(\"keeps each amount in its own currency\", async () => {\n+  const rows = await invoiceRows([euroInvoice]);\n+  expect(rows[1]).toContain(\"EUR\");\n+  expect(rows[1]![2]).toBe(\"€120.00\");\n+});" },
    ];
  }
  return [{ filename: "src/cart/total.ts", status: "modified", additions: 3, deletions: 3, changes: 6, patch: "@@ -4,6 +4,6 @@\n-export function cartTotal(items: Item[]) {\n+export function subtotal(items: Item[]) {\n   return items.reduce((n, i) => n + i.price * i.qty, 0);\n }" }];
}

function checkRuns(): unknown {
  return {
    total_count: 4,
    check_runs: [
      { id: 1, name: "factory/static", status: "completed", conclusion: "success", output: { title: "Types, lint and 12 guardrails pass" } },
      { id: 2, name: "factory/verification", status: "completed", conclusion: "success", output: { title: "Driven in the sandbox; recording attached" } },
      { id: 3, name: "factory/policy", status: "completed", conclusion: "success", output: { title: "No protected files touched" } },
      { id: 4, name: "ci / test", status: "completed", conclusion: "success", output: { title: "418 tests passed" } },
    ],
  };
}

const WORKFLOWS = ["audit", "budget-settle", "conflicts", "drop", "garden", "gates", "intake", "merge", "policy", "recompile", "review", "rollup", "run", "sync"];
function workflows(): unknown {
  return {
    total_count: WORKFLOWS.length,
    workflows: WORKFLOWS.map((w, i) => ({ id: 100 + i, name: `factory-${w}`, path: `.github/workflows/factory-${w}.yml`, state: "active" })),
  };
}
function workflowRuns(now: number): unknown {
  const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
  const r = (id: number, w: string, conclusion: string | null, ago: number, status = "completed") => ({
    id, name: `factory-${w}`, path: `.github/workflows/factory-${w}.yml`, workflow_id: 100 + WORKFLOWS.indexOf(w), status, conclusion,
    created_at: at(ago), updated_at: at(ago - MIN), html_url: `https://github.com/${DEMO_REPO}/actions/runs/${id}`, event: "workflow_dispatch",
  });
  return {
    total_count: 12,
    workflow_runs: [
      r(9012, "run", null, 18 * MIN, "in_progress"),
      r(9011, "gates", "success", 3 * HOUR),
      r(9010, "policy", "success", 3 * HOUR),
      r(9009, "sync", "failure", 4 * HOUR),
      r(9008, "merge", "success", 6 * HOUR),
      r(9007, "garden", "success", 18 * HOUR),
      r(9006, "intake", "success", 26 * HOUR),
      r(9005, "review", "success", 2 * DAY),
      r(9004, "rollup", "success", 2 * DAY),
      r(9003, "audit", "success", 3 * DAY),
      r(9002, "conflicts", "success", 3 * DAY),
      r(9001, "recompile", "success", 9 * DAY),
    ],
  };
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
    if (rest === "pulls") return json(url.searchParams.get("state") === "closed" ? [] : sample.pulls);
    const pullMatch = /^pulls\/(\d+)(\/files|\/comments)?$/.exec(rest);
    if (pullMatch !== null) {
      const n = Number(pullMatch[1]);
      const base = sample.pulls.find((p) => p["number"] === n);
      if (base === undefined) return notFound();
      if (pullMatch[2] === "/files") return json(pullFiles(n));
      if (pullMatch[2] === "/comments") return json([]);
      return json(pullDetail(t, n, base));
    }
    if (/^commits\/[^/]+\/check-runs$/.test(rest)) return json(checkRuns());
    if (rest === "actions/workflows") return json(workflows());
    if (rest === "actions/runs") return json(workflowRuns(t));
    if (rest === "issues") return json(url.searchParams.get("state") === "closed" ? [] : sample.issues);
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
