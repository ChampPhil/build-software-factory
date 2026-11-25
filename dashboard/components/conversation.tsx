"use client";

import { useRef, useState } from "react";
import { conversationLive, useBrainstorm, useIssueComments } from "@/lib/data";
import type { Request } from "@/lib/view";
import { clock } from "@/lib/view";
import { useApp } from "@/components/app";
import { Loading, autoGrow } from "@/components/ui";

const isBot = (login: string | undefined, type: string | undefined): boolean => type === "Bot" || /\[bot\]$/.test(login ?? "");

interface Turn {
  readonly at: string;
  readonly who: "factory" | "person";
  readonly by: string;
  readonly text: string;
  readonly sending?: boolean;
}

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
          text: c.body,
        }))
      : [];
  const base: Turn[] = b !== null && b.turns.length > 0 ? b.turns.map((t) => ({ at: t.at, who: t.who, by: t.who === "factory" ? "The factory" : "You", text: t.text })) : fromComments;
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
        {turns.map((t, i) => (
          <div className={`turn ${t.who === "factory" ? "f" : "p"}${i === latestIndex ? " latest" : ""}${t.sending === true ? " sending" : ""}`} key={`${t.at}-${i}`}>
            <div className="who">
              <span>{t.who === "factory" ? "The factory" : t.by}</span>
              <span>{t.sending === true ? "" : clock(t.at)}</span>
            </div>
            <div className="text">{t.text}</div>
          </div>
        ))}
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
