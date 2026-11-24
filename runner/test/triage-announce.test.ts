import { describe, it, expect } from "vitest";
import { triageMessage, triageProblems, announceTriage } from "../src/commands/run-lifecycle.js";
import type { GitHub as GitHubLike } from "../src/lib/github.js";

/**
 * The live install's first feature request died here. Triage decided it needed
 * one question answered, recorded `needs_info` on the work item, and then its
 * own job failed before the comment went out. The author saw an
 * acknowledgement and then nothing at all — which reads, correctly, as the
 * factory having silently given up.
 *
 * So the factory renders and posts the outcome itself, from the recorded
 * result, and never relies on the agent remembering a second action.
 */

function fake(comments: { body?: string }[] = []) {
  const posted: { path: string; body: unknown }[] = [];
  const gh = {
    repo: "owner/repo",
    get: async (path: string) => {
      if (path.includes("/comments")) return comments;
      throw new Error(`unexpected ${path}`);
    },
    send: async (_method: string, path: string, body: unknown) => {
      posted.push({ path, body });
      return {};
    },
  } as unknown as GitHubLike;
  return { gh, posted };
}

describe("a triage outcome that stops the run", () => {
  it("requires the question it is going to ask", () => {
    // Without this the factory would post "needs_info" with nothing in it.
    expect(triageProblems({ outcome: "needs_info", reason: "unclear" })).toContain(
      "needs_info names the one question to ask the author, in question",
    );
    expect(triageProblems({ outcome: "needs_info", reason: "unclear", question: "Which page?" })).toEqual([]);
  });

  it("asks the question in the author's words, not the factory's jargon", () => {
    const m = triageMessage({ outcome: "needs_info", reason: "ambiguous", question: "Which screen did you mean?" });
    expect(m).toContain("Which screen did you mean?");
    expect(m).not.toContain("needs_info");
    expect(m).not.toContain("work item");
  });

  for (const outcome of ["needs_info", "out_of_scope", "duplicate"] as const) {
    it(`says something for ${outcome}, because all three end the run`, async () => {
      const { gh, posted } = fake();
      const said = await announceTriage(gh, "wi_01M838E95ZX1Z6BP5CH4JQN799", "#8", {
        outcome,
        reason: "a reason",
        question: "a question",
      });
      expect(said).toBe(true);
      const comment = posted.find((p) => p.path.endsWith("/issues/8/comments"));
      expect(comment, `${outcome} posted no comment`).toBeDefined();
      expect(posted.some((p) => p.path.endsWith("/issues/8/labels"))).toBe(true);
    });
  }

  it("says nothing twice, so the run's own call and the safety net can both fire", async () => {
    const marker = "<!-- bsf:triage:wi_01M838E95ZX1Z6BP5CH4JQN799 -->";
    const { gh, posted } = fake([{ body: `**One question before I start.**\n\nWhich screen?\n\n${marker}` }]);
    const said = await announceTriage(gh, "wi_01M838E95ZX1Z6BP5CH4JQN799", "#8", {
      outcome: "needs_info",
      reason: "r",
      question: "Which screen?",
    });
    expect(said).toBe(false);
    expect(posted).toEqual([]);
  });

  it("stays quiet for proceed, and when the request has no thread", async () => {
    const a = fake();
    expect(await announceTriage(a.gh, "wi_1", "#8", { outcome: "proceed", reason: "fine" })).toBe(false);
    const b = fake();
    expect(await announceTriage(b.gh, "wi_1", null, { outcome: "out_of_scope", reason: "no" })).toBe(false);
    expect(b.posted).toEqual([]);
  });
});
