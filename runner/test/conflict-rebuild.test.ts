import { describe, it, expect } from "vitest";
import { sameChange } from "../src/commands/policy-run.js";

const f = (filename: string, patch: string) => ({ filename, patch });

describe("an approval carries to a rebuilt PR only when the change is the same", () => {
  // ts-webapp#33 conflicted after #19 merged into the same files. The rebuild
  // re-applies #33 on top of #19; the person approved #33 once and should not
  // have to again unless the rebuild changes something they did not see.
  const approved = [
    f("app/invoices/page.tsx", "@@ -10,3 +10,5 @@\n const rows = invoices;\n-const title = 'Invoices';\n+const title = 'Invoices';\n+const filter = useStatusFilter();\n+const shown = rows.filter(filter);"),
  ];

  it("carries when the rebuild adds the same lines and removes only what was approved", () => {
    const rebuilt = [
      f("app/invoices/page.tsx", "@@ -14,3 +14,5 @@\n const total = sum(rows);\n-const title = 'Invoices';\n+const title = 'Invoices';\n+const filter = useStatusFilter();\n+const shown = rows.filter(filter);"),
    ];
    expect(sameChange(approved, rebuilt)).toEqual({ same: true, why: "the same lines are added and nothing new is removed" });
  });

  it("does not carry when the rebuild removes something main added since", () => {
    const rebuilt = [
      f("app/invoices/page.tsx", "@@ -14,3 +14,4 @@\n-const total = sum(rows);\n-const title = 'Invoices';\n+const title = 'Invoices';\n+const filter = useStatusFilter();\n+const shown = rows.filter(filter);"),
    ];
    expect(sameChange(approved, rebuilt).same).toBe(false);
  });

  it("does not carry when the rebuild adds a line, or touches another file", () => {
    const extra = [f("app/invoices/page.tsx", approved[0]!.patch + "\n+console.log(shown);")];
    expect(sameChange(approved, extra).why).toMatch(/adds different lines/);
    expect(sameChange(approved, [...approved, f("lib/x.ts", "+y")]).why).toMatch(/different set of files/);
  });

  it("does not carry when GitHub left a patch out", () => {
    expect(sameChange(approved, [{ filename: "app/invoices/page.tsx" }]).same).toBe(false);
  });
});

describe("factory/policy when only an approval is missing", async () => {
  const { awaitingApproval, summarize } = await import("../src/commands/policy-run.js");
  const fail = (kinds: string[]) => ({
    conclusion: "failure" as const,
    failures: kinds.map((kind) => ({ kind, message: "m", files: [".factory/sandbox/manifest.json"] })),
    notes: [],
  });

  it("waits (yellow) when a trusted approval is all it lacks, so a fine PR never shows red", () => {
    expect(awaitingApproval(fail(["protected_path"]) as never)).toBe(true);
    expect(awaitingApproval(fail(["protected_path", "definition_without_approval"]) as never)).toBe(true);
    expect(summarize(fail(["protected_path"]) as never)).toMatch(/Nothing is wrong with this PR/);
  });

  it("fails (red) when anything else is wrong too", () => {
    expect(awaitingApproval(fail(["protected_path", "path_not_allowed_for_pipeline"]) as never)).toBe(false);
    expect(awaitingApproval(fail(["undeclared_test_edit"]) as never)).toBe(false);
  });
});

describe("the factory/conflicts check's button", async () => {
  const { conflictCheck } = await import("../src/commands/conflicts.js");
  it("fits GitHub's limits: label 20 characters, description 40", async () => {
    let body: { actions: { label: string; description: string; identifier: string }[] } | undefined;
    const gh = {
      repo: "o/r",
      pull: async () => ({ head: { sha: "abc" } }),
      send: async (_m: string, _p: string, b: unknown) => { body = b as typeof body; },
    } as never;
    await conflictCheck(gh, 33);
    for (const a of body!.actions) {
      expect(a.label.length).toBeLessThanOrEqual(20);
      expect(a.description.length).toBeLessThanOrEqual(40);
      expect(a.identifier.length).toBeLessThanOrEqual(20);
    }
  });
});

/**
 * Rebuilding every conflicting PR at once rebuilds them all against the same
 * main. Each new PR is clean against main and conflicts with its siblings, so
 * the first to merge sends the rest back for another rebuild — five PRs on one
 * file can cost twenty builder runs that way. One at a time costs five, and
 * the queue drains itself: a rebuild that lands is a push to main, which is
 * this scan's trigger, and factory-conflicts has an hourly schedule for when
 * one never lands.
 */
