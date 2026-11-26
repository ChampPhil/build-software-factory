import { describe, expect, it } from "vitest";
import { isConfirmed, runAction, sweep, type HeldData } from "../lib/optimistic";

const data = (over: Partial<HeldData> = {}): HeldData => ({ pulls: [], issues: [], open: [], pendingCandidates: [], ...over });

const deps = () => {
  const said: string[] = [];
  const held = new Set<string>();
  let refreshed = 0;
  return { said, held, get refreshed() { return refreshed; }, say: (t: string) => said.push(t), refresh: () => { refreshed++; }, hold: (k: string) => held.add(k), release: (k: string) => held.delete(k) };
};

describe("runAction", () => {
  it("holds the key at once, says Saving then the result, and keeps the hold until the records confirm", async () => {
    const d = deps();
    const ok = await runAction(async () => undefined, "Merged.", d, "pr-gone:5", String);
    expect(ok).toBe(true);
    expect(d.held.has("pr-gone:5")).toBe(true);
    expect(d.said).toEqual(["Saving…", "Merged."]);
    expect(d.refreshed).toBe(1);
  });
  it("releases the hold and names the reason when it fails", async () => {
    const d = deps();
    const ok = await runAction(async () => { throw new Error("403"); }, "Merged.", d, "pr-gone:5", (e) => (e as Error).message);
    expect(ok).toBe(false);
    expect(d.held.has("pr-gone:5")).toBe(false);
    expect(d.said).toEqual(["Saving…", "Could not do that: 403"]);
  });
  it("works with no key at all", async () => {
    const d = deps();
    expect(await runAction(async () => undefined, "Done.", d, undefined, String)).toBe(true);
    expect(d.held.size).toBe(0);
  });
});

describe("isConfirmed", () => {
  it("a merged or closed PR is confirmed when it leaves the open list", () => {
    expect(isConfirmed("pr-gone:5", data({ pulls: [{ number: 5 }] }))).toBe(false);
    expect(isConfirmed("pr-gone:5", data({ pulls: [{ number: 6 }] }))).toBe(true);
  });
  it("never counts data that has not loaded", () => {
    expect(isConfirmed("pr-gone:5", data({ pulls: null }))).toBe(false);
    expect(isConfirmed("issue-gone:5", data({ issues: null }))).toBe(false);
  });
  it("a closed issue leaves the open list", () => {
    expect(isConfirmed("issue-gone:9", data({ issues: [{ number: 9, labels: [] }] }))).toBe(false);
    expect(isConfirmed("issue-gone:9", data())).toBe(true);
  });
  it("an accepted issue shows the label", () => {
    expect(isConfirmed("issue-accepted:9", data({ issues: [{ number: 9, labels: [] }] }))).toBe(false);
    expect(isConfirmed("issue-accepted:9", data({ issues: [{ number: 9, labels: [{ name: "factory:accept" }] }] }))).toBe(true);
  });
  it("an answer is confirmed when the request stops waiting on one", () => {
    expect(isConfirmed("answered:wi_1", data({ open: [{ work_item: "wi_1", status: "needs_info" }] }))).toBe(false);
    expect(isConfirmed("answered:wi_1", data({ open: [{ work_item: "wi_1", status: "queued" }] }))).toBe(true);
  });
  it("a decided rule is no longer pending", () => {
    expect(isConfirmed("candidate-decided:c1", data({ pendingCandidates: ["c1"] }))).toBe(false);
    expect(isConfirmed("candidate-decided:c1", data({ pendingCandidates: [] }))).toBe(true);
  });
});

describe("sweep", () => {
  it("holds an unconfirmed key for 60 seconds, then lets go of it and says it timed out", () => {
    const held = { "pr-gone:5": 0 };
    const still = data({ pulls: [{ number: 5 }] });
    expect(sweep(held, 59_000, still)).toEqual({ held, timedOut: [] });
    expect(sweep(held, 60_000, still)).toEqual({ held: {}, timedOut: ["pr-gone:5"] });
  });
  it("drops a confirmed key silently, even before the minute is up", () => {
    expect(sweep({ "pr-gone:5": 0 }, 5_000, data())).toEqual({ held: {}, timedOut: [] });
  });
});
