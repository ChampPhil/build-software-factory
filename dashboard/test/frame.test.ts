import { describe, expect, it } from "vitest";
import { isFrameTurn, plain, questionOf, sentence } from "../lib/frame";

// Loaded by a path the type checker does not follow: the runner is checked
// under its own configuration, and this test only needs the function.
const RUNNER = new URL("../../runner/src/commands/brainstorm.ts", import.meta.url).href;
type Render = (frame: Record<string, unknown>, question: string) => string;
const { renderFrameTurn } = (await import(/* @vite-ignore */ RUNNER)) as { renderFrameTurn: Render };

/**
 * The runner writes the frame into the log as Markdown in an ordinary turn,
 * and the dashboard has to find it again. These run against the runner's own
 * renderer, so a change to its wording fails here rather than on someone's
 * screen as a wall of asterisks.
 */
describe("the frame turn", () => {
  const term = { term: "Payment schedule", means: "One invoice due in parts", names: "half now, half later", unlocks: "one invoice with two dates" };
  const question = "Should the second part have its own date?";

  it("is recognised in every shape the runner writes it", () => {
    for (const frame of [
      { named: "A payment schedule", terms: [term] },
      { terms: [term, { ...term, term: "Balance due" }] },
      { neighbors: [{ field: "Buy now, pay later", carries_over: "Split purchases", breaks_down: "A lender carries the risk" }] },
      { unmentioned: ["Tax on each part"] },
    ]) {
      const text = renderFrameTurn(frame, question);
      expect(isFrameTurn(text)).toBe(true);
      expect(questionOf(text)).toBe(question);
    }
  });

  it("is not confused with an ordinary question", () => {
    expect(isFrameTurn("Who decides the split, you or the client?")).toBe(false);
    expect(isFrameTurn("The words you used are fine. Which date counts?")).toBe(false);
  });

  it("ends the agent's fragments once, whatever shape they arrive in", () => {
    expect(sentence("the part in the middle")).toBe("the part in the middle.");
    expect(sentence("Done already.")).toBe("Done already.");
    expect(sentence("“half up front”")).toBe("“half up front”");
  });

  it("shows a factory comment as prose", () => {
    expect(plain("Before — **a payment schedule**\n\n<!-- bsf:factory -->")).toBe("Before — a payment schedule");
  });
});
