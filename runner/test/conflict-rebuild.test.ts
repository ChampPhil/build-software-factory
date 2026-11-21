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
