#!/usr/bin/env node
/**
 * Estimates what the factory will cost per month on this repo, from the repo's
 * own last 90 days rather than from a generic guess.
 *
 * Three things go into it: product work driven by the repo's real issue and PR
 * rate, nightly gardening while baselines remain, and the scheduled reviews
 * and their benchmarks. Model spend and Actions minutes are estimated
 * separately, because on a private Free-plan repo the minutes run out first
 * and that is the limit that actually bites.
 *
 * Usage:
 *   node estimate-spend.mjs [--repo owner/name] [--days 90]
 *                           [--gardening-prs 5] [--json]
 */

import { execFileSync } from "node:child_process";

/**
 * Per-run costs. Deliberately conservative: an estimate that comes in under
 * what the user is then billed is worse than one that comes in over, because
 * the first is discovered on the invoice.
 */
const COST = {
  // A product run is triage + spec + build + verify, with gate retries.
  product_run_usd: 1.85,
  product_run_minutes: 22,
  // Gardening is one cleanup PR: gardener picks, builder changes, gates run.
  gardening_run_usd: 0.55,
  gardening_run_minutes: 11,
  // A review scores recent runs; benchmarks re-run frozen tasks several times.
  review_usd: 2.4,
  review_minutes: 18,
  benchmark_task_usd: 0.3,
  benchmark_minutes_per_task: 4,
  // What an idle day still costs: the daily review check and the rollup sweep.
  idle_day_minutes: 2,
};

const FREE_PRIVATE_MINUTES = 2000;

function parseArgs(argv) {
  const args = { days: 90, gardeningPrs: 5, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--gardening-prs") args.gardeningPrs = Number(argv[++i]);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else die(`unknown argument ${a}`, 2);
  }
  return args;
}

function die(msg, code = 1) {
  process.stderr.write(`estimate-spend: ${msg}\n`);
  process.exit(code);
}

function run(cmd, cmdArgs, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (allowFail) return null;
    die(`\`${cmd} ${cmdArgs.join(" ")}\` failed:\n${(err.stderr ?? err.message ?? "").toString().trim()}`);
  }
}

function ghJson(path, { allowFail = false } = {}) {
  const out = run("gh", ["api", path], { allowFail });
  if (out === null) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Issues and PRs closed in the window, as a proxy for work the factory would do. */
function countRecentActivity(repo, days) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // The search API counts without paging through every item.
  const issues = ghJson(
    `search/issues?q=${encodeURIComponent(`repo:${repo} is:issue created:>=${since}`)}&per_page=1`,
    { allowFail: true },
  );
  const prs = ghJson(
    `search/issues?q=${encodeURIComponent(`repo:${repo} is:pr created:>=${since}`)}&per_page=1`,
    { allowFail: true },
  );

  if (issues === null && prs === null) {
    // Search is not always available to a scoped token. Fall back to listing.
    const list = ghJson(`repos/${repo}/issues?state=all&since=${since}T00:00:00Z&per_page=100`, {
      allowFail: true,
    });
    const n = Array.isArray(list) ? list.length : 0;
    return { issues: n, prs: 0, source: "issue list (search unavailable)", capped: n >= 100 };
  }

  return {
    issues: issues?.total_count ?? 0,
    prs: prs?.total_count ?? 0,
    source: "search",
    capped: false,
  };
}

