import { describe, it, expect } from "vitest";
import { render, drifting, empty, type Brainstorm } from "../src/commands/brainstorm.js";
import { triageProblems } from "../src/commands/run-lifecycle.js";

/**
 * A request arrives as a sentence, and the distance between what somebody
 * wrote and what they meant is where almost all wasted work comes from. One
 * question, asked once, was better than silence and nowhere near enough.
 *
 * The mechanism for a second turn already existed — intake puts an answered
 * item back in the queue. What was missing was memory: each run started from
 * nothing, so the second question read as though nobody had listened to the
 * first answer.
 */

const convo = (over: Partial<Brainstorm> = {}): Brainstorm => ({
  ...empty("wi_1"),
  turns: [
    { at: "2026-11-24T16:00:00Z", who: "factory", text: "What should someone be able to do that they cannot now?" },
    { at: "2026-11-24T16:05:00Z", who: "person", text: "See only the invoices nobody has paid." },
  ],
  ...over,
});

describe("handing the conversation to the next run", () => {
  it("says plainly when there is nothing yet, rather than looking broken", () => {
    const out = render(null);
    expect(out).toContain("No conversation yet");
    expect(render(empty("wi_1"))).toContain("No conversation yet");
  });

  it("reads as a conversation, because that is what the next run has to continue", () => {
    const out = render(convo());
    expect(out).toContain("You asked: What should someone be able to do");
    expect(out).toContain("They answered: See only the invoices nobody has paid.");
  });

  it("carries the playback forward, which is how far the conversation has got", () => {
    const out = render(convo({ understood: "Filter the invoice list to unpaid invoices." }));
    expect(out).toContain("did not correct");
    expect(out).toContain("Filter the invoice list to unpaid invoices.");
  });

  it("carries what is still open, so the next question is not a repeat", () => {
    expect(render(convo({ open: ["Does this apply to refunds?"] }))).toContain("Does this apply to refunds?");
  });
});

describe("knowing when to stop asking", () => {
  it("does not flag a conversation that is getting somewhere", () => {
    // There is deliberately no turn limit: a conversation that is converging
    // should not be cut off because it took six questions.
    expect(drifting(convo({ understood: "Settled." }))).toBe(false);
  });

  it("flags one that has asked and asked and understood nothing", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      at: "2026-11-24T16:00:00Z",
      who: "factory" as const,
      text: `question ${i}`,
    }));
    expect(drifting(convo({ turns, understood: null }))).toBe(true);
  });

  it("is quiet about a conversation that has not started", () => {
    expect(drifting(null)).toBe(false);
  });
});

describe("the outcome a conversation writes", () => {
  it("still demands the question it is going to ask", () => {
    expect(triageProblems({ outcome: "needs_info", reason: "unclear" })).toContain(
      "needs_info names the one question to ask the author, in question",
    );
  });

  it("accepts a playback alongside the question", () => {
    expect(
      triageProblems({
        outcome: "needs_info",
        reason: "unclear",
        question: "Does this apply to refunds?",
        understood: "Filter the invoice list to unpaid invoices.",
      }),
    ).toEqual([]);
  });

  it("accepts a settled playback on proceed, which is what spec reads", () => {
    expect(
      triageProblems({ outcome: "proceed", reason: "clear", understood: "Filter to unpaid invoices." }),
    ).toEqual([]);
  });
});
