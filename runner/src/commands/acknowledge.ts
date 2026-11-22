import type { IntakeDecision } from "./intake.js";

/**
 * What the factory says back on an issue as soon as it has read it, so a
 * person is never left wondering whether the request landed.
 *
 * Only issues get one. A dashboard request is an issue too, so it is covered;
 * a CI failure, a schedule and a correction have nobody waiting on them.
 */

export interface Acknowledgement {
  readonly issue: number;
  readonly body: string;
}

const PIPELINE: Record<string, string> = {
  product_work: "a change to the product (it will write a plan, build it and show proof)",
  gardening: "tidying (it will make the code cleaner without changing what it does)",
  hardening: "hardening (it will make this mistake impossible to repeat)",
  definition: "a change to how the factory works",
};

/** The issue number a decision's event came from, or null when it was not an issue. */
function issueOf(d: IntakeDecision): number | null {
  const kind = d.event.kind;
  if (kind !== "issue_opened" && kind !== "issue_labeled" && kind !== "issue_comment") return null;
  const m = /^#(\d+)$/.exec(d.event.ref ?? "");
  return m === null ? null : Number(m[1]);
}

/** The comment to post for one decision, or null when nothing should be said. */
export function acknowledgement(d: IntakeDecision, acceptLabel: string): Acknowledgement | null {
  const issue = issueOf(d);
  if (issue === null) return null;

  switch (d.outcome) {
    case "queued": {
      if (d.workItem === null || d.event.kind !== "issue_opened") return null;
      // A request the chief of staff has a question about is answered with that
      // question, which is posted on its own.
      if (d.workItem.status === "needs_info") return null;
      const what = PIPELINE[d.workItem.pipeline] ?? d.workItem.pipeline;
      const lines = [`Got it. The factory is treating this as ${what}.`];
      if (d.workItem.routing?.by === "chief_of_staff") lines.push(`Why: ${d.workItem.routing.reason}`);
      if (d.workItem.goal !== undefined) lines.push(`The goal it will check against: ${d.workItem.goal}`);
      if (d.workItem.success_check !== undefined) lines.push(`How it will know: ${d.workItem.success_check}`);
      if (d.workItem.routing?.by === "chief_of_staff") lines.push("If that is the wrong kind of work, you can move it from the dashboard.");
      lines.push(
        "Next it reads the request. If something is unclear it will ask one question here before it writes any code, and you can answer by replying on this issue.",
      );
      return { issue, body: lines.join("\n\n") };
    }
    case "waiting_trust":
      return {
        issue,
        body:
          `Thanks. This came from an account the factory does not act on by itself, so nothing has started. ` +
          `A maintainer can start it by adding the \`${acceptLabel}\` label.`,
      };
    case "settings_request":
      return {
        issue,
        body:
          "Got it. This is a change to how the factory is set up, so no agent will work on it. " +
          "If the Factory page on the dashboard has a control for it (budget, merge by itself, cleanup time), use that and close this issue. " +
          "Otherwise open Claude Code in this repository and ask it to update your factory: it reads the open requests labelled `factory:ask`, " +
          "makes the change as a pull request through the factory's own tools, and links it here.",
      };
    case "admits_open_item":
      return { issue, body: "Accepted. The factory is picking this up now." };
    case "answers_open_item":
      return {
        issue,
        body: `Thanks, ${d.event.actor}. That answers the question, so the factory is picking this up again.`,
      };
    case "retries_open_item":
      return { issue, body: "Trying this again." };
    default:
      return null;
  }
}
