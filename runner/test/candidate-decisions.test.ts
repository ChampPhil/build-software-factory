import { describe, it, expect } from "vitest";
import { overlay, candidateRequest, decideCandidate, DECISIONS_PATH, type DecisionsFile } from "../src/commands/candidate-decisions.js";
import { candidateDecision } from "../src/commands/intake-run.js";

const cands = [
  { id: "c1", problem_class: "fetch bypasses apiClient", occurrences: 3, sources: [{ quote: "use apiClient" }, {}], status: "pending" },
  { id: "c2", problem_class: "console.log left in", status: "pending" },
];

describe("candidate decisions", () => {
  it("lays decisions over stored status", () => {
    const file: DecisionsFile = { schema: "candidate-decisions/1", decisions: { c1: { status: "rejected", by: "p", at: "t" } } };
    expect(overlay(cands, file).map((c) => c.status)).toEqual(["rejected", "pending"]);
    expect(overlay(cands, null)).toEqual(cands);
  });

  it("turns an accepted candidate into the request hardening reads", () => {
    const r = candidateRequest(cands[0]!);
    expect(r.title).toBe("Candidate: fetch bypasses apiClient");
    expect(r.body).toContain("> use apiClient");
    expect(r.body).toContain("Candidate: c1");
  });

  it("reads the dashboard's dispatch", () => {
    const p = (kind: string, title = "c1") => ({ inputs: { kind, title }, sender: { login: "philip" } });
    expect(candidateDecision("workflow_dispatch", p("candidate_accept"))).toEqual({ id: "c1", status: "accepted", by: "philip" });
    expect(candidateDecision("workflow_dispatch", p("candidate_reject"))).toEqual({ id: "c1", status: "rejected", by: "philip" });
    expect(candidateDecision("workflow_dispatch", p("correction"))).toBeNull();
    expect(candidateDecision("issues", p("candidate_accept"))).toBeNull();
    expect(candidateDecision("workflow_dispatch", p("candidate_accept", " "))).toBeNull();
  });

  it("records nothing for a candidate that is not in the repo's file", async () => {
    const gh = { defaultBranch: async () => "main", fileAtRef: async () => JSON.stringify({ candidates: [cands[0]] }), repo: "o/r" } as never;
    const res = await decideCandidate({ gh, id: "nope", status: "rejected", by: "p", now: "t" });
    expect(res).toEqual({ candidate: null, commit: null });
    expect(DECISIONS_PATH).toBe("guardrails/candidate-decisions.json");
  });
});