describe("the order rebuilds go out in", async () => {
  const { rebuildOrder } = await import("../src/commands/conflicts.js");
  const c = (work_item: string, pr: number) => ({ work_item, pr });

  it("takes the oldest work item first", () => {
    const order = rebuildOrder(
      [c("wi-3", 30), c("wi-1", 10), c("wi-2", 20)],
      new Map([
        ["wi-1", "2026-11-01T00:00:00Z"],
        ["wi-2", "2026-11-02T00:00:00Z"],
        ["wi-3", "2026-11-03T00:00:00Z"],
      ]),
    );
    expect(order.map((o) => o.work_item)).toEqual(["wi-1", "wi-2", "wi-3"]);
  });

  it("goes by age, not by PR number, when the two disagree", () => {
    // An item queued long ago can get a high PR number after a rebuild or two,
    // and it is still the one that has waited longest.
    const order = rebuildOrder(
      [c("wi-new", 50), c("wi-old", 90)],
      new Map([
        ["wi-new", "2026-11-20T00:00:00Z"],
        ["wi-old", "2026-11-01T00:00:00Z"],
      ]),
    );
    expect(order[0]?.work_item).toBe("wi-old");
  });

  it("falls back to the PR number, which rises with time", () => {
    const order = rebuildOrder([c("wi-b", 44), c("wi-a", 12)], new Map());
    expect(order.map((o) => o.work_item)).toEqual(["wi-a", "wi-b"]);
  });

  it("puts an item with a timestamp ahead of one with none", () => {
    const order = rebuildOrder([c("wi-none", 5), c("wi-dated", 99)], new Map([["wi-dated", "2026-11-01T00:00:00Z"]]));
    expect(order[0]?.work_item).toBe("wi-dated");
  });

  it("is the same on every scan, so nothing is starved by a tie", () => {
    const items = [c("wi-b", 7), c("wi-a", 7), c("wi-c", 7)];
    const once = rebuildOrder(items, new Map()).map((o) => o.work_item);
    const again = rebuildOrder([...items].reverse(), new Map()).map((o) => o.work_item);
    expect(once).toEqual(["wi-a", "wi-b", "wi-c"]);
    expect(again).toEqual(once);
  });

  it("leaves the caller's list alone", () => {
    const items = [c("wi-b", 20), c("wi-a", 10)];
    rebuildOrder(items, new Map());
    expect(items.map((o) => o.work_item)).toEqual(["wi-b", "wi-a"]);
  });
});

describe("what a queued PR is told", async () => {
  const { conflictCheck } = await import("../src/commands/conflicts.js");

  const titleAndSummary = async (ahead?: number) => {
    let body: { output: { title: string; summary: string } } | undefined;
    const gh = {
      repo: "o/r",
      pull: async () => ({ head: { sha: "abc" } }),
      send: async (_m: string, _p: string, b: unknown) => { body = b as typeof body; },
    } as never;
    await conflictCheck(gh, 33, ahead);
    return body!.output;
  };

  it("says it is being rebuilt when it is the one going out", async () => {
    const out = await titleAndSummary();
    expect(out.title).toMatch(/rebuilding on main/i);
    expect(out.summary).not.toMatch(/queued/i);
  });

  it("says how many are ahead of it when it is waiting", async () => {
    // A PR that conflicts and says nothing reads as forgotten.
    expect((await titleAndSummary(1)).title).toMatch(/queued behind 1 other rebuild\b/);
    expect((await titleAndSummary(3)).title).toMatch(/queued behind 3 other rebuilds\b/);
  });

  it("explains why it is waiting rather than just that it is", async () => {
    expect((await titleAndSummary(2)).summary).toMatch(/one change at a time/i);
  });

  it("offers the button either way, for someone who will not wait", async () => {
    let body: { actions: { identifier: string }[] } | undefined;
    const gh = {
      repo: "o/r",
      pull: async () => ({ head: { sha: "abc" } }),
      send: async (_m: string, _p: string, b: unknown) => { body = b as typeof body; },
    } as never;
    await conflictCheck(gh, 33, 2);
    expect(body!.actions.map((a) => a.identifier)).toEqual(["rebuild"]);
  });

  it("keeps the approval-carries-over promise on both", async () => {
    for (const ahead of [undefined, 2]) {
      expect((await titleAndSummary(ahead)).summary).toMatch(/approval given here carries over/i);
    }
  });
});
