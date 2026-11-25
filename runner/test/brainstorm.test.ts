import { describe, it, expect } from "vitest";
import {
  render, drifting, empty,
  type Brainstorm, type IssueComment, type WaitOptions,
} from "../src/commands/brainstorm.js";
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

/**
 * A turn used to be a whole workflow run: a comment woke intake, intake
 * requeued the item, the role started from scratch and built a sandbox it
 * never used in order to ask one question. Three to five minutes a turn, which
 * is not a conversation, it is correspondence. One job stays alive now and the
 * agent blocks between questions.
 */
describe("holding a conversation open", async () => {
  const bs = await import("../src/commands/brainstorm.js");
  const { parseConditional } = await import("../src/lib/github.js");

  describe("reading gh api -i output", () => {
    it("takes the ETag and the body from a 200", () => {
      const r = parseConditional<{ a: number }[]>(
        ["HTTP/2.0 200 OK", 'ETag: W/"abc123"', "Content-Type: application/json", "", '[{"a":1}]'].join("\r\n"),
      );
      expect(r.status).toBe(200);
      expect(r.etag).toBe('W/"abc123"');
      expect(r.body).toEqual([{ a: 1 }]);
    });

    it("takes the ETag from a 304, which has no body", () => {
      // The whole point: a 304 does not count against the rate limit, so this
      // is the response the loop sees almost every time.
      const r = parseConditional(["HTTP/2.0 304 Not Modified", 'ETag: W/"abc123"', ""].join("\r\n"));
      expect(r.status).toBe(304);
      expect(r.etag).toBe('W/"abc123"');
      expect(r.body).toBeUndefined();
    });

    it("reads x-poll-interval, which GitHub uses to ask for room", () => {
      const r = parseConditional(["HTTP/2.0 200 OK", "X-Poll-Interval: 60", "", "[]"].join("\r\n"));
      expect(r.pollAfter).toBe(60);
    });

    it("finds headers whatever their case", () => {
      const r = parseConditional(["HTTP/2.0 200 OK", 'etag: "x"', "x-poll-interval: 5", "", "[]"].join("\r\n"));
      expect(r.etag).toBe('"x"');
      expect(r.pollAfter).toBe(5);
    });

    it("treats a body it cannot parse as nothing new, rather than crashing the loop", () => {
      const r = parseConditional(["HTTP/2.0 200 OK", "", "<html>502</html>"].join("\r\n"));
      expect(r.status).toBe(200);
      expect(r.body).toBeUndefined();
    });

    it("copes with no headers and no body", () => {
      expect(parseConditional("HTTP/2.0 304 Not Modified").status).toBe(304);
    });
  });

  describe("which comment is the answer", () => {
    const c = (id: number, over: Partial<IssueComment> = {}): IssueComment => ({
      id,
      body: "an answer",
      user: { login: "philip" },
      author_association: "OWNER",
      ...over,
    });
    const trusted = (x: IssueComment): boolean => !bs.wroteByFactory(x) && x.user?.login === "philip";

    it("takes the oldest unaccounted comment, not the newest", () => {
      // Answering the newest would silently skip what they said in between.
      const r = bs.nextAnswer([c(3), c(1), c(2)], { after: 0, trusted });
      expect(r?.id).toBe(1);
    });

    it("ignores anything already accounted for", () => {
      // Without this a restarted holder re-answers the last thing it answered.
      expect(bs.nextAnswer([c(1), c(2)], { after: 2, trusted })).toBeNull();
      expect(bs.nextAnswer([c(1), c(2), c(3)], { after: 2, trusted })?.id).toBe(3);
    });

    it("never reads the factory's own question as an answer", () => {
      const own = c(5, { body: `What should this do?\n\n${bs.FACTORY_MARKER}` });
      expect(bs.nextAnswer([own], { after: 0, trusted })).toBeNull();
    });

    it("ignores a bot, however its association reads", () => {
      const bot = c(5, { user: { login: "factory-app[bot]" }, author_association: "OWNER" });
      expect(bs.wroteByFactory(bot)).toBe(true);
      expect(bs.nextAnswer([bot], { after: 0, trusted })).toBeNull();
    });

    it("ignores someone the repo does not trust", () => {
      // A conversation that decides what gets built is not open to passers-by.
      const stranger = c(5, { user: { login: "drive-by" }, author_association: "NONE" });
      expect(bs.nextAnswer([stranger], { after: 0, trusted })).toBeNull();
    });

    it("ignores an empty comment", () => {
      expect(bs.nextAnswer([c(5, { body: "   " })], { after: 0, trusted })).toBeNull();
      expect(bs.nextAnswer([{ ...c(5), body: undefined }], { after: 0, trusted })).toBeNull();
    });
  });

  describe("whether a job is listening", () => {
    const now = new Date("2026-11-25T12:00:00Z");
    const held = (over: Partial<Brainstorm>): Brainstorm => ({ ...empty("wi_1"), ...over });

    it("is live with a fresh heartbeat", () => {
      const b = held({ holder: "run-1", heartbeat_at: "2026-11-25T11:59:50Z" });
      expect(bs.heldLive(b, now)).toBe(true);
    });

    it("is not live once the heartbeat is stale", () => {
      // A wedged holder must not block a conversation for the six hours a job
      // may live, so intake takes over.
      const b = held({ holder: "run-1", heartbeat_at: "2026-11-25T11:50:00Z" });
      expect(bs.heldLive(b, now)).toBe(false);
    });

    it("is not live with no holder at all", () => {
      expect(bs.heldLive(held({}), now)).toBe(false);
      expect(bs.heldLive(held({ heartbeat_at: "2026-11-25T11:59:59Z" }), now)).toBe(false);
      expect(bs.heldLive(null, now)).toBe(false);
    });

    it("is not live once the conversation is closed", () => {
      const b = held({ holder: "run-1", heartbeat_at: "2026-11-25T11:59:59Z", closed_at: "2026-11-25T11:59:00Z" });
      expect(bs.heldLive(b, now)).toBe(false);
    });

    it("does not trust a heartbeat from the future", () => {
      // A clock disagreement is not liveness, and treating it as one would
      // leave a dead conversation looking held forever.
      const b = held({ holder: "run-1", heartbeat_at: "2026-11-25T18:00:00Z" });
      expect(bs.heldLive(b, now)).toBe(false);
    });

    it("does not trust an unparseable heartbeat", () => {
      expect(bs.heldLive(held({ holder: "run-1", heartbeat_at: "whenever" }), now)).toBe(false);
    });
  });
});

