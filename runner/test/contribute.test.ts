import { describe, it, expect } from "vitest";
import {
  classKey,
  mergeContribution,
  contributionBranch,
  contributionBody,
  submitContribution,
  type Contribution,
} from "../src/commands/contribute.js";
import { validate } from "../src/lib/schema.js";
import type { Candidate, CandidatesFile } from "../src/lib/types.js";

const id = (n: string) => `cand_01JDF8YQKX7M3N2PQRS4TVWX${n}`;

function cand(over: Partial<Candidate> & { id: string; problem_class: string }): Candidate {
  return {
    occurrences: 1,
    sources: [{ kind: "agent_chat", harness: "claude-code", session: "s1", quote: "no, not like that" }],
    proposed_fix: "static_rule",
    status: "pending",
    ...over,
  };
}

const empty: CandidatesFile = { schema: "candidates/1", candidates: [] };

describe("classKey", () => {
  it("matches the same complaint written two ways", () => {
    expect(classKey("Network calls must go through apiClient, not raw fetch")).toBe(
      classKey("not raw fetch — network calls must go through apiClient!"),
    );
  });

  it("does not match two different complaints", () => {
    expect(classKey("network calls go through apiClient")).not.toBe(
      classKey("invoice totals computed in cents"),
    );
  });

  it("ignores the filler words that make two phrasings look different", () => {
    // "for" and "the" carry no signal, and keeping them made one machine's
    // contribution a duplicate of a candidate already on the list.
    expect(classKey("must use apiClient for network calls")).toBe(
      classKey("network calls must use the apiClient"),
    );
  });
});

describe("mergeContribution", () => {
  it("adds a candidate nobody has raised, stamped with who sent it", () => {
    const r = mergeContribution(empty, [cand({ id: id("01"), problem_class: "raw fetch" })], "dana");
    expect(r.added).toHaveLength(1);
    expect(r.added[0]?.contributed_by).toBe("dana");
    expect(r.merged.candidates).toHaveLength(1);
  });

  it("leaves contributed_by off when there is no login to record", () => {
    const r = mergeContribution(empty, [cand({ id: id("01"), problem_class: "raw fetch" })], null);
    expect(r.added[0]).not.toHaveProperty("contributed_by");
  });

  it("folds a problem already pending into the existing candidate", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [cand({ id: id("AA"), problem_class: "network calls must use apiClient", occurrences: 4 })],
    };
    const r = mergeContribution(
      existing,
      [cand({ id: id("BB"), problem_class: "must use apiClient for network calls", occurrences: 3 })],
      "dana",
    );
    // One candidate with seven occurrences, not two candidates for one problem.
    expect(r.merged.candidates).toHaveLength(1);
    expect(r.merged.candidates[0]?.occurrences).toBe(7);
    expect(r.added).toEqual([]);
    expect(r.folded).toEqual([{ into: id("AA"), occurrences: 3 }]);
  });

  it("keeps both sides' quotes when it folds, up to a cap", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ kind: "agent_chat" as const, quote: `q${i}` }));
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [{ ...cand({ id: id("AA"), problem_class: "apiClient" }), sources: many(6) }],
    };
    const r = mergeContribution(
      existing,
      [{ ...cand({ id: id("BB"), problem_class: "apiClient" }), sources: many(6) }],
      "dana",
    );
    expect(r.merged.candidates[0]?.sources).toHaveLength(8);
    expect(r.merged.candidates[0]?.sources[0]?.quote).toBe("q0");
  });

  it("widens the first and last seen window across both", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [
        cand({
          id: id("AA"),
          problem_class: "apiClient",
          first_seen: "2026-05-01T00:00:00Z",
          last_seen: "2026-06-01T00:00:00Z",
        }),
      ],
    };
    const r = mergeContribution(
      existing,
      [
        cand({
          id: id("BB"),
          problem_class: "apiClient",
          first_seen: "2026-03-01T00:00:00Z",
          last_seen: "2026-09-01T00:00:00Z",
        }),
      ],
      "dana",
    );
    expect(r.merged.candidates[0]?.first_seen).toBe("2026-03-01T00:00:00Z");
    expect(r.merged.candidates[0]?.last_seen).toBe("2026-09-01T00:00:00Z");
  });

  it("does not reopen a candidate the team rejected", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [cand({ id: id("AA"), problem_class: "apiClient", status: "rejected" })],
    };
    const r = mergeContribution(existing, [cand({ id: id("BB"), problem_class: "apiClient" })], "dana");
    expect(r.added).toEqual([]);
    expect(r.folded).toEqual([]);
    expect(r.skipped).toEqual([{ problem_class: "apiClient", status: "rejected" }]);
    expect(r.merged.candidates[0]?.status).toBe("rejected");
  });

  it("does not raise one that is already installed", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [cand({ id: id("AA"), problem_class: "apiClient", status: "installed" })],
    };
    const r = mergeContribution(existing, [cand({ id: id("BB"), problem_class: "apiClient" })], "dana");
    expect(r.skipped[0]?.status).toBe("installed");
  });

  it("never drops or edits a candidate that was already there", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [
        cand({ id: id("AA"), problem_class: "one", status: "accepted" }),
        cand({ id: id("BB"), problem_class: "two" }),
        cand({ id: id("CC"), problem_class: "three", status: "installed", installed_as: "rules/x.yaml" }),
      ],
    };
    const r = mergeContribution(existing, [cand({ id: id("DD"), problem_class: "four" })], "dana");
    expect(r.merged.candidates.slice(0, 3)).toEqual(existing.candidates);
  });

  it("produces a file that validates against the schema", () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [cand({ id: id("AA"), problem_class: "apiClient", occurrences: 2 })],
    };
    const r = mergeContribution(
      existing,
      [
        cand({ id: id("BB"), problem_class: "apiClient" }),
        cand({ id: id("CC"), problem_class: "cents not floats", proposed_fix: "verification" }),
      ],
      "dana",
    );
    const res = validate("candidates", r.merged);
    expect(res.ok, JSON.stringify(res.ok ? [] : res.errors)).toBe(true);
  });

  it("two contributions of the same thing in one batch become one candidate", () => {
    const r = mergeContribution(
      empty,
      [
        cand({ id: id("01"), problem_class: "raw fetch is wrong", occurrences: 2 }),
        cand({ id: id("02"), problem_class: "wrong: raw fetch", occurrences: 5 }),
      ],
      "dana",
    );
    expect(r.merged.candidates).toHaveLength(1);
    expect(r.merged.candidates[0]?.occurrences).toBe(7);
  });
});

