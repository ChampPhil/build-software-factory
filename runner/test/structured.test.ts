import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillShape, readAttempts, readJsonAnswer, recordAttempt, shapeProblems } from "../src/lib/structured.js";
import { JOURNEY_LIST_SHAPE } from "../src/commands/setup-shapes.js";

describe("shapeProblems", () => {
  it("names the missing field and the extra field", () => {
    const problems = shapeProblems(JOURNEY_LIST_SHAPE, { schema: "journeys/1", journeys: [{ name: "Home" }] });
    expect(problems.some((p) => p.includes("how_a_person_gets_there"))).toBe(true);
    const extra = shapeProblems(JOURNEY_LIST_SHAPE, {
      schema: "journeys/1",
      journeys: [{ name: "Home", how_a_person_gets_there: "go", what_proves_it: "see it", signed_in: false, extra: 1 }],
    });
    expect(extra.some((p) => p.includes("extra"))).toBe(true);
  });
});

describe("readJsonAnswer", () => {
  it("unwraps a markdown fence", () => {
    const parsed = readJsonAnswer("```json\n{\"ok\":true}\n```");
    expect(parsed).toEqual({ value: { ok: true } });
  });
});

describe("fillShape", () => {
  it("retries a refused answer with the problems, then accepts", async () => {
    const answers = [
      { schema: "journeys/1" },
      {
        schema: "journeys/1",
        journeys: [{ name: "See home", how_a_person_gets_there: "/home", what_proves_it: "the heading Home", signed_in: false }],
      },
    ];
    const filled = await fillShape({
      shape: JOURNEY_LIST_SHAPE,
      ask: async (refused) => {
        if (refused !== null) expect(refused.problems.length).toBeGreaterThan(0);
        return answers.shift() ?? null;
      },
    });
    expect(filled.ok).toBe(true);
    if (filled.ok) expect(filled.attempts).toBe(2);
  });

  it("stops after three refusals and keeps the problems", async () => {
    const filled = await fillShape({
      shape: JOURNEY_LIST_SHAPE,
      ask: async () => ({ schema: "nope" }),
    });
    expect(filled.ok).toBe(false);
    if (!filled.ok) {
      expect(filled.attempts).toBe(3);
      expect(filled.problems.length).toBeGreaterThan(0);
    }
  });
});

describe("the attempt log", () => {
  it("counts answers across separate calls", () => {
    const path = join(mkdtempSync(join(tmpdir(), "bsf-att-")), "submit.json");
    expect(readAttempts(path).attempts).toBe(0);
    recordAttempt(path, ["missing"]);
    recordAttempt(path, []);
    const log = JSON.parse(readFileSync(path, "utf8")) as { attempts: number; accepted: boolean };
    expect(log.attempts).toBe(2);
    expect(log.accepted).toBe(true);
  });
});
