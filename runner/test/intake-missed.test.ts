import { describe, it, expect } from "vitest";
import { missedIssues, ulidTime } from "../src/commands/intake-run.js";
import { workItemId } from "../src/lib/ids.js";

const NOW = "2026-11-21T17:00:00Z";
const issue = (number: number, created: string, extra: Record<string, unknown> = {}) => ({
  number, title: `Issue ${number}`, body: "b", created_at: created, author_association: "OWNER", user: { login: "ChampPhil", type: "User" }, labels: [], ...extra,
});

function fakes(issues: unknown[], items: Record<string, { source: { ref: string } }>) {
  const gh = {
    repo: "o/r",
    get: async (p: string) => (p.includes("/issues?") ? issues : p.includes("/collaborators/") ? { permission: "admin" } : {}),
  } as never;
  const store = {
    data: {
      list: async () => Object.keys(items),
      readJson: async (p: string) => items[p] ?? null,
    },
  } as never;
  return { gh, store };
}

describe("intake recovers issues whose own run was dropped", () => {
  // ts-webapp #37-#39 were opened together; GitHub kept one pending intake
  // run and cancelled two, so #38 and #39 never became work items.
  it("files the open issues from the last day that nothing knows about", async () => {
    const id37 = workItemId(Date.parse("2026-11-21T16:54:00Z"));
    const { gh, store } = fakes(
      [issue(39, "2026-11-21T16:53:30Z"), issue(38, "2026-11-21T16:53:20Z"), issue(37, "2026-11-21T16:53:10Z"), issue(5, "2026-11-10T00:00:00Z")],
      { [`work-items/${id37}.json`]: { source: { ref: "#37" } } },
    );
    const got = await missedIssues(gh, store, [], { open: [] }, NOW, ["OWNER", "MEMBER", "COLLABORATOR"]);
    expect(got.map((e) => e.ref)).toEqual(["#39", "#38"]);
    expect(new Set(got.map((e) => e.id)).size).toBe(2);
    expect(got[0]!.kind).toBe("issue_opened");
  });

  it("leaves out pull requests, bots' issues, and ones already queued or open", async () => {
    const { gh, store } = fakes(
      [
        issue(40, "2026-11-21T16:00:00Z", { pull_request: {} }),
        issue(41, "2026-11-21T16:00:00Z", { user: { login: "factory[bot]", type: "Bot" } }),
        issue(42, "2026-11-21T16:00:00Z"),
        issue(43, "2026-11-21T16:00:00Z"),
      ],
      {},
    );
    const got = await missedIssues(gh, store, [{ ref: "#42" } as never], { open: [{ source_ref: "#43" }] }, NOW, ["OWNER"]);
    expect(got).toEqual([]);
  });

  it("reads the time out of a work item id", () => {
    expect(ulidTime(workItemId(Date.parse(NOW)))).toBe(Date.parse(NOW));
    expect(ulidTime("not-an-id")).toBeNull();
  });
});
