#!/usr/bin/env node
/**
 * Creates the factory's data and media refs.
 *
 * They live at `refs/factory/data` and `refs/factory/media`, deliberately
 * outside `refs/heads/`. That is not cosmetic: a push to a non-branch ref
 * fires no `push` workflow, so the factory writing its own records never
 * starts the repo's CI. It also keeps them out of every branch listing.
 *
 * Usage:
 *   node init-data-refs.mjs [--repo owner/name] [--data-repo owner/name]
 *                           [--dry-run]
 */

import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i];
    else if (a === "--data-repo") args.dataRepo = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else die(`unknown argument ${a}`, 2);
  }
  return args;
}

function die(msg, code = 1) {
  process.stderr.write(`init-data-refs: ${msg}\n`);
  process.exit(code);
}

function run(cmd, cmdArgs, opts = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
  } catch (err) {
    if (opts.allowFail === true) return null;
    const detail = (err.stderr ?? err.message ?? "").toString().trim();
    die(`\`${cmd} ${cmdArgs.join(" ")}\` failed:\n${detail}`);
  }
}

const DATA_REF = "refs/factory/data";
const MEDIA_REF = "refs/factory/media";

function emptyIndex(repo, now) {
  return {
    schema: "index/1",
    updated_at: now,
    factory: { runner: "v0.1.0", harness: "claude-code", setup_completed_at: now },
    metrics: { window_days: 30, runs: 0, merged: 0, escalated: 0, by_pipeline: {} },
    daily: [],
    recent_runs: [],
    guardrails: { rules: 0, baselined: 0, coverage_floor_pct: 0, candidates_pending: 0 },
    health: { gardening_schedule_active: true, lock_files_current: true },
    _repo: repo,
  };
}

function emptyLedger(now) {
  return { schema: "ledger/1", updated_at: now, open: [], recent: [], merge_queue: [] };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`
Create the factory's data and media refs, with an empty index and ledger.

  --repo owner/name       The factory's repo (default: the origin remote)
  --data-repo owner/name  Put the data in this private repo instead
  --dry-run               Print what would happen; change nothing
`);
  process.exit(0);
}

const originUrl = run("git", ["remote", "get-url", "origin"], { allowFail: true });
const detected = originUrl === null ? null : /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/.exec(originUrl);
const repo = args.repo ?? (detected === null ? null : `${detected[1]}/${detected[2]}`);
if (repo === null) die("could not work out the repo; pass --repo owner/name", 2);

const target = args.dataRepo ?? repo;
const now = new Date().toISOString();

if (args.dryRun) {
  process.stdout.write(`\nWould create in ${target}:\n`);
  process.stdout.write(`  ${DATA_REF}   with index.json and ledger.json\n`);
  process.stdout.write(`  ${MEDIA_REF}  empty\n\n`);
  process.stdout.write("index.json:\n");
  process.stdout.write(`${JSON.stringify(emptyIndex(repo, now), null, 2)}\n\n`);
  process.exit(0);
}

/**
 * Creates each ref through GitHub's Git Data API: blobs, then a tree, then a
 * parentless commit, then the ref.
 *
 * No clone and no push. That is deliberate rather than incidental: it needs
 * only API access, works where a push to a non-branch ref is refused (some
 * proxies and some rulesets allow `refs/heads/*` and nothing else), and avoids
 * writing a throwaway clone to disk at all.
 */

function ghJson(method, path, body) {
  const cmdArgs = ["api", "-X", method, path, "--input", "-"];
  try {
    const out = execFileSync("gh", cmdArgs, {
      encoding: "utf8",
      input: JSON.stringify(body),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (err) {
    const detail = (err.stderr ?? err.stdout ?? err.message ?? "").toString().trim();
    if (/403/.test(detail) && /proxy|not permitted/i.test(detail)) {
      die(
        `${method} ${path} was refused with 403.\n${detail}\n\n` +
          `Something between you and GitHub is blocking writes to the git data API.\n` +
          `Some corporate proxies and some rulesets allow refs/heads/* and nothing\n` +
          `else. Create the refs from an unrestricted network, or ask an admin to\n` +
          `allow git/blobs, git/trees, git/commits and git/refs for this repo.`,
      );
    }
    if (/403/.test(detail)) {
      die(
        `${method} ${path} was refused with 403.\n${detail}\n\n` +
          `The token needs write access to this repo's git data.`,
      );
    }
    die(`${method} ${path} failed:\n${detail}`);
  }
}

function createBlob(repo, content) {
  const res = ghJson("POST", `repos/${repo}/git/blobs`, {
    content: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64",
  });
  return res.sha;
}

function createRef(repo, ref, files, message) {
  const tree = Object.entries(files).map(([path, content]) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: createBlob(repo, content),
  }));

  const treeRes = ghJson("POST", `repos/${repo}/git/trees`, { tree });
  // No parents: the factory's records are their own history, with no
  // connection to the code's, so they never appear in a log of main.
  const commit = ghJson("POST", `repos/${repo}/git/commits`, {
    message,
    tree: treeRes.sha,
    parents: [],
  });
  ghJson("POST", `repos/${repo}/git/refs`, { ref, sha: commit.sha });
  return commit.sha;
}

const existing = run("gh", ["api", `repos/${target}/git/${DATA_REF}`], { allowFail: true });
if (existing !== null) {
  process.stdout.write(`\n${DATA_REF} already exists in ${target}; leaving it alone.\n`);
  process.stdout.write("Re-running setup does not reset the factory's own records.\n\n");
  process.exit(0);
}

const dataSha = createRef(
  target,
  DATA_REF,
  {
    "index.json": `${JSON.stringify(emptyIndex(repo, now), null, 2)}\n`,
    "ledger.json": `${JSON.stringify(emptyLedger(now), null, 2)}\n`,
    "runs/.gitkeep": "",
    "work-items/.gitkeep": "",
    "README.md": [
      "# factory-data",
      "",
      "The factory's own records: run files, work items, and the rollups the",
      "dashboard reads. Written by the factory, not by hand.",
      "",
      "This ref sits outside `refs/heads/` on purpose. A push to a non-branch",
      "ref starts no `push` workflow, so the factory recording itself never",
      "triggers this repo's CI.",
      "",
    ].join("\n"),
  },
  "factory: initialise the data ref",
);
process.stdout.write(`\n✓ ${DATA_REF} created in ${target} (${dataSha.slice(0, 7)})\n`);

// The media ref starts with only a README, but has to exist, so the first
// stored screenshot is an ordinary update rather than a ref creation.
const mediaExists = run("gh", ["api", `repos/${target}/git/${MEDIA_REF}`], { allowFail: true });
if (mediaExists === null) {
  const mediaSha = createRef(
    target,
    MEDIA_REF,
    {
      "README.md": [
        "# factory-media",
        "",
        "Screenshots and clips a verifier agent captured, kept because a",
        "reviewer needs to see them after the workflow artifacts expire.",
        "",
      ].join("\n"),
    },
    "factory: initialise the media ref",
  );
  process.stdout.write(`✓ ${MEDIA_REF} created in ${target} (${mediaSha.slice(0, 7)})\n`);
} else {
  process.stdout.write(`${MEDIA_REF} already exists; leaving it alone.\n`);
}

process.stdout.write("\nNeither ref appears in your branch list, and neither starts a workflow.\n");
process.stdout.write(`Read them with: gh api repos/${target}/contents/index.json?ref=${DATA_REF}\n\n`);
