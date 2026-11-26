import { describe, expect, it } from "vitest";
import { expired, runAction } from "../lib/optimistic";

const deps = () => {
  const said: string[] = [];
  let refreshed = 0;
  return { said, get refreshed() { return refreshed; }, say: (t: string) => said.push(t), refresh: () => { refreshed++; } };
};

describe("runAction", () => {
  it("applies at once, says Saving then the result", async () => {
    const d = deps();
    let state = "open";
    const ok = await runAction(async () => undefined, "Closed.", d, { apply: () => { state = "closed"; }, rollback: () => { state = "open"; } }, String);
    expect(ok).toBe(true);
    expect(state).toBe("closed");
    expect(d.said).toEqual(["Saving…", "Closed."]);
    expect(d.refreshed).toBe(1);
  });
  it("rolls back and names the reason when it fails", async () => {
    const d = deps();
    let state = "open";
    const ok = await runAction(async () => { throw new Error("403"); }, "Closed.", d, { apply: () => { state = "closed"; }, rollback: () => { state = "open"; } }, (e) => (e as Error).message);
    expect(ok).toBe(false);
    expect(state).toBe("open");
    expect(d.said).toEqual(["Saving…", "Could not do that: 403"]);
  });
  it("holds an optimistic state for 60 seconds", () => {
    expect(expired(0, 59_000)).toBe(false);
    expect(expired(0, 60_000)).toBe(true);
  });
});