function estimate({ activity, days, gardeningPrs, isPrivate, planName }) {
  const perMonth = 30 / days;

  // Not every issue becomes a factory run: some are questions, some are
  // duplicates, some triage closes as out of scope.
  const PRODUCT_SHARE_OF_ISSUES = 0.6;
  const productRuns = Math.round(activity.issues * PRODUCT_SHARE_OF_ISSUES * perMonth);

  // Gardening runs nightly while baselines remain, up to the per-night cap.
  const gardeningRuns = gardeningPrs * 30;

  // A review every 3 days, each with a benchmark comparison of 12 tasks × 3
  // repeats when it proposes a change.
  const reviews = 10;
  const benchmarkTasks = 12 * 3 * 4; // four of the ten reviews propose a change

  const modelUsd =
    productRuns * COST.product_run_usd +
    gardeningRuns * COST.gardening_run_usd +
    reviews * COST.review_usd +
    benchmarkTasks * COST.benchmark_task_usd;

  const minutes =
    productRuns * COST.product_run_minutes +
    gardeningRuns * COST.gardening_run_minutes +
    reviews * COST.review_minutes +
    benchmarkTasks * COST.benchmark_minutes_per_task +
    30 * COST.idle_day_minutes;

  const minutesLimit = isPrivate && (planName === null || planName === "free") ? FREE_PRIVATE_MINUTES : null;

  // Where gardening would push minutes over the limit, lower the nightly cap
  // rather than silently overrunning it.
  let suggestedGardeningPrs = gardeningPrs;
  let minutesNote = null;
  if (minutesLimit !== null && minutes > minutesLimit) {
    const nonGardening = minutes - gardeningRuns * COST.gardening_run_minutes;
    const gardeningShare = minutesLimit * 0.25;
    const affordableRuns = Math.max(0, Math.floor(gardeningShare / COST.gardening_run_minutes));
    suggestedGardeningPrs = Math.max(1, Math.floor(affordableRuns / 30));
    minutesNote =
      `${Math.round(minutes)} minutes is over the ${minutesLimit} this plan includes, so ` +
      `gardening drops from ${gardeningPrs} PRs a night to ${suggestedGardeningPrs}. ` +
      `Non-gardening work alone is about ${Math.round(nonGardening)} minutes.`;
  }

  const budget = Math.max(25, Math.ceil(modelUsd / 25) * 25);

  return {
    window_days: days,
    activity,
    runs_per_month: { product: productRuns, gardening: gardeningRuns, reviews, benchmark_tasks: benchmarkTasks },
    model_usd_per_month: Math.round(modelUsd * 100) / 100,
    actions_minutes_per_month: Math.round(minutes),
    actions_minutes_limit: minutesLimit,
    suggested: {
      monthly_usd: budget,
      gardening_prs_per_run: suggestedGardeningPrs,
      shares: { product_work: 60, gardening: 25, review_and_benchmarks: 15 },
    },
    notes: [
      ...(minutesNote === null ? [] : [minutesNote]),
      ...(activity.capped
        ? ["The activity count hit the listing cap, so the real rate is higher than this."]
        : []),
      ...(activity.issues === 0
        ? [
            "No issues in the window, so product work is estimated at zero. The budget " +
              "below covers gardening and reviews only; it will need raising once people " +
              "start filing work.",
          ]
        : []),
    ],
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`
Estimate the factory's monthly cost from this repo's last 90 days.

  --repo owner/name     Default: the origin remote
  --days N              Window to measure (default 90)
  --gardening-prs N     Cleanup PRs per night (default 5)
  --json                Print JSON
`);
  process.exit(0);
}

const originUrl = run("git", ["remote", "get-url", "origin"], { allowFail: true });
const m = originUrl === null ? null : /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(originUrl);
const repo = args.repo ?? (m === null ? null : `${m[1]}/${m[2]}`);
if (repo === null) die("could not work out the repo; pass --repo owner/name", 2);

const info = ghJson(`repos/${repo}`);
if (info === null) die(`cannot read ${repo}`);

const activity = countRecentActivity(repo, args.days);
const result = estimate({
  activity,
  days: args.days,
  gardeningPrs: args.gardeningPrs,
  isPrivate: info.private === true,
  planName: info.owner?.plan?.name ?? null,
});

if (args.json) {
  process.stdout.write(`${JSON.stringify({ repo, ...result }, null, 2)}\n`);
  process.exit(0);
}

const r = result;
process.stdout.write(`
Estimated monthly cost for ${repo}

  From the last ${r.window_days} days
    issues created            ${r.activity.issues}
    pull requests created     ${r.activity.prs}

  Runs a month
    product work              ${r.runs_per_month.product}
    gardening                 ${r.runs_per_month.gardening}  (${args.gardeningPrs} a night)
    reviews                   ${r.runs_per_month.reviews}
    benchmark tasks           ${r.runs_per_month.benchmark_tasks}

  Model spend                 $${r.model_usd_per_month.toFixed(2)} a month
  Actions minutes             ${r.actions_minutes_per_month}${
    r.actions_minutes_limit === null
      ? "  (public repo: standard runners are free)"
      : ` of ${r.actions_minutes_limit} included`
  }

  Suggested
    monthly budget            $${r.suggested.monthly_usd}
    gardening PRs a night     ${r.suggested.gardening_prs_per_run}
    shares                    product ${r.suggested.shares.product_work}% · gardening ${r.suggested.shares.gardening}% · review ${r.suggested.shares.review_and_benchmarks}%
`);
for (const n of r.notes) process.stdout.write(`\n  Note: ${n}\n`);
process.stdout.write("\nThese are estimates. The dashboard shows real spend from the first run.\n\n");
