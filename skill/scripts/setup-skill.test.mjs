/**
 * Checks for the setup skill's naming and watch scripts.
 *
 * Purpose:
 *   These are the pure functions an agent cannot see fail in chat: the GitHub
 *   App's short name, which setup run the progress watch follows, how often
 *   that watch speaks, and the rule that a multi-minute poll is a failed watch.
 *   The runner's own test file imports the same functions from outside skill/.
 *   This file is the check that lives next to the scripts.
 *
 * Key terms:
 *   - Short label: the bit inside the parentheses of the App name. Initials
 *     for a name with hyphens or underscores, or the first five letters of
 *     a single word. The GitHub owner is not part of it.
 *   - Live run: a factory-setup run that has not finished. An old failure
 *     is not one.
 *   - Failed watch: a poll that sleeps for two minutes or more. It must
 *     give up immediately instead of looking stuck.
 *
 * Exports:
 *   - none. This file is run with `node --test`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { APP_NAME_MAX, appName, repoShortLabel } from "./create-app.mjs";
import { JOB_LINES, nextLine, pickRun, SPEAK_EVERY_MS } from "./progress.mjs";
import { pollGapError, waitFor } from "./wait-for.mjs";

test("a hyphenated or underscored repository becomes initials", () => {
  assert.equal(repoShortLabel("vibecoding-for-marketing"), "VFM");
  assert.equal(repoShortLabel("vibecoding_for_marketing"), "VFM");
});

test("a single word uses its first five letters and a short word stays whole", () => {
  assert.equal(repoShortLabel("trinsports"), "trins");
  assert.equal(repoShortLabel("web"), "web");
  assert.equal(repoShortLabel("trinsports").includes("trinso"), false);
});

test("the GitHub owner is not mixed into the label", () => {
  assert.equal(repoShortLabel("ChampPhil/vibecoding-for-marketing"), "VFM");
  assert.equal(appName("Build Software Factory", "ChampPhil/vibecoding-for-marketing"), "Factory (VFM)");
  assert.equal(appName("Build Software Factory", "vibecoding-for-marketing").includes("Champ"), false);
});

test("the installed name is Factory plus the short label, and it is not cut mid-word", () => {
  const name = appName("Build Software Factory", "vibecoding-for-marketing");
  assert.equal(name, "Factory (VFM)");
  assert.equal(name.length <= APP_NAME_MAX, true);
  assert.equal(name.endsWith(")"), true);
  assert.equal(name.includes("vibecod"), false);
});

test("a recompiler App keeps its own short prefix", () => {
  const name = appName("Build Software Factory Recompiler", "vibecoding-for-marketing");
  assert.equal(name, "Recomp (VFM)");
  assert.equal(name.length <= APP_NAME_MAX, true);
});

test("very long initials are dropped whole and the parenthesis stays closed", () => {
  const slug = Array.from({ length: 40 }, (_, i) => `word${i}`).join("-");
  const name = appName("Build Software Factory", slug);
  assert.equal(name.startsWith("Factory ("), true);
  assert.equal(name.endsWith(")"), true);
  assert.equal(name.length <= APP_NAME_MAX, true);
  assert.equal(name.includes("-"), false);
});

test("the progress watch does not adopt an old finished run", () => {
  const picked = pickRun([{ databaseId: 1, status: "completed" }], null);
  assert.equal(picked.run, null);
  assert.equal(picked.switched, false);
});

test("the progress watch follows the newest live run and leaves an old failure", () => {
  const picked = pickRun(
    [
      { databaseId: 1, status: "completed" },
      { databaseId: 4, status: "in_progress" },
      { databaseId: 3, status: "in_progress" },
    ],
    1,
  );
  assert.equal(picked.run.databaseId, 4);
  assert.equal(picked.switched, true);
});

test("a watch already on a run reports that run once it finishes and nothing newer exists", () => {
  const picked = pickRun([{ databaseId: 4, status: "completed" }], 4);
  assert.equal(picked.run.databaseId, 4);
  assert.equal(picked.switched, false);
});

test("a newer run replaces the one the watch was stuck on", () => {
  const picked = pickRun(
    [
      { databaseId: 2, status: "completed" },
      { databaseId: 9, status: "completed" },
    ],
    2,
  );
  assert.equal(picked.run.databaseId, 9);
  assert.equal(picked.switched, true);
});

test("progress speaks on a stage change and again after one minute", () => {
  const jobs = [
    { name: "ready", status: "completed", conclusion: "success" },
    { name: "plan", status: "in_progress" },
  ];
  const first = nextLine(jobs, { job: null, at: 0 }, 0);
  assert.equal(first.line, `${JOB_LINES.plan}.`);
  const early = nextLine(jobs, first.state, SPEAK_EVERY_MS - 1);
  assert.equal(early.line, null);
  const again = nextLine(jobs, first.state, first.state.at + SPEAK_EVERY_MS);
  assert.equal(again.line, `${JOB_LINES.plan}.`);
});

test("a few seconds is a real watch and a multi-minute gap is not", () => {
  assert.equal(pollGapError(5000), null);
  assert.match(pollGapError(180000), /failed watch/);
});

test("waitFor refuses a multi-minute gap without polling", async () => {
  let calls = 0;
  const said = [];
  const ok = await waitFor(
    async () => {
      calls += 1;
      return true;
    },
    {
      intervalMs: 180000,
      timeoutMs: 600000,
      say: (line) => said.push(line),
      now: () => 0,
      sleep: async () => {},
    },
  );
  assert.equal(ok, false);
  assert.equal(calls, 0);
  assert.match(said.join(" "), /failed watch/);
});
