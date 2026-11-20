import { describe, it, expect } from "vitest";
import { countInteractions, fetchInteractions, type InteractionInput } from "../src/commands/interactions.js";

const base: InteractionInput = {
  issueComments: [],
  reviewComments: [],
  reviews: [],
  commits: [],
  prAuthor: "factory-app[bot]",
  appLogins: ["factory-app[bot]", "factory-recompiler[bot]"],
};

const user = (login: string) => ({ user: { login } });
const review = (login: string, state: string) => ({ user: { login }, state });
const commit = (login: string | null) => ({
  author: login === null ? null : { login },
  committer: login === null ? null : { login },
});

describe("countInteractions", () => {
  it("counts a person's comment", () => {
    const r = countInteractions({ ...base, issueComments: [user("philip")] });
    expect(r).toEqual({ comments: 1, change_requests: 0, human_commits: 0, total: 1 });
  });

  it("counts inline review comments too", () => {
    const r = countInteractions({ ...base, reviewComments: [user("philip"), user("dana")] });
    expect(r.comments).toBe(2);
  });

  it("counts a change request separately from a comment", () => {
    const r = countInteractions({
      ...base,
      reviews: [review("philip", "CHANGES_REQUESTED"), review("dana", "COMMENTED")],
    });
    expect(r.change_requests).toBe(1);
    expect(r.comments).toBe(1);
    expect(r.total).toBe(2);
  });

  it("does not count an approval, which is the gate working rather than steering", () => {
    const r = countInteractions({ ...base, reviews: [review("philip", "APPROVED")] });
    expect(r.total).toBe(0);
  });

  it("counts a human commit on the branch", () => {
    const r = countInteractions({ ...base, commits: [commit("philip"), commit("factory-app[bot]")] });
    expect(r.human_commits).toBe(1);
  });

  it("ignores the factory's own activity", () => {
    const r = countInteractions({
      ...base,
      issueComments: [user("factory-app[bot]"), user("factory-recompiler[bot]")],
      reviews: [review("factory-app[bot]", "CHANGES_REQUESTED")],
      commits: [commit("factory-app[bot]")],
    });
    expect(r.total).toBe(0);
  });

  it("ignores the PR's own author, whoever that is", () => {
    // On a factory run the author is the App; on a gardening run it may be a
    // different login. Either way its own commits are not steering.
    const r = countInteractions({
      ...base,
      prAuthor: "some-agent",
      commits: [commit("some-agent")],
      issueComments: [user("some-agent")],
    });
    expect(r.total).toBe(0);
  });

  it("ignores any other integration, not just the factory's apps", () => {
    const r = countInteractions({
      ...base,
      issueComments: [user("dependabot[bot]"), user("codecov[bot]")],
      commits: [commit("dependabot[bot]")],
    });
    expect(r.total).toBe(0);
  });

  it("is case-insensitive about logins", () => {
    const r = countInteractions({ ...base, issueComments: [user("Factory-App[Bot]")] });
    expect(r.total).toBe(0);
  });

  it("ignores an entry whose user GitHub no longer has", () => {
    // A deleted account comes back as null, which is not a person steering.
    const r = countInteractions({
      ...base,
      issueComments: [{ user: null }],
      commits: [commit(null)],
    });
    expect(r.total).toBe(0);
  });

  it("adds the three kinds into the total", () => {
    const r = countInteractions({
      ...base,
      issueComments: [user("philip")],
      reviews: [review("philip", "CHANGES_REQUESTED"), review("dana", "COMMENTED")],
      commits: [commit("philip"), commit("dana")],
    });
    expect(r).toEqual({ comments: 2, change_requests: 1, human_commits: 2, total: 5 });
  });
});

describe("fetchInteractions", () => {
  it("reads all four lists and counts them", async () => {
    const asked: string[] = [];
    const gh = {
      repo: "owner/repo",
      get: async (path: string) => {
        asked.push(path.split("?")[0] ?? path);
        if (path.includes("/issues/")) return [user("philip")];
        if (path.includes("/comments")) return [user("dana")];
        if (path.includes("/reviews")) return [review("philip", "CHANGES_REQUESTED")];
        if (path.includes("/commits")) return [commit("philip")];
        return [];
      },
    };
    const r = await fetchInteractions({
      gh: gh as never,
      pr: 4,
      prAuthor: "factory-app[bot]",
      appLogins: ["factory-app[bot]"],
    });
    expect(r).toEqual({ comments: 2, change_requests: 1, human_commits: 1, total: 4 });
    expect(asked).toHaveLength(4);
  });

  it("returns null rather than throwing, so a metric never fails a merge", async () => {
    const gh = {
      repo: "owner/repo",
      get: async () => {
        throw new Error("403");
      },
    };
    const r = await fetchInteractions({ gh: gh as never, pr: 4, prAuthor: "x", appLogins: [] });
    // Absent, which the rollup reads as not measured rather than as zero.
    expect(r).toBeNull();
  });
});
