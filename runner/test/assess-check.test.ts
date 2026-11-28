import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessmentProblems, copiedFundamentals, fundamentalsProblems, assessCheck } from "../src/commands/assess-check.js";
import { miningSummary } from "../src/commands/mine-classify.js";

const counts = { session_searches: 8, reverts: 1, fixes: 4, reviews: 2, bugs: 0, prose: 6 };
const summary = miningSummary(counts);

function survey(): string {
  const section = (title: string, body: string) => `## ${title}\n\n${body}\n`;
  return [
    "# Survey",
    section("How it builds and tests", "Python tests are pytest from the backend. The site tests are vitest. Docker Compose starts Postgres."),
    section("The test check", "There is no GitHub Actions test workflow on the default branch, so the factory runs the repository's own tests."),
    section("Patterns", "FastAPI owns every write. Route handlers call services. Postgres access lives in database repositories, one per table."),
    section("Where two patterns compete", "One pattern for writes. Count: 1. No second client beside the official one was found."),
    section("Coverage", "The suites exist. The measured floor is whatever the suites report. Areas with no tests were not guessed."),
    section("What mining found", `${summary} No session was excluded.`),
  ].join("\n");
}

describe("assessmentProblems", () => {
  const report = {
    schema: "mining-report/1" as const,
    summary,
    classified: true,
    searched: counts,
    pending: [],
    note: "",
  };

  it("accepts a survey that repeats the miner's sentence", () => {
    expect(assessmentProblems(survey(), report)).toEqual([]);
  });

  it("rejects a sketch that skips the sections", () => {
    const problems = assessmentProblems("# What this repository already is\n\nA short note.\n", report);
    expect(problems.some((p) => p.includes("How it builds and tests"))).toBe(true);
  });

  it("accepts a short section", () => {
    const text = survey().replace(
      "Python tests are pytest from the backend. The site tests are vitest. Docker Compose starts Postgres.",
      "pytest.",
    );
    expect(assessmentProblems(text, report)).toEqual([]);
  });

  it("accepts a competing-patterns section with no digit", () => {
    const text = survey().replace("One pattern for writes. Count: 1. No second client beside the official one was found.", "One pattern for writes. No second client.");
    expect(assessmentProblems(text, report)).toEqual([]);
  });

  it("rejects a survey that does not repeat the miner's sentence", () => {
    const text = survey().replace(summary, "Mining found some things.");
    expect(assessmentProblems(text, report).some((p) => p.includes("miner's summary"))).toBe(true);
  });

  it("rejects an unlabelled mining report", () => {
    expect(assessmentProblems(survey(), { ...report, classified: false }).some((p) => p.includes("unlabelled"))).toBe(true);
  });
});

describe("copiedFundamentals", () => {
  it("flags a table copied out of the README", () => {
    const readme = [
      "The browser never opens the database. Next.js calls FastAPI and sends the Clerk session token.",
      "FastAPI owns every write. Route handlers call services. They do not embed SQL.",
      "Postgres access lives in database, one repository per table or cohesive group.",
    ].join("\n");
    const fundamentals = [
      "| Reads | The browser never opens the database. Next.js calls FastAPI and sends the Clerk session token. | README |",
      "| Writes | FastAPI owns every write. Route handlers call services. They do not embed SQL. | README |",
      "| Data | Postgres access lives in database, one repository per table or cohesive group. | README |",
    ].join("\n");
    const copies = copiedFundamentals(fundamentals, [readme]);
    expect(fundamentalsProblems(copies, 3).length).toBeGreaterThan(0);
  });

  it("allows a few shared sentences when most of the file is new", () => {
    expect(fundamentalsProblems(["copied line ".repeat(4)], 10)).toEqual([]);
  });

  it("allows a line that is not in the house docs", () => {
    const line = "A page is not done until the loaded layout and the loading layout are the same layout.";
    expect(copiedFundamentals(line, ["The API is FastAPI."])).toEqual([]);
  });
});

describe("assessCheck", () => {
  it("fails a checkout whose survey was never mined", () => {
    const root = mkdtempSync(join(tmpdir(), "assess-"));
    writeFileSync(join(root, "assessment.md"), survey());
    const problems = assessCheck(root);
    expect(problems.some((p) => p.includes("miner has not run"))).toBe(true);
  });

  it("passes when the report, the survey, and fundamentals agree", () => {
    const root = mkdtempSync(join(tmpdir(), "assess-"));
    mkdirSync(join(root, ".factory/guardrails"), { recursive: true });
    mkdirSync(join(root, ".factory/definition/context"), { recursive: true });
    writeFileSync(join(root, "assessment.md"), survey());
    writeFileSync(join(root, ".factory/guardrails/mining-report.json"), JSON.stringify({
      schema: "mining-report/1",
      summary,
      classified: true,
      searched: counts,
      pending: [],
      note: "",
    }));
    writeFileSync(join(root, ".factory/definition/context/fundamentals.md"), "A page is not done until the loaded layout and the loading layout are the same layout.\n");
    expect(assessCheck(root)).toEqual([]);
  });
});
