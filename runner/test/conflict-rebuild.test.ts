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
