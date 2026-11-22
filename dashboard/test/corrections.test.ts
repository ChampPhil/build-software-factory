import { describe, it, expect } from "vitest";
import { GitHubClient } from "../lib/github.js";
import { correctionCandidates, correctionsOf, overlayDecisions, quoteOf, sourceLink, whereOf, CORRECTION_READ_CAP } from "../lib/corrections.js";
import type { CandidatesFile, WorkItemDoc } from "../lib/types.js";

const item = (over: Partial<WorkItemDoc> = {}): WorkItemDoc => ({
  id: "wi_1", created_at: "2026-11-22T10:00:00Z", pipeline: "hardening", title: "Correction on #7: use apiClient", status: "queued", pr: null, parent: "wi_0",
  body: "A person corrected the factory: a review comment from @philip on #7.\n\n> Please use apiClient.\n> Not fetch.\n\nSource: https://github.com/o/r/pull/7#c1\nThe run it corrects belongs to wi_0.",
  source: { kind: "correction", ref: "#7", actor: "philip" }, ...over,
});

describe("the corrections list", () => {
  it("keeps only hardening items a correction started, newest first", () => {
    const out = correctionsOf([
      item({ id: "a", created_at: "2026-11-20T00:00:00Z" }),
      item({ id: "b", created_at: "2026-11-22T00:00:00Z" }),
      item({ id: "c", pipeline: "product_work" }),
      item({ id: "d", source: { kind: "schedule", ref: null, actor: "factory" } }),
    ]);
    expect(out.map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("opens every open hardening item, then the most recent others, up to a cap", () => {
    const open = [{ work_item: "h1", pipeline: "hardening" as const, status: "queued" }, { work_item: "p1", pipeline: "product_work" as const, status: "queued" }];
    const recent = Array.from({ length: 40 }, (_, i) => ({ work_item: `r${i}`, status: "merged" }));
    const ids = correctionCandidates(open, recent);
    expect(ids[0]).toBe("h1");
    expect(ids).not.toContain("p1");
    expect(ids).toHaveLength(CORRECTION_READ_CAP);
  });

  it("reads the person's words, their link and where it was said", () => {
    expect(quoteOf(item().body)).toBe("Please use apiClient. Not fetch.");
    expect(sourceLink(item().body)).toBe("https://github.com/o/r/pull/7#c1");
    expect(sourceLink(null)).toBeNull();
    expect(whereOf(item())).toBe("PR #7");
    expect(whereOf(item({ source: { kind: "correction", ref: null, actor: "p" } }))).toBe("a local session");
    expect(whereOf(item({ source: { kind: "correction", ref: "candidate:cand_1", actor: "p" } }))).toBe("a candidate accepted on the dashboard");
  });
});

describe("candidates and what people decided", () => {
  const file: CandidatesFile = {
    schema: "candidates/1",
    candidates: [
      { id: "c1", problem_class: "fetch bypasses apiClient", occurrences: 3, sources: [{ kind: "agent_chat" }], proposed_fix: "api_change", status: "pending" },
      { id: "c2", problem_class: "console.log left in", occurrences: 1, sources: [{ kind: "agent_chat" }], proposed_fix: "static_rule", status: "pending" },
    ],
  };
  it("lays a decision over the stored status", () => {
    const out = overlayDecisions(file, { schema: "candidate-decisions/1", decisions: { c1: { status: "rejected", by: "p", at: "t" } } })!;
    expect(out.candidates.map((c) => c.status)).toEqual(["rejected", "pending"]);
  });
  it("changes nothing without decisions", () => {
    expect(overlayDecisions(file, null)).toBe(file);
    expect(overlayDecisions(null, null)).toBeNull();
  });
});

describe("the client's reads and decisions", () => {
  const auth = { token: "github_pat_test", repo: "owner/name" };
  it("reads a repo file from the default branch, not the data ref", async () => {
    const urls: string[] = [];
    const impl = async (input: string | URL | Request) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return new Response(JSON.stringify({ content: Buffer.from('{"ok":true}').toString("base64") }), { status: 200 });
    };
    const got = await new GitHubClient(auth, impl).fileFromRepo<{ ok: boolean }>(".factory/guardrails/candidates.json");
    expect(got).toEqual({ ok: true });
    expect(urls[0]).toContain("contents/.factory/guardrails/candidates.json");
    expect(urls[0]).not.toContain("ref=");
  });

  it("sends a decision to the factory's intake on the default branch", async () => {
    const calls: { url: string; body: string }[] = [];
    const impl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      return url.endsWith("owner/name") ? new Response(JSON.stringify({ default_branch: "trunk" }), { status: 200 }) : new Response(null, { status: 204 });
    };
    await new GitHubClient(auth, impl).decideCandidate("cand_1", "reject");
    const dispatch = calls.find((c) => c.url.includes("/dispatches"))!;
    expect(dispatch.url).toContain("workflows/factory-intake.yml/dispatches");
    expect(JSON.parse(dispatch.body)).toEqual({ ref: "trunk", inputs: { kind: "candidate_reject", title: "cand_1" } });
  });
});
