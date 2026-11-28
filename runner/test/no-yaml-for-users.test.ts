import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The no-YAML rule: a user never opens or edits a definition file, and nothing
 * the factory shows them says to. This reads every place text reaches a
 * person (the dashboard, the setup skill's instructions and scripts, the
 * runner's messages, the README) and fails on an instruction to edit one.
 *
 * Describing what a file is, or telling the agent which file it writes, is
 * fine; telling a person to open or change it is not.
 */

// `fileURLToPath`, not `.pathname`: on Windows the pathname is `/C:/…`, which
// `join` turns into a path that does not exist.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, keep: (p: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "out" || name === "dist") continue;
    // Forward slashes on every platform, so the filters below can name a folder.
    const p = join(dir, name).split("\\").join("/");
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

const textFiles = [
  ...walk(join(ROOT, "dashboard/app"), (p) => /\.tsx?$/.test(p)),
  ...walk(join(ROOT, "dashboard/components"), (p) => /\.tsx?$/.test(p)),
  ...walk(join(ROOT, "skill"), (p) => /\.(md|mjs)$/.test(p) && !p.includes("/rules/")),
  ...walk(join(ROOT, "templates/issue-forms"), (p) => p.endsWith(".yml")),
  join(ROOT, "README.md"),
  join(ROOT, "runner/src/cli.ts"),
  ...walk(join(ROOT, "runner/src/commands"), (p) => p.endsWith(".ts")),
];

// An imperative aimed at a person, followed closely by a settings or policy file or key.
const FILE = String.raw`(?<![A-Za-z_])(?:factory\.yaml|policy\.yaml|\.factory/definition|definition file|YAML|monthly_usd|auto_merge|max_prs_per_run|test_check|sandbox_repairs)`;
const INSTRUCTION = new RegExp(
  String.raw`\b(?:edit|open|change|set|raise|lower|update|modify|add to|put (?:it )?in)\b[^.\n\`]{0,50}${FILE}|${FILE}[^.\n]{0,40}\bis (?:raised|lowered|changed|edited)\b|\bin ${FILE}\b`,
  "i",
);

describe("nothing the factory says to a person tells them to edit a settings file", () => {
  it("covers the places text reaches a person", () => {
    expect(textFiles.length).toBeGreaterThan(40);
    expect(textFiles.some((f) => f.endsWith("dashboard/app/factory/page.tsx"))).toBe(true);
    expect(textFiles.some((f) => f.endsWith("skill/SKILL.md"))).toBe(true);
  });

  it("finds no such instruction", () => {
    const hits: string[] = [];
    for (const f of textFiles) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (INSTRUCTION.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("the rule itself catches what it is meant to", () => {
    for (const bad of [
      "Edit .factory/definition/factory.yaml to change a toggle.",
      "raise monthly_usd in factory.yaml to do more",
      "or set existing_ci.test_check in factory.yaml.",
      "when `budget.monthly_usd` in factory.yaml is raised",
      "Change auto_merge in the YAML file",
    ]) expect(INSTRUCTION.test(bad), bad).toBe(true);
    for (const fine of [
      "The monthly budget is changed from the Factory page.",
      "Write `factory.yaml`, `policy.yaml`, the seven role files",
      "Ask the factory on the dashboard.",
    ]) expect(INSTRUCTION.test(fine), fine).toBe(false);
  });
});
