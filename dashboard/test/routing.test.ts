import { describe, it, expect } from "vitest";
import { GitHubClient } from "../lib/github.js";
import { MOVABLE, canMove, liveGoals, misRoute, whoRouted } from "../lib/routing.js";
import type { StandingGoalsFile, WorkItemDoc } from "../lib/types.js";

const doc = (over: Partial<WorkItemDoc> = {}): WorkItemDoc => ({
  id: "wi_1", created_at: "2026-11-22T10:00:00Z", pipeline: "product_work", title: "t", body: null, status: "queued", pr: null, parent: null,
  source: { kind: "request", ref: "#1", actor: "philip" }, ...over,
});

describe("routing on the dashboard", () => {
  it("lets a request be moved only before work has started", () => {
    for (const s of ["queued", "needs_info", "waiting_trust", "escalated"]) expect(canMove(s)).toBe(true);
    for (const s of ["running", "in_review", "merged", "queued_to_merge"]) expect(canMove(s)).toBe(false);
    expect(MOVABLE).toEqual(["product_work", "gardening", "hardening"]);
  });

  it("says who chose the pipeline, and nothing when it is not known", () => {
    expect(whoRouted(doc({ routing: { by: "chief_of_staff", reason: "r", at: "t" } }))).toBe("chosen by the chief of staff");
    expect(whoRouted(doc({ routing: { by: "person", reason: "r", at: "t" } }))).toBe("moved by a person");
    expect(whoRouted(doc({ routing: { by: "table", reason: "r", at: "t" } }))).toBe("default route");
    expect(whoRouted(doc())).toBeNull();
    expect(whoRouted(undefined)).toBeNull();
  });

  it("counts how often a person undid the chief of staff", () => {
    const moved = { by: "person" as const, reason: "r", at: "t", from: "product_work", overrides: [{ by: "philip", at: "t", from: "product_work", to: "gardening" }] };
    const m = misRoute([
      doc({ routing: { by: "chief_of_staff", reason: "r", at: "t" } }),
      doc({ routing: { by: "chief_of_staff", reason: "r", at: "t" } }),
      doc({ routing: moved }),
      doc({ routing: { by: "table", reason: "r", at: "t" } }),
      doc(),
    ]);
    expect(m).toEqual({ routed: 3, moved: 1, rate: 1 / 3 });
    expect(misRoute([doc()])).toEqual({ routed: 0, moved: 0, rate: null });
  });

  it("shows only goals that have not expired", () => {
    const file: StandingGoalsFile = { schema: "standing-goals/1", goals: [
      { id: "a", text: "auth", lane: null, by: "p", at: "t", until: null },
      { id: "b", text: "old", lane: "gardening", by: "p", at: "t", until: "2026-01-01T00:00:00Z" },
    ] };
    expect(liveGoals(file, new Date("2026-11-22")).map((g) => g.id)).toEqual(["a"]);
    expect(liveGoals(null)).toEqual([]);
  });
});

describe("the dashboard's controls reach the factory's intake", () => {
  const calls: { url: string; body: string }[] = [];
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (url.endsWith("repos/o/r")) return Promise.resolve(new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof globalThis.fetch;
  const inputs = () => JSON.parse(calls.at(-1)!.body).inputs as Record<string, string>;
  const client = new GitHubClient({ token: "t", repo: "o/r" }, fetch);

  it("moves a request, adds a goal with and without a lane, and removes one", async () => {
    await client.moveRequest("wi_1", "hardening");
    expect(calls.at(-1)!.url).toContain("factory-intake.yml/dispatches");
    expect(inputs()).toEqual({ kind: "route_override", title: "wi_1", body: "hardening" });
    await client.addStandingGoal("tighten auth", "hardening");
    expect(inputs()).toEqual({ kind: "standing_goal_add", title: "tighten auth", body: "hardening" });
    await client.addStandingGoal("anything", null);
    expect(inputs()).toEqual({ kind: "standing_goal_add", title: "anything", body: "" });
    await client.removeStandingGoal("g1");
    expect(inputs()).toEqual({ kind: "standing_goal_remove", title: "g1" });
  });
});