describe("contributionBranch", () => {
  it("carries who and when, and cannot collide with a second run", () => {
    const at = new Date("2026-11-20T10:00:00Z");
    const a = contributionBranch("ChampPhil", at);
    const b = contributionBranch("ChampPhil", at);
    expect(a).toMatch(/^factory\/corrections-champphil-2026-11-20-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });

  it("makes a branch name out of a login git would refuse", () => {
    const name = contributionBranch("Some.One/Weird~Name", new Date("2026-11-20T10:00:00Z"));
    expect(name).toMatch(/^factory\/corrections-[a-z0-9-]+-2026-11-20-[0-9a-f]{6}$/);
  });

  it("works with no login at all", () => {
    expect(contributionBranch(null, new Date("2026-11-20T10:00:00Z"))).toContain("-anon-");
  });
});

describe("contributionBody", () => {
  const merge = mergeContribution(
    { schema: "candidates/1", candidates: [cand({ id: id("AA"), problem_class: "apiClient" })] },
    [
      cand({ id: id("BB"), problem_class: "apiClient", occurrences: 3 }),
      cand({ id: id("CC"), problem_class: "totals in cents", proposed_fix: "verification" }),
    ],
    "dana",
  );
  const body = contributionBody(merge, "dana", "owner/repo");

  it("lists what is new, what was folded and what was skipped", () => {
    expect(body).toContain("1 new candidate");
    expect(body).toContain("totals in cents");
    expect(body).toContain("1 already on the list");
    expect(body).toContain(id("AA"));
  });

  it("says accepting a candidate installs nothing by itself", () => {
    expect(body).toContain("does not install anything by itself");
  });

  it("names the person to ask, because the quotes are theirs", () => {
    expect(body).toContain("@dana");
    expect(body).toContain("private agent sessions");
  });

  it("escapes a pipe so one problem class cannot break the table", () => {
    const m = mergeContribution(
      empty,
      [cand({ id: id("01"), problem_class: "use a || b, never a | b" })],
      "dana",
    );
    const row = contributionBody(m, "dana", "owner/repo")
      .split("\n")
      .find((l) => l.includes("never"));
    // Four unescaped pipes, like every other row: the cell's own pipes are
    // escaped rather than splitting it into extra columns.
    expect(row?.match(/(?<!\\)\|/g)).toHaveLength(4);
    expect(row).toContain("a \\| b");
  });
});

describe("submitContribution", () => {
  const contribution: Contribution = {
    schema: "contribution/1",
    repo: "owner/repo",
    mined_at: "2026-11-20T10:00:00Z",
    candidates: [cand({ id: id("01"), problem_class: "raw fetch" })],
  };

  function fakeGh(file: string | null) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    return {
      calls,
      gh: {
        defaultBranch: async () => "main",
        viewer: async () => "dana",
        fileAtRef: async () => file,
        openPull: async (opts: unknown) => {
          calls.push({ method: "POST", path: "pulls", body: opts });
          return { number: 12, html_url: "https://example.invalid/12" };
        },
      },
    };
  }

  it("submits nothing when every candidate was already decided", async () => {
    const existing: CandidatesFile = {
      schema: "candidates/1",
      candidates: [cand({ id: id("AA"), problem_class: "raw fetch", status: "rejected" })],
    };
    const { gh, calls } = fakeGh(JSON.stringify(existing));
    const gitCalls: string[][] = [];
    const res = await submitContribution({
      gh: gh as never,
      contribution,
      candidatesPath: ".factory/guardrails/candidates.json",
      repoPath: "/nowhere",
      git: async (args) => {
        gitCalls.push([...args]);
        if (args[0] === "show") return JSON.stringify(existing);
        return "";
      },
    });
    expect(res).toEqual({ nothing: "every candidate here was already decided (1); nothing to submit" });
    // Nothing pushed and no PR opened: it stops before touching the remote.
    expect(gitCalls.some((c) => c[0] === "push")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reads the list from the fetched base, not from the working tree", async () => {
    const { gh } = fakeGh(null);
    const gitCalls: string[][] = [];
    await submitContribution({
      gh: gh as never,
      contribution,
      candidatesPath: ".factory/guardrails/candidates.json",
      repoPath: "/nowhere",
      git: async (args) => {
        gitCalls.push([...args]);
        return "";
      },
    });
    expect(gitCalls[0]).toEqual(["fetch", "--quiet", "origin", "main"]);
    expect(gitCalls[1]).toEqual(["show", "origin/main:.factory/guardrails/candidates.json"]);
  });

  it("pushes a branch and opens one PR", async () => {
    const { gh, calls } = fakeGh(null);
    const gitCalls: string[][] = [];
    const res = await submitContribution({
      gh: gh as never,
      contribution,
      candidatesPath: ".factory/guardrails/candidates.json",
      repoPath: "/nowhere",
      git: async (args) => {
        gitCalls.push([...args]);
        return "";
      },
    });
    expect("pull" in res && res.pull).toBe(12);
    expect(gitCalls.filter((c) => c[0] === "push")).toHaveLength(1);
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as { head: string; base: string };
    expect(body.base).toBe("main");
    expect(body.head).toMatch(/^factory\/corrections-dana-/);
  });

  it("removes the worktree even when the push fails", async () => {
    const { gh } = fakeGh(null);
    const gitCalls: string[][] = [];
    await expect(
      submitContribution({
        gh: gh as never,
        contribution,
        candidatesPath: ".factory/guardrails/candidates.json",
        repoPath: "/nowhere",
        git: async (args) => {
          gitCalls.push([...args]);
          if (args[0] === "push") throw new Error("no write access");
          return "";
        },
      }),
    ).rejects.toThrow(/no write access/);
    // A left-behind worktree makes the next run fail on a local branch name.
    expect(gitCalls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(true);
  });

  it("says the branch is already pushed when opening the PR fails", async () => {
    const calls: unknown[] = [];
    const gh = {
      defaultBranch: async () => "main",
      viewer: async () => "dana",
      openPull: async () => {
        calls.push(1);
        throw new Error("403");
      },
    };
    await expect(
      submitContribution({
        gh: gh as never,
        contribution,
        candidatesPath: ".factory/guardrails/candidates.json",
        repoPath: "/nowhere",
        git: async () => "",
      }),
    ).rejects.toThrow(/was pushed, but opening the pull request failed/);
  });
});
