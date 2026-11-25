"use client";

import { useRef, useState } from "react";
import { conversationLive, useBrainstorm, useIssueComments, type BrainstormFile } from "@/lib/data";
import type { Request } from "@/lib/view";
import { clock } from "@/lib/view";
import { isFrameTurn, plain, questionOf, sentence } from "@/lib/frame";
import { useApp } from "@/components/app";
import { Loading, autoGrow } from "@/components/ui";

const isBot = (login: string | undefined, type: string | undefined): boolean => type === "Bot" || /\[bot\]$/.test(login ?? "");

interface Turn {
  readonly at: string;
  readonly who: "factory" | "person";
  readonly by: string;
  readonly text: string;
  readonly sending?: boolean;
  /** The turn that taught the frame: shown as its own component, ending on its question. */
  readonly frame?: boolean;
}

type Frame = NonNullable<BrainstormFile["frame"]>;

/** How much of the frame a person is shown: the runner's own limits, so the page and the comment agree. */
const TERMS_SHOWN = 4;
const NEIGHBORS_SHOWN = 2;
const UNMENTIONED_SHOWN = 3;
const WORD = ["no", "one", "two", "three", "four", "five", "six"];


/**
 * The conversation about a request, as the whole page.
 *
 * The factory speaks on the left in its own typeface; the person answers on
 * the right. Whether a job is listening right now decides what the status
 * line promises: a reply in seconds, or a wake-up that takes minutes. Those
 * are different experiences and saying which is the difference between a
 * person waiting twenty seconds and one deciding it is broken.
 */
