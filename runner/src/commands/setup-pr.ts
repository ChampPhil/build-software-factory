/**
 * setup-pr.ts — the last setup step: put the saved setup on a branch and open the pull request.
 *
 * WHY THIS EXISTS
 *
 * This was one long shell script inside `factory-setup-pr.yml`. It ran
 * under "stop at the first error", so when any command in it failed the job
 * ended with nothing recorded: setup was simply over and nobody was told
 * why. It also could not be tested.
 *
 * It is the same sequence here, as code. Every command it runs is checked,
 * and a failure is recorded with what the command printed.
 *
 * WHAT IT DOES, IN ORDER
 *
 *   1. Reads what the earlier steps saved on the state branch.
 *   2. Refuses a recipe with a password pasted into it.
 *   3. Copies the recipe, the stand-ins, the journey list and the context
 *      files into `.factory/` in the checkout.
 *   4. On a first setup, applies the standard rules and records how many
 *      times each rule is broken today. Setup is not finished while any of
 *      those counts is above zero.
 *   5. Starts the sandbox the way the checker will, to be sure it can.
 *   6. Commits, pushes the branch, and opens or updates the pull request,
 *      with a body rendered from the setup report.
 *
 * KEY TERMS
 *
 *   - State branch: `factory/setup-state`, where each step saved its files.
 *   - Recipe: `manifest.json`, the sandbox definition.
 *   - First setup / amendment: when the default branch already has a recipe,
 *     this run changes an existing factory (an amendment) and leaves the
 *     context files and the standard rules alone.
 *   - Stand-ins: local fakes of outside services, under `stubs/`.
 *   - Standard rules patch: `guardrails.patch`, the linter configuration the
 *     rules step produced.
 *   - Tier: how far the boot got (`static`, `boots`, `renders`).
 *
 * EXPORTS
 *
 *   - prStep: the `bsf setup pr` step.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SetupStep } from "./setup-record.js";
import { STEP_WORKFLOW } from "./setup-record.js";
import { renderJourneys, type JourneysFile } from "./setup-shapes.js";
import { failStep, passStep } from "./setup-steps.js";
import { STATE_BRANCH, STATE_DIR, type RunResult, type SetupWorld } from "./setup-world.js";

/** A failure of this step that has a known kind and a known next move. */
class PrFailure extends Error {
  /**
   * code: the kind of failure, as a short stable word.
   * detail: what went wrong, in full.
   * retry: the step to start again, or null when no step can fix it.
   * then: where the recipe step goes next when it is the one started again.
   */
  constructor(
    readonly code: string,
    readonly detail: string,
    readonly retry: SetupStep | null,
    readonly then: "boot" | "pr" = "boot",
  ) {
    super(detail);
  }
}

/**
 * The last lines of what a command printed.
 *
 * out: everything it printed.
 * Returns at most the last sixty lines, which is where a command says why
 * it failed.
 */
function ending(out: string): string {
  return out.trim().split(/\r?\n/).slice(-60).join("\n");
}

/**
 * Open the setup pull request: `bsf setup pr`.
 *
 * world: the outside world. The checkout is on the default branch.
 * Returns 0 when the pull request is open and its report passed, 1 when a
 * step was started again or the report check found problems, 2 when setup
 * stopped.
 */
export async function prStep(world: SetupWorld): Promise<number> {
  try {
    return await openPull(world);
  } catch (err) {
    if (err instanceof PrFailure) {
      return failStep(world, { step: "pr", code: err.code, detail: err.detail }, err.retry, err.then);
    }
    return failStep(world, { step: "pr", code: "unexpected", detail: world.git.redact((err as Error).message) }, null);
  }
}

/**
 * The sequence itself. Throws `PrFailure` for anything that ends the step.
 *
 * world: the outside world.
 */