/**
 * The loop itself: it has to stop when nobody is talking, obey GitHub when it
 * asks for room, and keep saying it is alive while it waits — the heartbeat is
 * the only thing stopping intake from starting a second conversation and
 * asking the person the same question twice.
 */
describe("waiting for an answer", async () => {
  const bs = await import("../src/commands/brainstorm.js");

  interface Reply { status: number; etag?: string; pollAfter?: number; body?: IssueComment[] }

  const run = async (replies: readonly Reply[], over: Partial<WaitOptions> = {}) => {
    const asked: { path: string; etag?: string }[] = [];
    const slept: number[] = [];
    const answered: IssueComment[] = [];
    let beats = 0;
    let clock = Date.parse("2026-11-25T12:00:00Z");
    let i = 0;

    const gh = {
      repo: "o/r",
      getConditional: async (path: string, etag?: string) => {
        asked.push({ path, ...(etag === undefined ? {} : { etag }) });
        return replies[Math.min(i++, replies.length - 1)]!;
      },
    } as never;

    const outcome = await bs.waitForAnswer(gh, {
      issue: 7,
      idleMs: 30_000,
      pollMs: 3_000,
      trusted: (c) => !bs.wroteByFactory(c),
      after: 0,
      now: () => new Date(clock),
      sleep: async (ms) => { slept.push(ms); clock += ms; },
      onAnswer: async (c) => { answered.push(c); },
      onHeartbeat: async () => { beats += 1; },
      ...over,
    });
    return { outcome, asked, slept, answered, beats: () => beats };
  };

  const comment = (id: number): IssueComment => ({
    id, body: "only the unpaid ones", user: { login: "philip" }, author_association: "OWNER", created_at: "2026-11-25T12:00:05Z",
  });

  it("returns the answer as soon as one appears", async () => {
    const { outcome } = await run([
      { status: 200, etag: 'W/"1"', body: [] },
      { status: 200, etag: 'W/"2"', body: [comment(11)] },
    ]);
    expect(outcome.kind).toBe("answer");
    if (outcome.kind !== "answer") return;
    expect(outcome.text).toBe("only the unpaid ones");
    expect(outcome.from).toBe("philip");
  });

  it("sends back the ETag it was given, which is what makes polling free", async () => {
    const { asked } = await run([
      { status: 200, etag: 'W/"1"', body: [] },
      { status: 304, etag: 'W/"1"' },
      { status: 200, etag: 'W/"2"', body: [comment(11)] },
    ]);
    expect(asked[0]?.etag).toBeUndefined();
    expect(asked[1]?.etag).toBe('W/"1"');
    expect(asked[2]?.etag).toBe('W/"1"');
  });

  it("gives up when nobody says anything, and says how long it waited", async () => {
    const { outcome, slept } = await run([{ status: 304, etag: 'W/"1"' }], { idleMs: 10_000, pollMs: 3_000 });
    expect(outcome.kind).toBe("quiet");
    if (outcome.kind !== "quiet") return;
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(10_000);
    // Four polls at three seconds reaches twelve, past the ten-second window.
    expect(slept).toEqual([3_000, 3_000, 3_000, 3_000]);
  });

  it("waits as long as GitHub asks when it asks for longer", async () => {
    // Ignoring x-poll-interval earns a secondary rate limit for the whole
    // repository, not just for this loop.
    const { slept } = await run([{ status: 200, etag: 'W/"1"', pollAfter: 11, body: [] }], { idleMs: 20_000 });
    expect(slept[0]).toBe(11_000);
  });

  it("keeps its own poll interval when GitHub asks for less", async () => {
    const { slept } = await run([{ status: 200, etag: 'W/"1"', pollAfter: 1, body: [] }], { idleMs: 9_000, pollMs: 3_000 });
    expect(slept[0]).toBe(3_000);
  });

  it("says it is still alive while it waits, not only between turns", async () => {
    // Intake decides whether to start a second conversation from this, and a
    // heartbeat that only moved between turns would go stale mid-wait.
    const { beats } = await run([{ status: 304, etag: 'W/"1"' }], { idleMs: 120_000, pollMs: 5_000 });
    expect(beats()).toBeGreaterThan(1);
  });

  it("hands the answer over to be recorded", async () => {
    const { answered } = await run([{ status: 200, etag: 'W/"1"', body: [comment(11)] }]);
    expect(answered.map((c) => c.id)).toEqual([11]);
  });

  it("starts from the comment already accounted for", async () => {
    // Without this a restarted holder re-answers the last thing it answered.
    const { outcome } = await run([{ status: 200, etag: 'W/"1"', body: [comment(11)] }], {
      after: 11,
      idleMs: 6_000,
      pollMs: 3_000,
    });
    expect(outcome.kind).toBe("quiet");
  });

  it("does not stop on a comment it must ignore", async () => {
    const own: IssueComment = { id: 11, body: `A question?\n\n${bs.FACTORY_MARKER}`, user: { login: "factory[bot]" } };
    const { outcome } = await run([{ status: 200, etag: 'W/"1"', body: [own] }], { idleMs: 6_000, pollMs: 3_000 });
    expect(outcome.kind).toBe("quiet");
  });
});
