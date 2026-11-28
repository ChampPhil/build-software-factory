import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * The setup skill's structure and its deterministic scripts.
 *
 * The scripts are where setup's correctness can be pinned down: an agent
 * following SKILL.md makes judgements, but preflight either spots a dirty tree
 * or it does not, and the spend estimate either accounts for Actions minutes
 * or it does not.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "skill")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const ROOT = repoRoot();
const SKILL = join(ROOT, "skill");
const SCRIPTS = join(SKILL, "scripts");
const REFS = join(SKILL, "references");

const PHASES = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * `noGh` puts a `gh` on PATH that always fails, so a test can prove a script
 * works with no GitHub credentials — the condition CI actually runs under.
 */
function noGhPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "bsf-no-gh-"));
  const shim = join(dir, "gh");
  writeFileSync(shim, '#!/bin/sh\necho "gh: not logged in" >&2\nexit 1\n', { mode: 0o755 });
  return dir;
}

function node(
  script: string,
  args: string[],
  opts: { cwd?: string; noGh?: boolean } = {},
): { out: string; code: number } {
  const env =
    opts.noGh === true
      ? { ...process.env, PATH: `${noGhPath()}:${process.env["PATH"] ?? ""}` }
      : process.env;
  try {
    const out = execFileSync("node", [join(SCRIPTS, script), ...args], {
      encoding: "utf8", stdio: "pipe", cwd: opts.cwd ?? ROOT, env,
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
}

describe("SKILL.md", () => {
  const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");

  it("has frontmatter with a name and a description that says when to use it", () => {
    const m = /^---\n([\s\S]*?)\n---/.exec(text);
    expect(m).not.toBeNull();
    const fm = m?.[1] ?? "";
    expect(fm).toContain("name: build-software-factory");
    expect(/description: .{40,}/.test(fm)).toBe(true);
  });

  it("covers all seven phases, in order", () => {
    const order = PHASES.map((p) => text.indexOf(`\n## ${p} — `));
    for (const [i, idx] of order.entries()) {
      expect(idx, `phase ${i + 1} is missing`).toBeGreaterThan(-1);
    }
    expect([...order]).toEqual([...order].sort((a, b) => a - b));
  });

  it("points at a reference file for every phase", () => {
    for (const p of PHASES) {
      const refs = readdirSync(REFS).filter((f) => f.startsWith(`phase-${p}-`));
      expect(refs.length, `no reference for phase ${p}`).toBe(1);
      expect(text).toContain(`references/${refs[0]}`);
    }
  });

  it("names the scripts it tells the agent to run", () => {
    for (const s of ["preflight.mjs", "create-app.mjs", "init-data-refs.mjs", "estimate-spend.mjs"]) {
      expect(text, `SKILL.md never mentions ${s}`).toContain(s);
    }
  });

  it("says a private copy that fails is repaired and rerun, never shipped thinner", () => {
    // A factory that cannot verify produces confident unverified PRs, so
    // continuing past a failed private copy is the worst available outcome.
    expect(text).toMatch(/A failed lock-in is\s+repaired and rerun/);
    expect(text).toMatch(/Do not freeze a partial trial/);
    expect(text).toMatch(/Do not\s+ship a private-copy-only pull request/);
  });

  it("tells the agent not to let the sandbox inherit real credentials", () => {
    expect(text).toMatch(/never let it inherit real\s+credentials/i);
  });

  it("says every pipeline switch starts off", () => {
    expect(text).toMatch(/The pipeline switches stay off/);
    expect(text).toMatch(/Leave\s+those switches off/);
  });

  it("lists what the user does, and keeps it short", () => {
    const table = text.slice(text.indexOf("| They do"), text.indexOf("Nothing else is theirs"));
    const rows = table.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    // Doc 05's overview table: six user actions, plus the header.
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});

describe("the phase references", () => {
  for (const p of PHASES) {
    it(`phase ${p} has a reference with a "what to watch for" section`, () => {
      const file = readdirSync(REFS).find((f) => f.startsWith(`phase-${p}-`));
      expect(file).toBeDefined();
      const text = readFileSync(join(REFS, file!), "utf8");
      expect(text.length, `phase ${p} reference is too thin`).toBeGreaterThan(900);
      expect(text).toMatch(/## What to watch for|## The thing that will bite you/);
    });
  }

  it("there is a reference for re-running and repair", () => {
    expect(existsSync(join(REFS, "re-running.md"))).toBe(true);
  });

  it("phase 2's reference spells out the credential hazard concretely", () => {
    const text = readFileSync(join(REFS, "phase-2-sandbox.md"), "utf8");
    expect(text).toMatch(/database URL points at a hosted database/);
    expect(text).toMatch(/The closed environment is a positive list/);
    expect(text).toMatch(/forgotten production value is absent, not inherited/);
  });

  it("phase 5's reference lists what gh aw compile rejects", () => {
    const text = readFileSync(join(REFS, "phase-5-define.md"), "utf8");
    expect(text).toContain("workflow_call");
    expect(text).toContain("allowed-files");
    expect(text).toContain("sandbox.agent.runtime");
  });
});

describe("preflight.mjs", () => {
  it("reports its checks as JSON", () => {
    const { out } = node("preflight.mjs", ["--json", "--skip-docker"]);
    const parsed = JSON.parse(out) as { checks: { id: string }[]; repo: string | null };
    const ids = parsed.checks.map((c) => c.id);
    for (const id of ["git-repo", "clean-tree", "gh-auth", "language", "existing-factory"]) {
      expect(ids, `no ${id} check`).toContain(id);
    }
  }, 30_000); // it shells out to gh, which can be slow on a shared runner

  it("detects the repo from the origin remote", () => {
    const { out } = node("preflight.mjs", ["--json", "--skip-docker"]);
    const parsed = JSON.parse(out) as { repo: string | null };
    expect(parsed.repo).toBe("ChampPhil/build-software-factory");
  });

  it("detects the repo's languages", () => {
    const { out } = node("preflight.mjs", ["--json", "--skip-docker"]);
    const parsed = JSON.parse(out) as { languages: string[] };
    expect(parsed.languages).toContain("typescript");
  });

  it("blocks, with a fix, when the working tree is dirty", () => {
    // This repo's tree is dirty while these tests run, which makes it the
    // honest fixture for the blocking path.
    const { out } = node("preflight.mjs", ["--json", "--skip-docker"]);
    const parsed = JSON.parse(out) as { checks: { id: string; ok: boolean; fix?: string }[] };
    const tree = parsed.checks.find((c) => c.id === "clean-tree");
    expect(tree).toBeDefined();
    if (tree?.ok === false) expect(tree.fix).toBeTruthy();
  });

  it("exits non-zero when something blocks setup", () => {
    const { code, out } = node("preflight.mjs", ["--json", "--skip-docker"]);
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(code === 0).toBe(parsed.ok);
  });

  it("refuses an unknown argument rather than ignoring it", () => {
    expect(node("preflight.mjs", ["--nonsense"]).code).toBe(2);
  });
});

/**
 * Visibility and plan stated on the command line, so the estimate needs no
 * API call and no `gh` login. Without this these tests passed only on a
 * machine signed in to GitHub — they failed the first time CI ran them.
 */
const FIXED_REPO = ["--repo", "ChampPhil/trinsports", "--private", "--plan", "free"];

describe("estimate-spend.mjs", () => {
  it("needs no credentials when told the visibility and plan", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--json"], { noGh: true });
    const r = JSON.parse(out) as { actions_minutes_limit: number | null; activity: { source: string } };
    // A private Free repo is the case where minutes bind before dollars.
    expect(r.actions_minutes_limit).toBe(2000);
    expect(r.activity.source).toContain("unavailable");
  });

  it("calls an unreadable repo unavailable rather than reporting zero activity", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--json"], { noGh: true });
    const r = JSON.parse(out) as { notes: string[] };
    // "0 issues" would read as a quiet repo rather than as no measurement.
    expect(r.notes.join(" ")).toContain("could not be read");
    expect(r.notes.join(" ")).toContain("a floor, not an estimate");
  });


  it("estimates Actions minutes as well as dollars, since minutes usually bind first", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--json"]);
    const r = JSON.parse(out) as {
      model_usd_per_month: number;
      actions_minutes_per_month: number;
      actions_minutes_limit: number | null;
    };
    expect(r.model_usd_per_month).toBeGreaterThan(0);
    expect(r.actions_minutes_per_month).toBeGreaterThan(0);
  });

  it("lowers the nightly gardening cap rather than overrunning the included minutes", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--gardening-prs", "5", "--json"]);
    const r = JSON.parse(out) as {
      actions_minutes_per_month: number;
      actions_minutes_limit: number | null;
      suggested: { gardening_prs_per_run: number };
      notes: string[];
    };
    if (r.actions_minutes_limit !== null && r.actions_minutes_per_month > r.actions_minutes_limit) {
      expect(r.suggested.gardening_prs_per_run).toBeLessThan(5);
      expect(r.notes.join(" ")).toMatch(/over the \d+ this plan includes/);
    }
  });

  it("says so when there is no recent activity, rather than implying the budget is complete", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--json"]);
    const r = JSON.parse(out) as { activity: { issues: number; source: string }; notes: string[] };
    if (r.activity.issues > 0) return;
    const notes = r.notes.join(" ");
    // Two honest readings of zero, and the note has to distinguish them: no
    // issues were filed, or nothing could be measured. Either way the figure
    // must not read as a finished budget.
    expect(notes).toMatch(/will need raising|a floor, not an estimate/);
    if (r.activity.source.startsWith("unavailable")) {
      expect(notes).toContain("could not be read");
    } else {
      expect(notes).toContain("No issues in the window");
    }
  });

  it("suggests shares that add up to 100", () => {
    const { out } = node("estimate-spend.mjs", [...FIXED_REPO, "--json"]);
    const s = (JSON.parse(out) as { suggested: { shares: Record<string, number> } }).suggested.shares;
    expect(s["product_work"]! + s["gardening"]! + s["review_and_benchmarks"]!).toBe(100);
  });
});

describe("init-data-refs.mjs", () => {
  it("dry-runs without touching anything", () => {
    const { out, code } = node("init-data-refs.mjs", ["--repo", "owner/name", "--dry-run"]);
    expect(code).toBe(0);
    expect(out).toContain("refs/factory/data");
    expect(out).toContain("refs/factory/media");
  });

  it("writes a valid empty index and ledger", () => {
    const { out } = node("init-data-refs.mjs", ["--repo", "owner/name", "--dry-run"]);
    const start = out.indexOf("{");
    const doc = JSON.parse(out.slice(start, out.lastIndexOf("}") + 1)) as { schema: string };
    expect(doc.schema).toBe("index/1");
  });

  it("puts the refs outside refs/heads, so they start no workflow", () => {
    const text = readFileSync(join(SCRIPTS, "init-data-refs.mjs"), "utf8");
    expect(text).toContain('"refs/factory/data"');
    expect(text).not.toContain("refs/heads/factory");
  });

  it("creates the commit with no parents, so the records are their own history", () => {
    const text = readFileSync(join(SCRIPTS, "init-data-refs.mjs"), "utf8");
    expect(text).toContain("parents: []");
  });
});

describe("every script", () => {
  const scripts = readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"));

  it("there is at least one for each deterministic part of setup", () => {
    expect(scripts).toContain("preflight.mjs");
    expect(scripts).toContain("create-app.mjs");
    expect(scripts).toContain("init-data-refs.mjs");
    expect(scripts).toContain("estimate-spend.mjs");
  });

  for (const s of readdirSync(SCRIPTS).filter((f) => f.endsWith(".mjs"))) {
    it(`${s} parses, and has a --help`, () => {
      execFileSync("node", ["--check", join(SCRIPTS, s)], { stdio: "pipe" });
      const { out, code } = node(s, ["--help"]);
      expect(code).toBe(0);
      expect(out.length).toBeGreaterThan(80);
    });
  }
});

describe("preflight's prerequisite checks", () => {
  const src = readFileSync(join(ROOT, "skill/scripts/preflight.mjs"), "utf8");

  it("checks Node's version, because the runner needs a current one", () => {
    expect(src).toContain("MIN_NODE_MAJOR");
    expect(src).toMatch(/record\(\s*"node"/);
  });

  it("checks for a browser, because the App flow redirects to localhost", () => {
    // GitHub's manifest flow sends the private key to a localhost redirect, so
    // a browser on another machine cannot complete it. Finding that out at
    // phase 6 wastes the five phases before it.
    expect(src).toMatch(/record\(\s*"browser"/);
    expect(src).toContain("DISPLAY");
    expect(src).toContain("localhost");
  });

  it("asks nothing of the user's machine beyond git, gh and node", () => {
    // Phase 2 runs on GitHub's runners. A Docker check here blocked setup on
    // every laptop without Docker, for a step that no longer happens locally.
    expect(src).not.toMatch(/checkDocker|"docker"/);
  });
});

describe("the App script does not open a browser", () => {
  const src = readFileSync(join(ROOT, "skill/scripts/create-app.mjs"), "utf8");

  it("prints the link and leaves the tab to the person", () => {
    // Opening the start page from the script and from the chat at once is
    // what produced the extra tab. GitHub answers the second submit with
    // "could not find the manifest."
    expect(src).not.toContain("openBrowser");
    expect(src).not.toContain("xdg-open");
    expect(src).not.toMatch(/spawn\(\s*"cmd"/);
    expect(src).not.toMatch(/spawn\(\s*"open"/);
    expect(src).toContain("This script does not open a tab");
  });
});

describe("mine-corrections --merge-into (the skill's update mode)", () => {
  /** A repo with rule-like prose and a revert, so mining finds something. */
  function repoWithCorrections(): string {
    const dir = mkdtempSync(join(tmpdir(), "bsf-remine-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
    git("init", "--quiet", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(
      join(dir, "CONTRIBUTING.md"),
      [
        "# Contributing",
        "",
        "Always route network calls through the apiClient wrapper rather than calling fetch directly.",
        "",
        "Never store money amounts as floating point numbers; use integer cents everywhere.",
        "",
      ].join("\n"),
    );
    git("add", "-A");
    git("commit", "--quiet", "-m", "Add contributing guide");
    return dir;
  }

  /**
   * Run `bsf mine-corrections` and keep its exit code, which is 2 while a
   * finding still needs a label.
   *
   * args: the flags after `mine-corrections`.
   */
  function mine(args: string[]): { out: string; code: number } {
    try {
      const out = execFileSync("node", [join(SCRIPTS, "../../runner/dist/cli.js"), "mine-corrections", ...args], {
        encoding: "utf8",
        stdio: "pipe",
        // No key: the labels come from the classes file below, never a model.
        env: { ...process.env, ANTHROPIC_API_KEY: "" },
      });
      return { out, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
    }
  }

  it("adds what is new and leaves a rejected candidate rejected", () => {
    const dir = repoWithCorrections();
    const list = join(dir, "candidates.json");
    const classes = join(dir, "classes.json");

    // A sentence in a conventions file is evidence, not a rule, until it has a
    // label. The first pass therefore stops and lists what needs one.
    const unlabelled = mine(["--repo-path", dir, "--merge-into", list]);
    expect(unlabelled.code).toBe(2);
    const report = JSON.parse(readFileSync(join(dir, ".factory/guardrails/mining-report.json"), "utf8")) as {
      classified: boolean;
      pending: { id: string; text: string }[];
    };
    expect(report.classified).toBe(false);
    expect(report.pending.length).toBeGreaterThan(0);
    writeFileSync(
      classes,
      JSON.stringify({
        labels: report.pending.map((p) => ({ id: p.id, kind: "rule", enforcement: "static_rule", quote: p.text })),
      }),
    );

    // Labelled: whatever the repo's own prose yields.
    const labelled = mine(["--repo-path", dir, "--merge-into", list, "--classes", classes]);
    expect(labelled.code).toBe(0);
    const first = labelled.out;
    expect(first).toContain("new");
    const after = JSON.parse(readFileSync(list, "utf8")) as {
      candidates: { problem_class: string; status: string; occurrences: number }[];
    };
    expect(after.candidates.length).toBeGreaterThan(0);

    // Reject one, then re-mine the same repo.
    const rejected = after.candidates[0]!.problem_class;
    writeFileSync(
      list,
      JSON.stringify(
        { schema: "candidates/1", candidates: after.candidates.map((c) => ({ ...c, status: "rejected" })) },
        null,
        2,
      ),
    );
    const remined = mine(["--repo-path", dir, "--merge-into", list, "--classes", classes]);
    expect(remined.code).toBe(0);
    const second = remined.out;

    // The whole point of update mode: nothing the user turned down comes back.
    expect(second).toContain("already decided and not re-offered");
    const final = JSON.parse(readFileSync(list, "utf8")) as {
      candidates: { problem_class: string; status: string }[];
    };
    expect(final.candidates.filter((c) => c.problem_class === rejected)).toHaveLength(1);
    expect(final.candidates.every((c) => c.status === "rejected")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