async function openPull(world: SetupWorld): Promise<number> {
  const root = world.root;
  const temp = world.temp;
  /**
   * Run a runner command that has to succeed.
   *
   * args: the command.
   * code: the kind of failure to record when it does not.
   * retry: the step that can fix it, or null.
   */
  const need = async (args: readonly string[], code: string, retry: SetupStep | null = null): Promise<RunResult> => {
    const ran = await world.bsf(args);
    if (ran.code !== 0) throw new PrFailure(code, `\`bsf ${args.slice(0, 2).join(" ")}\` failed:\n${ending(ran.out)}`, retry);
    return ran;
  };

  // This job's checkout may still be on the setup branch from an earlier
  // step in the same process (the tests). On GitHub it is the default
  // branch. Put it on the default branch before copying files onto it.
  world.git.must(["fetch", "--quiet", world.git.remote, `+${world.defaultBranch}:refs/remotes/origin/${world.defaultBranch}`]);
  world.git.must(["checkout", "--quiet", "-B", world.defaultBranch, `refs/remotes/origin/${world.defaultBranch}`]);

  const tracking = world.git.fetchState();
  if (tracking === null) throw new PrFailure("missing-file", `The branch ${STATE_BRANCH} does not exist, so there is nothing to open a pull request from.`, null);
  const exported = join(temp, "state");
  rmSync(exported, { recursive: true, force: true });
  world.git.exportTree(tracking, STATE_DIR, exported);
  const design = join(exported, STATE_DIR);
  mkdirSync(join(design, "report"), { recursive: true });
  const saved = join(design, "manifest.json");
  if (!existsSync(saved)) throw new PrFailure("missing-file", "No recipe is saved on the setup branch.", "recipe", "pr");

  const pasted = await world.bsf(["sandbox", "secrets", "--file", saved]);
  if (pasted.code !== 0) throw new PrFailure("password-in-recipe", ending(pasted.out), "recipe", "pr");

  const recipe = join(root, ".factory/sandbox/manifest.json");
  const mainRecipe = join(temp, "main-manifest.json");
  const amending = existsSync(recipe);
  if (amending) cpSync(recipe, mainRecipe);
  mkdirSync(join(root, ".factory/sandbox"), { recursive: true });
  mkdirSync(join(root, ".factory/definition/context"), { recursive: true });
  cpSync(saved, recipe);
  cpSync(saved, join(temp, "manifest.json"));
  await need(["sandbox", "ui-paths", "--file", ".factory/sandbox/manifest.json"], "ui-paths-failed");
  if (existsSync(join(root, ".factory/definition/factory.yaml"))) {
    await need(["enforcement", "detect", "--file", ".factory/definition/factory.yaml"], "enforcement-detect-failed");
  }
  if (existsSync(join(design, "stubs"))) {
    rmSync(join(root, ".factory/sandbox/stubs"), { recursive: true, force: true });
    cpSync(join(design, "stubs"), join(root, ".factory/sandbox/stubs"), { recursive: true });
  }
  if (existsSync(join(design, "research-domains.txt"))) {
    cpSync(join(design, "research-domains.txt"), join(root, ".factory/sandbox/research-domains.txt"));
  }

  const contextDir = join(root, ".factory/definition/context");
  if (!amending && existsSync(join(design, "context"))) {
    for (const name of readdirSync(join(design, "context")).filter((n) => n.endsWith(".md")).sort()) {
      const from = join(design, "context", name);
      const dest = join(contextDir, name);
      if (name === "fundamentals.md") {
        // The person's own "Product intent" block survives the rewrite.
        const merged = join(temp, "fundamentals.merged.md");
        await need(["context", "merge-intent", "--existing", dest, "--incoming", from, "--out", merged], "merge-intent-failed");
        cpSync(merged, dest);
      } else {
        cpSync(from, dest);
      }
    }
  }
  // The journey list is saved as JSON and the markdown is rendered from it,
  // on a first setup and when one journey was added to a finished one.
  const journeysPath = join(design, "journeys.json");
  if (existsSync(journeysPath)) {
    const file = JSON.parse(readFileSync(journeysPath, "utf8")) as JourneysFile;
    writeFileSync(join(contextDir, "journeys.json"), `${JSON.stringify(file, null, 2)}\n`);
    writeFileSync(join(contextDir, "journeys.md"), renderJourneys(file));
  }
  if (existsSync(join(contextDir, "fundamentals.md"))) {
    const copied = await world.bsf(["assess", "fundamentals", "--root", "."]);
    if (copied.code !== 0) throw new PrFailure("copied-fundamentals", ending(copied.out), "recipe", "pr");
  }

  let guard = "";
  let tier = "static";
  try {
    const reached = (JSON.parse(readFileSync(join(design, "trial.json"), "utf8")) as { reached?: unknown }).reached;
    if (typeof reached === "string" && reached !== "") tier = reached;
  } catch { /* no boot log: the report says static */ }
  if (!amending) {
    const patch = join(design, "guardrails.patch");
    if (existsSync(patch) && statSync(patch).size > 0) {
      if (/^(\+\+\+|---) [ab]\/(\.github|\.factory)\//m.test(readFileSync(patch, "utf8"))) {
        world.say("::warning::the standard rules patch touches .github/ or .factory/; it is left out");
      } else if (world.git.try(["apply", "--index", patch]).code === 0) {
        world.say("applied the standard rules");
      } else {
        world.say("::warning::the standard rules patch did not apply; it is left out");
      }
    }
    if ((await world.bsf(["sandbox", "start"])).code !== 0) world.say("the private copy did not start; the counts are still recorded");
    const recorded = await need(["guardrails", "record"], "guardrails-not-recorded");
    guard = recorded.out.trim().split(/\r?\n/).find((l) => l.startsWith("baselined")) ?? recorded.out.trim().split(/\r?\n/)[0] ?? "";
    await need(["guardrails", "require-zero"], "guardrail-counts-not-zero");
    try {
      const decided = JSON.parse(readFileSync(join(design, "guardrails.json"), "utf8")) as { installed?: unknown[]; skipped?: unknown[] };
      guard = `${guard}. Rules: ${(decided.installed ?? []).length} installed, ${(decided.skipped ?? []).length} left out`;
    } catch { /* the rules step left no list */ }
  }
  // Start the sandbox exactly as the checker will. A recipe the checker
  // cannot use is the recipe step's to fix, and a changed recipe is booted.
  await need(["sandbox", "dry-run"], "checker-could-not-start", "recipe");

  const existing = amending ? null : await world.findSetupPull();
  const branch = existing?.branch ?? `factory/setup-${process.env["GITHUB_RUN_ID"] ?? Date.now().toString()}`;
  world.git.must(["checkout", "--quiet", "-B", branch]);
  world.git.must(["add", "--all", "--", ".factory"]);
  if (world.git.try(["diff", "--cached", "--quiet"]).code === 0) {
    await passStep(world, "pr", { stage: "done", waiting_on: "nothing. What setup produced is already on the default branch." });
    world.say("nothing changed");
    return 0;
  }
  const title = amending ? "Amend the factory's sandbox" : "Set up the software factory";
  world.git.must(["commit", "--quiet", "-m", title]);
  const pushed = world.git.try(["push", "--force", world.git.remote, `HEAD:refs/heads/${branch}`]);
  if (pushed.code !== 0) throw new PrFailure("push-rejected", `The push of ${branch} was rejected:\n${ending(pushed.out)}`, "recipe", "pr");

  mkdirSync(join(temp, "trial"), { recursive: true });
  if (existsSync(join(design, "trial.json"))) cpSync(join(design, "trial.json"), join(temp, "trial", "trial.json"));
  const extra = {
    focus: [
      {
        title: "What the private copy can exercise",
        detail: `It reached ${tier} when this computer booted it and clicked the journeys. .factory/sandbox/manifest.json says what it runs.`,
      },
      { title: "No credential of yours is in it", detail: "A secret is a name. The value stays in the GitHub secret FACTORY_SANDBOX_ENV." },
      ...(guard === "" ? [] : [{ title: "Guardrails", detail: guard }]),
    ],
    links: world.runUrl === null ? [] : [{ label: "The boot, and its logs", url: world.runUrl }],
  };
  const extraPath = join(temp, "report-extra.json");
  writeFileSync(extraPath, `${JSON.stringify(extra, null, 2)}\n`);
  const bodyPath = join(temp, "pr-body.md");
  await need(
    ["report", "setup", "--dir", join(design, "report"), "--trial-dir", join(temp, "trial"), "--tier", tier, "--extra", extraPath, "--out", bodyPath],
    "report-not-rendered",
  );
  const body = readFileSync(bodyPath, "utf8");
  let pull: number;
  if (existing !== null) {
    pull = existing.number;
    await world.updatePull(pull, { title, body });
    world.say(`updated #${pull}`);
  } else {
    pull = await world.createPull({ title, head: branch, base: world.defaultBranch, body });
    world.say(`opened #${pull}`);
  }
  const continued = `${bodyPath}.continued.md`;
  if (existsSync(continued)) await world.commentOnPull(pull, readFileSync(continued, "utf8"));

  const report = await world.bsf([
    "report", "check", "--pr", String(pull), "--problems", `${bodyPath}.problems.json`, "--degraded", `${bodyPath}.degraded.json`,
  ]);
  if (amending) {
    await need(["sandbox", "land", "--pr", String(pull), "--main", mainRecipe, "--candidate", join(temp, "manifest.json")], "land-check-failed");
  }
  await passStep(world, "pr", {
    stage: "done",
    pull,
    waiting_on: `you: review and merge pull request #${pull}${report.code === 0 ? "" : ". Its report check found problems; they are listed on the pull request"}`,
  });
  world.say(`${STEP_WORKFLOW.pr} finished: ${basename(branch)} is pull request #${pull}`);
  return report.code === 0 ? 0 : 1;
}