export function Conversation({ request }: { request: Request }) {
  const { client, repo, demo, act, version } = useApp();
  const [mine, setMine] = useState<readonly Turn[]>([]);
  const convo = useBrainstorm(client, request.id, version);
  const comments = useIssueComments(client, request.issue, version);
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  if (convo.state === "loading" && comments.state === "loading") return <Loading what="the conversation" />;
  const b = convo.state === "ready" ? convo.data : null;
  const live = conversationLive(b);

  const fromComments: Turn[] =
    comments.state === "ready"
      ? comments.data.map((c) => ({
          at: c.created_at,
          who: isBot(c.user?.login, c.user?.type) ? ("factory" as const) : ("person" as const),
          by: c.user?.login ?? "someone",
          text: isBot(c.user?.login, c.user?.type) ? plain(c.body) : c.body,
        }))
      : [];
  const frame = b?.frame;
  const base: Turn[] =
    b !== null && b.turns.length > 0
      ? b.turns.map((t) => ({ at: t.at, who: t.who, by: t.who === "factory" ? "The factory" : "You", text: t.text, frame: frame !== undefined && t.who === "factory" && isFrameTurn(t.text) }))
      : fromComments;
  // A reply shows at once, then gives way to the copy the factory recorded.
  const pending = mine.filter((m) => !base.some((t) => t.who === "person" && t.text.trim() === m.text.trim()));
  const turns = [...base, ...pending];
  const lastFactory = [...turns].reverse().findIndex((t) => t.who === "factory");
  const latestIndex = lastFactory === -1 ? -1 : turns.length - 1 - lastFactory;

  const send = async (words: string): Promise<void> => {
    if (request.issue === null || words.trim() === "") return;
    const turn: Turn = { at: new Date().toISOString(), who: "person", by: "You", text: words.trim(), sending: true };
    setMine((m) => [...m, turn]);
    setText("");
    const ok = await act(() => client.comment(request.issue!, words.trim()), live ? "Sent. It's reading your answer." : "Sent. Your answer wakes the factory; the next question takes a few minutes.");
    if (!ok) {
      setMine((m) => m.filter((x) => x !== turn));
      setText(words);
    }
  };

  if (request.issue === null) {
    return (
      <div className="talk-col">
        <div className="nowhere">
          <b>This request didn&rsquo;t come from an issue on {demo ? "this repository" : repo}, so there&rsquo;s nowhere to answer it here.</b>{" "}
          Send it again as a new request and the conversation carries on there and here.
        </div>
      </div>
    );
  }

  const understood = b?.understood ?? null;
  const closed = b?.closed_at !== undefined;

  return (
    <div className="talk-col">
      {closed && understood !== null && (
        <p className="muted">The conversation ended {clock(b?.closed_at)} with this playback. The spec stage took it from there.</p>
      )}
      <div className="thread" aria-live="polite">
        {turns.length === 0 && <p className="muted">Nothing has been said yet. Anything you write goes on issue #{request.issue} and the factory reads it.</p>}
        {turns.map((t, i) =>
          t.frame === true && frame !== undefined ? (
            <FrameTurn key={`${t.at}-${i}`} frame={frame} at={t.at} question={questionOf(t.text)} latest={i === latestIndex} />
          ) : (
          <div className={`turn ${t.who === "factory" ? "f" : "p"}${i === latestIndex ? " latest" : ""}${t.sending === true ? " sending" : ""}`} key={`${t.at}-${i}`}>
            <div className="who">
              <span>{t.who === "factory" ? "The factory" : t.by}</span>
              <span>{t.sending === true ? "" : clock(t.at)}</span>
            </div>
            <div className="text">{t.text}</div>
          </div>
          ),
        )}
        {live && turns[turns.length - 1]?.who === "person" && (
          <div className="turn f">
            <div className="who"><span>The factory</span></div>
            <span className="typing" aria-label="The factory is writing"><i /><i /><i /></span>
          </div>
        )}
        {understood !== null && (
          <section className={closed ? "played calm" : "played"} aria-labelledby="played-h">
            <h2 id="played-h">{closed ? "What it understood" : "Here's what I'll build"}</h2>
            <p className="voice">{understood}</p>
            {!closed && (
              <div className="acts">
                <button className="btn go" type="button" onClick={() => void send("That's right, build it.")}>
                  That&rsquo;s right, build it
                </button>
                <button className="btn" type="button" onClick={() => box.current?.focus()}>
                  Correct something
                </button>
              </div>
            )}
          </section>
        )}
      </div>
      {!closed && (
        <div className="dock">
          <div className="status">
            {live ? (
              <>
                <span className="pulse" aria-hidden="true" />
                <span>Listening. Replies come back in a few seconds.</span>
              </>
            ) : (
              <>
                <span className="cold-dot" aria-hidden="true" />
                <span>Not listening right now. Send anyway: your answer wakes the factory, and the next question takes a few minutes.</span>
              </>
            )}
          </div>
          <form
            className="compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <textarea
              ref={box}
              rows={1}
              value={text}
              aria-label="Your answer"
              placeholder={understood !== null ? "Correct anything that's wrong" : "Answer the question"}
              onChange={(e) => {
                setText(e.target.value);
                autoGrow(e.target);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void send(text);
                }
              }}
            />
            <button className="btn go" type="submit" disabled={text.trim() === ""}>
              Send
            </button>
          </form>
          <div className="hint">
            Posts to #{request.issue} as you. Answers typed on GitHub show up here too. <kbd>Ctrl</kbd> <kbd>Enter</kbd> sends.
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The factory teaching the words for the request.
 *
 * A turn, not a gate: it sits in the thread, it is the factory's, and it ends
 * on the next ordinary question, set exactly like every other question so
 * someone who skips the vocabulary loses nothing. Everything in it is the
 * conversation's own claim, made without looking anything up, and says so.
 * The labels take a clause or a noun phrase, because the agent writes both.
 */
export function FrameTurn({ frame, at, question, latest }: { frame: Frame; at: string; question: string; latest: boolean }) {
  const terms = (frame.terms ?? []).slice(0, TERMS_SHOWN);
  const more = (frame.terms?.length ?? 0) - terms.length;
  const near = (frame.neighbors ?? []).slice(0, NEIGHBORS_SHOWN);
  const unsaid = (frame.unmentioned ?? []).slice(0, UNMENTIONED_SHOWN);
  return (
    <div className={`turn f frame${latest ? " latest" : ""}`}>
      <div className="who">
        <span>The factory</span>
        <span>{clock(at)}</span>
        <span>The words for this</span>
      </div>
      <div className="frame-body">
        {frame.named !== undefined && frame.named.trim() !== "" && <p className="frame-named">{sentence(frame.named)}</p>}
        {terms.length > 0 && (
          <>
            <h3 className="frame-h">{terms.length === 1 ? "The word that matters most here" : `The ${WORD[terms.length] ?? terms.length} words that change what gets built`}</h3>
            <ol className="frame-terms">
              {terms.map((t) => (
                <li key={t.term}>
                  <b>{t.term}</b>
                  <span>{sentence(t.means)}</span>
                  <dl>
                    <dt>From what you wrote</dt>
                    <dd>{sentence(t.names)}</dd>
                    <dt>Lets you ask for</dt>
                    <dd>{sentence(t.unlocks)}</dd>
                    {t.prior_art !== undefined && t.prior_art.trim() !== "" && (
                      <>
                        <dt>Used this way in</dt>
                        <dd>
                          {sentence(t.prior_art)} <span className="unchecked">not yet checked</span>
                        </dd>
                      </>
                    )}
                  </dl>
                </li>
              ))}
            </ol>
            {more > 0 && <p className="muted small">{more} more {more === 1 ? "is" : "are"} in the notes the spec is written from.</p>}
          </>
        )}
        {near.length > 0 && (
          <>
            <h3 className="frame-h">Where this has been solved before</h3>
            <ul className="frame-near">
              {near.map((n) => (
                <li key={n.field}>
                  <b>{n.field}</b>
                  {n.carries_over.trim() !== "" && <span>{sentence(n.carries_over)}</span>}
                  <span className="limit">Where it stops being the same problem: {sentence(n.breaks_down)}</span>
                  {(n.terms?.length ?? 0) > 0 && <span className="limit">Worth borrowing: {n.terms?.join(", ")}.</span>}
                </li>
              ))}
            </ul>
          </>
        )}
        {unsaid.length > 0 && (
          <>
            <h3 className="frame-h">What you didn&rsquo;t mention that will decide something</h3>
            <ul className="frame-unsaid">
              {unsaid.map((u) => (
                <li key={u}>{sentence(u)}</li>
              ))}
            </ul>
          </>
        )}
        <p className="frame-note">None of this was looked up. The spec stage checks each word and drops what it can&rsquo;t confirm.</p>
      </div>
      <div className="text">{question}</div>
    </div>
  );
}
