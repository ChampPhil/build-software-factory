import { describe, expect, it } from "vitest";
import { emptyRecord, noteFailure, noteSuccess, sameReason, statusLines, type Failure } from "../src/commands/setup-record.js";
import { missingCredentials } from "../src/commands/credentials.js";
import { judgeBoot } from "../src/commands/setup-steps.js";
import type { TrialReport } from "../src/commands/sandbox.js";

const fail = (over: Partial<Failure> = {}): Failure => ({
  step: "recipe",
  code: "shape",
  detail: "journeys.json: is missing \"what_proves_it\"",
  at: "2026-01-01T00:00:00Z",
  run: "https://example/runs/1",
  ...over,
});

describe("sameReason", () => {
  it("treats two details that differ only by a hash or a run number as the same", () => {
    expect(sameReason(
      fail({ detail: "missed abcdef0123456789 in 12ms /runs/99" }),
      fail({ detail: "missed fedcba9876543210 in 40ms /runs/100" }),
    )).toBe(true);
    expect(sameReason(fail({ code: "shape" }), fail({ code: "missing-file" }))).toBe(false);
  });
});

describe("noteFailure", () => {
  it("stops on the same reason twice, and on the third different failure", () => {
    const t0 = emptyRecord("2026-01-01T00:00:00Z");
    const first = noteFailure(t0, fail({ at: "t1" }));
    expect(first.stop).toBeNull();
    const same = noteFailure(first.record, fail({ at: "t2", run: "https://example/runs/2" }));
    expect(same.stop).toBe("same");
    const t1 = emptyRecord("t0");
    const a = noteFailure(t1, fail({ detail: "one", at: "a" }));
    const b = noteFailure(a.record, fail({ detail: "two", at: "b" }));
    const c = noteFailure(b.record, fail({ detail: "three", at: "c" }));
    expect(c.stop).toBe("limit");
  });

  it("clears a step's failures after it succeeds", () => {
    const failed = noteFailure(emptyRecord("t0"), fail({ at: "a" })).record;
    const after = noteSuccess(failed, "recipe", "t1");
    expect(after.failures.recipe).toBeUndefined();
  });
});

describe("statusLines", () => {
  it("prints the last failure in full", () => {
    const record = noteFailure(emptyRecord("t0"), fail({ detail: "the quote is not copied from finding \"fix:abc\"" })).record;
    const lines = statusLines(record, { missing: [], settingsWaiting: [], running: [] });
    expect(lines.join("\n")).toContain("the quote is not copied from finding \"fix:abc\"");
    expect(lines.join("\n")).toContain("Waiting on:");
  });
});

describe("missingCredentials", () => {
  it("names each missing credential, and treats an unset flag as missing", () => {
    expect(missingCredentials(["app", "model"], {})).toHaveLength(3);
    expect(missingCredentials(["app"], { HAS_APP_ID: "true", HAS_APP_KEY: "true" })).toEqual([]);
    expect(missingCredentials(["model"], { HAS_MODEL: "true" })).toEqual([]);
  });
});

describe("judgeBoot", () => {
  const trial = (over: Partial<TrialReport>): TrialReport => ({
    schema: "sandbox-trial/1",
    claimed: "renders",
    reached: "renders",
    steps: [],
    app_url: "http://127.0.0.1:3000/",
    app_status: 200,
    screenshot: "x",
    summary: "ok",
    ...over,
  });

  it("sends a missing name back to the screen", () => {
    const v = judgeBoot(trial({ return_to_screen: ["CLERK_SECRET_KEY"] }), []);
    expect(v.kind).toBe("screen");
    if (v.kind === "screen") expect(v.names).toContain("CLERK_SECRET_KEY");
  });

  it("names the journey whose check did not pass", () => {
    const v = judgeBoot(trial({ probes: [] }), [{
      name: "See home",
      how_a_person_gets_there: "/home",
      what_proves_it: "Home",
      signed_in: false,
      check: "home-page",
    }]);
    expect(v.kind).toBe("writer");
    if (v.kind === "writer") {
      expect(v.code).toBe("journeys-not-clicked");
      expect(v.detail).toContain("See home");
    }
  });
});
