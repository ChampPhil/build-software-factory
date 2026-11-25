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

describe("the frame — the words the conversation teaches", async () => {
  const bs = await import("../src/commands/brainstorm.js");

  const term = (over: Record<string, unknown> = {}) => ({
    term: "write-ahead log",
    means: "a file the system appends to before it changes anything.",
    names: 'you said "it should not lose work if it dies mid-run"',
    unlocks: "replay after a crash instead of a best guess at what happened",
    ...over,
  });

  describe("what it refuses", () => {
    it("refuses a term with no meaning, no anchor in what they said, or nothing it unlocks", () => {
      // These three fields are what separate a word somebody can use from a
      // glossary entry. Without them the turn decays into trivia and the
      // person stops reading the one thing that was meant to help them.
      for (const missing of ["means", "names", "unlocks"] as const) {
        expect(() => bs.parseFrame({ terms: [term({ [missing]: "" })] })).toThrow(missing);
      }
    });

    it("names the offending term when it refuses, so a retry can fix that one", () => {
      expect(() => bs.parseFrame({ terms: [term(), term({ term: "compaction", unlocks: "  " })] })).toThrow(
        /compaction/,
      );
    });

    it("refuses a neighbouring field with no stated limit", () => {
      // An analogy with no edge is the one that gets carried further than it
      // holds, by the spec stage that reads it a run later and has only the
      // words to go on.
      expect(() =>
        bs.parseFrame({ neighbors: [{ field: "database recovery", carries_over: "the log shape" }] }),
      ).toThrow(/breaks_down/);
    });

    it("refuses an empty frame rather than posting a turn that teaches nothing", () => {
      expect(() => bs.parseFrame({})).toThrow(/empty frame/);
      expect(() => bs.parseFrame({ terms: [], neighbors: [] })).toThrow(/empty frame/);
    });

    it("refuses anything that is not an object", () => {
      for (const bad of [null, "frame", 7, [1]]) {
        expect(() => bs.parseFrame(bad)).toThrow();
      }
    });
  });

  describe("what it keeps", () => {
    it("keeps the agent's ranking rather than sorting, because the ranking is the judgement", () => {
      const f = bs.parseFrame({ terms: [term({ term: "zebra" }), term({ term: "apple" })] });
      expect(f.terms?.map((t) => t.term)).toEqual(["zebra", "apple"]);
    });

    it("drops prior art that is blank instead of recording an empty claim", () => {
      expect(bs.parseFrame({ terms: [term({ prior_art: "   " })] }).terms?.[0]?.prior_art).toBeUndefined();
      expect(bs.parseFrame({ terms: [term({ prior_art: "SQLite" })] }).terms?.[0]?.prior_art).toBe("SQLite");
    });

    it("keeps the readings and which one was taken, so spec knows a choice was made", () => {
      const f = bs.parseFrame({
        named: "a durable job queue",
        readings: [
          { problem: "work is lost on restart", term: "durability", tells_it_apart: "work vanishes after a crash" },
          { problem: "work runs twice", term: "idempotency", tells_it_apart: "duplicate side effects" },
        ],
        reading_taken: "durability — they described losing work, not repeating it",
      });
      expect(f.readings).toHaveLength(2);
      expect(f.reading_taken).toContain("durability");
    });
  });

  describe("what the person reads", () => {
    const full = bs.parseFrame({
      named: "what you are describing is a write-ahead log",
      terms: [term(), term({ term: "compaction" }), term({ term: "fsync" }), term({ term: "checkpoint" }), term({ term: "fifth" })],
      neighbors: [
        { field: "database recovery", carries_over: "the append-then-apply order.", breaks_down: "a database owns its storage and you do not" },
        { field: "print spoolers", carries_over: "jobs survive the process.", breaks_down: "a spooler never has to merge two queues" },
        { field: "third", carries_over: "x.", breaks_down: "y" },
      ],
      unmentioned: ["whether a half-written run should resume or restart", "b", "c", "d"],
    });

    it("ends on the question, so it stays a turn in a conversation", () => {
      const text = bs.renderFrameTurn(full, "Should a half-written run resume where it stopped?");
      expect(text.trimEnd().endsWith("Should a half-written run resume where it stopped?")).toBe(true);
    });

    it("shows the top few and leaves the rest for the spec stage", () => {
      // The person needs the words that change what gets built; the spec stage
      // needs all of them. Showing twelve terms on a phone is how the turn
      // gets skipped, and a skipped frame teaches nobody anything.
      const text = bs.renderFrameTurn(full, "Q?");
      expect(text).toContain("write-ahead log");
      expect(text).not.toContain("fifth");
      expect(text).toContain("print spoolers");
      expect(text).not.toContain("third");
      expect(full.terms).toHaveLength(5);
      expect(full.neighbors).toHaveLength(3);
    });

    it("always says where a neighbouring analogy breaks down", () => {
      expect(bs.renderFrameTurn(full, "Q?")).toContain("a database owns its storage and you do not");
    });

    it("reads as prose rather than a form, even with one term and no neighbours", () => {
      const thin = bs.parseFrame({ named: "a retry policy", terms: [term()] });
      const text = bs.renderFrameTurn(thin, "How many times should it retry?");
      expect(text).toContain("The word that matters most here:");
      expect(text).not.toContain("undefined");
      expect(text).not.toContain("Where this has been solved");
    });

    it("has room to teach, where a question has room to be read on a phone", () => {
      // A question is one sentence; teaching somebody the words for their own
      // problem is not, and capping both at 1200 would truncate the frame
      // mid-term. The larger cap is earned by this text being rendered from
      // validated fields rather than written freehand by the agent.
      expect(bs.FRAME_LIMIT).toBeGreaterThan(bs.QUESTION_LIMIT);
      const long = bs.parseFrame({
        named: "x".repeat(400),
        terms: [term({ means: "y".repeat(900) }), term({ term: "two", means: "z".repeat(900) })],
      });
      const text = bs.saneComment(bs.renderFrameTurn(long, "Q?"), bs.FRAME_LIMIT);
      expect(text.length).toBeLessThanOrEqual(bs.FRAME_LIMIT);
      expect(text.length).toBeGreaterThan(bs.QUESTION_LIMIT);
    });

    it("redacts and defuses mentions in the frame as it does in a question", () => {
      // The frame is agent-written text on a public issue like any other turn.
      const f = bs.parseFrame({ named: "ask @philip about it", terms: [term()] });
      const text = bs.saneComment(bs.renderFrameTurn(f, "Q?"), bs.FRAME_LIMIT);
      expect(text).toContain("philip");
      expect(text).not.toContain("@philip");
    });
  });

  describe("what the spec stage reads", () => {
    it("hands over the whole frame, marked unverified, with the limits attached", () => {
      // The conversation has no web access, so every term in here is a claim.
      // The spec stage is the first stage that can check one, and it only
      // knows to check if the handover says so.
      const text = bs.render({
        schema: "brainstorm/1",
        work_item: "wi-1",
        turns: [{ at: "2026-11-25T00:00:00Z", who: "factory", text: "Which is it?" }],
        understood: null,
        open: [],
        frame: bs.parseFrame({
          named: "a write-ahead log",
          terms: [term({ prior_art: "SQLite" }), term({ term: "fifth-term" })],
          neighbors: [{ field: "database recovery", carries_over: "order.", breaks_down: "you do not own the storage" }],
          unmentioned: ["resume or restart"],
        }),
      });
      expect(text).toContain("Unverified");
      expect(text).toContain("cut what you");
      // Everything, not just what the person was shown.
      expect(text).toContain("fifth-term");
      expect(text).toContain("claimed prior art: SQLite");
      expect(text).toContain("database recovery");
      expect(text).toContain("resume or restart");
    });

    it("says nothing about a frame when there is none, so an old log reads as before", () => {
      const text = bs.render({
        schema: "brainstorm/1",
        work_item: "wi-1",
        turns: [{ at: "2026-11-25T00:00:00Z", who: "person", text: "make it faster" }],
        understood: null,
        open: [],
      });
      expect(text).not.toContain("Unverified");
      expect(text).not.toContain("undefined");
    });
  });
});

