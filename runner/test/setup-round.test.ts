import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptRound, checkRound, submitRound } from "../src/commands/setup-round.js";
import type { Journey } from "../src/commands/setup-shapes.js";

function round(): { dir: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), "bsf-round-"));
  const dir = join(root, "from");
  const state = join(root, "state");
  mkdirSync(dir);
  mkdirSync(state);
  return { dir, state };
}

const journey: Journey = {
  name: "See home",
  how_a_person_gets_there: "/home",
  what_proves_it: "the heading Home",
  signed_in: false,
};

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "sandbox/1",
    tier: "renders",
    tier_reason: null,
    commands: { install: "true", build: "true", run: "true", test: "true" },
    app_url: "http://127.0.0.1:3000/",
    env: [],
    services: [],
    egress: [],
    stubs: [],
    dropped: [],
    capabilities: { exercised: ["home"], not_exercised: [] },
    episode: [{ attempt: 1, tried: "t", observed: "o", changed: null }],
    frozen_at: "2026-11-20T00:00:00Z",
    dependencies: [{
      name: "home-page",
      kind: "other",
      stand_in: "inert",
      probe: { path: "/", signed_in: false },
      why: "the home page",
    }],
    ...over,
  };
}

describe("checkRound", () => {
  it("refuses a journey list that is missing a field", () => {
    const { dir } = round();
    writeFileSync(join(dir, "journeys.json"), JSON.stringify({ schema: "journeys/1", journeys: [{ name: "Home" }] }));
    const check = checkRound("journeys", dir, { root: dir, saved: [], skippedSignIn: [] });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("shape");
  });

  it("refuses a recipe that drops a saved journey", () => {
    const { dir } = round();
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest()));
    writeFileSync(join(dir, "recipe-journeys.json"), JSON.stringify({ schema: "recipe-journeys/1", tests: {} }));
    const check = checkRound("recipe", dir, { root: dir, saved: [journey], skippedSignIn: [] });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.join("\n")).toMatch(/See home/);
  });

  it("refuses a pasted password and copies nothing", () => {
    const { dir, state } = round();
    writeFileSync(join(state, "keep.txt"), "keep\n");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest({
      env: [{ name: "STRIPE", kind: "self", value: "sk_live_abc123", why: "x" }],
    })));
    const check = acceptRound("amendment", dir, state, { root: dir, saved: [], skippedSignIn: [] });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.code).toBe("password-in-recipe");
    expect(readFileSync(join(state, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("saves a valid journey list as JSON and as markdown", () => {
    const { dir, state } = round();
    writeFileSync(join(dir, "journeys.json"), JSON.stringify({ schema: "journeys/1", journeys: [journey] }));
    const check = acceptRound("journeys", dir, state, { root: dir, saved: [], skippedSignIn: [] });
    expect(check.ok).toBe(true);
    expect(readFileSync(join(state, "context", "journeys.md"), "utf8")).toContain("## See home");
    expect(readFileSync(join(state, "journeys.json"), "utf8")).toContain("See home");
  });
});

describe("submitRound", () => {
  it("refuses twice, then tells the writer to stop", () => {
    const { dir } = round();
    writeFileSync(join(dir, "amend.json"), JSON.stringify({ focus: "journeys", journeys: [], skipped_sign_in: [] }));
    writeFileSync(join(dir, "journeys.json"), "{}");
    const first = submitRound(dir, dir);
    expect(first.code).toBe(1);
    const second = submitRound(dir, dir);
    expect(second.code).toBe(1);
    const third = submitRound(dir, dir);
    expect(third.code).toBe(1);
    expect(third.lines.join("\n")).toMatch(/last answer/i);
    const fourth = submitRound(dir, dir);
    expect(fourth.code).toBe(2);
  });
});
