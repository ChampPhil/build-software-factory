import { scoreCorrection, redact } from "./mine.js";

/**
 * What counts as a human correcting an agent, wherever it happens.
 *
 * A correction can arrive four ways: a review comment, a change request, a
 * person pushing a commit onto a factory branch, or a correction said to an
 * agent in a local session. They are judged by one rule here so that the same
 * words are a correction (or not) whichever door they came through.
 */

export type CorrectionKind = "review_comment" | "change_request" | "human_push" | "local_session";

export interface Classified {
  readonly correction: boolean;
  /** 0 to 1; 1 for a person pushing a fix, which needs no judging. */
  readonly confidence: number;
  readonly why: string;
}

/** A comment that approves, thanks or acknowledges is the gate working, not steering. */
const APPROVAL =
  /^(?![\s\S]*\b(?:but|however|except|although|please|should|needs?|must|don'?t|instead|rename|change|remove)\b)\s*(?:[-*]\s*)?(?:lgtm|looks good(?: to me)?|looks great|ship it|approved?|thanks?(?: you)?|thank you|nice(?: work| one)?|great(?: work)?|perfect|good job|\+1|:?\+1:?|👍|✅|sgtm|nit:?\s*(?:none|nothing))(?![A-Za-z0-9])[\s\S]{0,40}$/i;

/**
 * Review wording that asks for a change without the "no, wrong" a person says
 * to an agent in a chat. In a PR the commenter is already pointing at a line,
 * so "use X here" or "this should be Y" is a correction the chat classifier
 * would score low.
 */
const REQUESTS: readonly RegExp[] = [
  /\b(?:please|pls)\s+(?:use|change|remove|rename|add|move|avoid|replace|drop|keep|stop|don'?t|do not)\b/i,
  /\b(?:should|needs? to|must|have to|ought to)\s+(?:be|use|not|never|always|go|live|have|call|return|throw|handle)\b/i,
  /\buse\s+\S+(?:\s+\S+){0,4}\s+(?:instead|here|there)\b/i,
  /\b(?:don'?t|do not|never|avoid|stop)\s+\w+/i,
  /\b(?:instead of|rather than)\b/i,
  /\bwhy not\s+\w+/i,
  /\bthis (?:is|was) (?:wrong|incorrect|broken|not (?:right|what))\b/i,
  /\b(?:not|isn'?t|aren'?t) (?:what|how) (?:we|i|it)\b/i,
];

/** Below this a chat turn is thinking aloud; in a PR the bar is lower because the reader is a reviewer. */
const REVIEW_THRESHOLD = 0.25;

export function isApprovalOnly(text: string): boolean {
  const t = text.trim();
  if (t === "") return true;
  return t.split(/\s+/).length <= 8 && APPROVAL.test(t);
}

/**
 * Whether a person's words on a PR are a correction.
 *
 * Only the first two kinds are judged on text. A human push is a correction by
 * being a push: somebody had to change what the agent wrote.
 */
export function classifyCorrection(text: string, kind: CorrectionKind): Classified {
  if (kind === "human_push") {
    return { correction: true, confidence: 1, why: "a person changed the branch the agent wrote" };
  }
  if (isApprovalOnly(text)) return { correction: false, confidence: 0, why: "an approval or an acknowledgement" };

  if (kind === "change_request") {
    // A reviewer who blocks a merge is saying something is wrong, whatever words they use.
    return { correction: true, confidence: 0.9, why: "a change request" };
  }

  const scored = scoreCorrection(text);
  const asks = REQUESTS.find((re) => re.test(text));
  if (kind === "local_session") {
    return scored.confidence >= 0.4
      ? { correction: true, confidence: scored.confidence, why: scored.signals.join(", ") }
      : { correction: false, confidence: scored.confidence, why: "thinking aloud, not correcting" };
  }
  if (scored.confidence >= REVIEW_THRESHOLD || asks !== undefined) {
    return {
      correction: true,
      confidence: Math.max(scored.confidence, asks === undefined ? 0 : 0.5),
      why: scored.signals.length > 0 ? scored.signals.join(", ") : "asks for a change",
    };
  }
  // A question is a conversation, not a correction.
  return { correction: false, confidence: scored.confidence, why: "a question or a remark, not a request to change" };
}

export interface CorrectionRecord {
  readonly at: string;
  readonly by: string;
  readonly kind: CorrectionKind;
  /** What the person said, or for a push, what they changed. Redacted and cut to fit. */
  readonly text: string;
  readonly url?: string;
}

const TEXT_CAP = 600;

export function recordOf(input: {
  readonly at: string;
  readonly by: string;
  readonly kind: CorrectionKind;
  readonly text: string;
  readonly url?: string | undefined;
}): CorrectionRecord {
  const text = redact(input.text.trim()).slice(0, TEXT_CAP);
  return {
    at: input.at,
    by: input.by,
    kind: input.kind,
    text,
    ...(input.url === undefined ? {} : { url: input.url }),
  };
}

/** One line a work item or a scoring prompt can carry. */
export function summaryLine(c: CorrectionRecord): string {
  const first = c.text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const head = first.length > 140 ? `${first.slice(0, 137)}...` : first;
  return head === "" ? `${c.by} (${c.kind.replace(/_/g, " ")})` : head;
}

const KIND_WORDS: Record<CorrectionKind, string> = {
  review_comment: "a review comment",
  change_request: "a change request",
  human_push: "a commit a person pushed to the branch",
  local_session: "something said to an agent in a local session",
};

/**
 * The work item body hardening reads. It carries the person's words and a link
 * back to them, so the hardening PR can link to exactly what it answers.
 */
export function workItemBody(c: CorrectionRecord, ctx: { readonly pr?: number | undefined; readonly parent?: string | undefined }): string {
  const lines = [
    `A person corrected the factory: ${KIND_WORDS[c.kind]} from @${c.by}${ctx.pr === undefined ? "" : ` on #${ctx.pr}`}.`,
    "",
    ...c.text.split("\n").map((l) => `> ${l}`),
    "",
  ];
  if (c.url !== undefined) lines.push(`Source: ${c.url}`);
  if (ctx.parent !== undefined) lines.push(`The run it corrects belongs to ${ctx.parent}.`);
  return lines.join("\n").trimEnd();
}

export function workItemTitle(c: CorrectionRecord, pr?: number): string {
  const line = summaryLine(c);
  const where = pr === undefined ? "" : ` on #${pr}`;
  const title = `Correction${where}: ${line}`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}