describe("the frame reads like prose, whichever way the agent phrased it", async () => {
  const bs = await import("../src/commands/brainstorm.js");

  // Found by rendering a realistic frame and reading it, which no assertion
  // in the suite above would have caught: the fields are the agent's own
  // sentences and it writes a clause one time and a noun phrase the next.
  it("reads correctly whether a field is a clause or a noun phrase", () => {
    const text = bs.renderFrameTurn(
      bs.parseFrame({
        named: "a write-ahead log",
        terms: [
          {
            term: "write-ahead log",
            means: "a file the run appends to before it changes anything.",
            names: 'you said it "shouldn\'t lose work if it dies halfway"',
            unlocks: "a resume from the last good step",
          },
          {
            term: "checkpoint",
            means: "a point the run can be resumed from.",
            names: "the part about the long step in the middle",
            unlocks: "deciding what a resume actually costs",
          },
        ],
      }),
      "Q?",
    );
    // The old wording glued these into "Names the part where X" and "Lets you
    // ask for X", which read as "Names the part where the part about…".
    expect(text).not.toContain("Names the part where");
    expect(text).toContain("From what you wrote: the part about the long step in the middle.");
    expect(text).toContain("Lets you ask for: deciding what a resume actually costs.");
  });

  it("ends every fragment, so two of the agent's sentences never run together", () => {
    const text = bs.renderFrameTurn(
      bs.parseFrame({
        terms: [{ term: "t", means: "no full stop here", names: "nor here", unlocks: "nor here either" }],
        neighbors: [{ field: "f", carries_over: "no stop", breaks_down: "none here" }],
        unmentioned: ["nothing terminates this"],
      }),
      "Q?",
    );
    for (const frag of ["no full stop here.", "nor here.", "nor here either.", "no stop.", "none here.", "nothing terminates this."]) {
      expect(text).toContain(frag);
    }
    expect(text).not.toContain("..");
  });

  it("spells small counts, because 'The 3 words' looks machine-written", () => {
    const term = (t: string) => ({ term: t, means: "m", names: "n", unlocks: "u" });
    expect(bs.renderFrameTurn(bs.parseFrame({ terms: [term("a"), term("b"), term("c")] }), "Q?")).toContain(
      "The three words",
    );
    expect(bs.renderFrameTurn(bs.parseFrame({ terms: [term("a")] }), "Q?")).toContain("The word that matters most");
  });

  it("keeps each entry's lines together, so a bullet is one item and not three", () => {
    const text = bs.renderFrameTurn(
      bs.parseFrame({ terms: [{ term: "t", means: "m.", names: "n.", unlocks: "u." }] }),
      "Q?",
    );
    // Continuation lines are indented under their bullet rather than separated
    // by a blank line, which would render them as loose paragraphs.
    expect(text).toContain("- **t** — m.\n  From what you wrote: n.\n  Lets you ask for: u.");
  });
});
