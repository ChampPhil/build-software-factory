import { describe, it, expect } from "vitest";
import { inadequacyProblems, inadequacyKey } from "../src/commands/sandbox.js";

const r = { role: "builder", needs: "a Postgres to run the follow flow against", paths: ["lib/db.ts"], why: "no database service" };

describe("sandbox inadequacy reports", () => {
  it("accepts a complete report and rejects one missing what it needs", () => {
    expect(inadequacyProblems(r)).toEqual([]);
    expect(inadequacyProblems({ ...r, needs: "" })).toContain("needs is required");
    expect(inadequacyProblems({ ...r, paths: "lib/db.ts" })).toContain("paths is a list of file paths");
  });

  it("gives the same need the same key however it is worded in spacing and case, so it amends once", () => {
    expect(inadequacyKey({ ...r, needs: "A  Postgres to run the follow flow against " })).toBe(inadequacyKey(r));
    expect(inadequacyKey({ ...r, paths: ["lib/other.ts"] })).not.toBe(inadequacyKey(r));
  });
});
