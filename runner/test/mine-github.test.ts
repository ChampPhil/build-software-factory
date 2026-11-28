import { describe, it, expect } from "vitest";
import { findAppliedReviews, findClosedBugs, parseGhJson, repoSlug } from "../src/commands/mine-github.js";

describe("repoSlug", () => {
  it("reads owner and name from an https or ssh remote", () => {
    expect(repoSlug("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repoSlug("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repoSlug("https://gitlab.com/acme/app.git")).toBeNull();
  });
});

describe("parseGhJson", () => {
  it("reads one array or several pages", () => {
    expect(parseGhJson<{ n: number }>("")).toEqual([]);
    expect(parseGhJson<{ n: number }>('[{"n":1}]')).toEqual([{ n: 1 }]);
    expect(parseGhJson<{ n: number }>('[{"n":1}]\n[{"n":2}]')).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("findAppliedReviews", () => {
  it("keeps a comment whose file changed afterwards and drops one whose file did not", async () => {
    const gh = async (args: readonly string[]): Promise<string> => {
      const joined = args.join(" ");
      if (joined.includes("pulls/comments")) {
        return JSON.stringify([
          {
            id: 1,
            body: "Don't open the database from the browser, call the API.",
            path: "web/page.tsx",
            created_at: "2026-01-02T00:00:00Z",
            pull_request_url: "https://api.github.com/repos/acme/app/pulls/4",
          },
          {
            id: 2,
            body: "Please rename this local variable.",
            path: "web/other.tsx",
            created_at: "2026-01-02T00:00:00Z",
            pull_request_url: "https://api.github.com/repos/acme/app/pulls/4",
          },
        ]);
      }
      if (joined.includes("pulls/4/commits")) {
        return JSON.stringify([{ sha: "abc", commit: { committer: { date: "2026-01-03T00:00:00Z" } } }]);
      }
      return "[]";
    };
    const reviews = await findAppliedReviews({
      repo: "acme/app",
      gh,
      filesInCommit: () => ["web/page.tsx"],
    });
    expect(reviews.map((r) => r.id)).toEqual(["review:1"]);
  });
});

describe("findClosedBugs", () => {
  it("keeps a bug issue whose timeline names a commit", async () => {
    const gh = async (args: readonly string[]): Promise<string> => {
      if (args.includes("issue")) {
        return JSON.stringify([{ number: 9, title: "Invoice total is off when tax is zero" }]);
      }
      if (args.join(" ").includes("issues/9/timeline")) {
        return JSON.stringify([{ event: "closed", commit_id: "deadbeef" }]);
      }
      return "[]";
    };
    const bugs = await findClosedBugs({ repo: "acme/app", gh });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]?.commit).toBe("deadbeef");
  });

  it("treats a missing bug label as an empty search", async () => {
    const gh = async (): Promise<string> => {
      throw new Error("label bug not found");
    };
    expect(await findClosedBugs({ repo: "acme/app", gh })).toEqual([]);
  });
});
