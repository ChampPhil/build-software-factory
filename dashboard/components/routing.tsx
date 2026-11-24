"use client";

import { useState } from "react";
import type { GitHubClient } from "@/lib/github";
import type { StandingGoalsFile, WorkItemDoc } from "@/lib/types";
import { GOAL_LANES, MOVABLE, canMove, liveGoals, whoRouted } from "@/lib/routing";

/**
 * Why a request went where it went, and a way to send it somewhere else.
 *
 * The decision and its reason are the chief of staff's own words, shown as
 * plain text. A move is one click: it goes through the factory's intake, which
 * records who moved it and refuses once work has started.
 */
export function RoutingDetail({ client, doc, status }: { client: GitHubClient; doc: WorkItemDoc; status: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const move = async (to: string): Promise<void> => {
    setState("sending");
    try {
      await client.moveRequest(doc.id, to);
      setState("sent");
    } catch {
      setState("failed");
    }
  };
  const who = whoRouted(doc);
  const others = MOVABLE.filter((p) => p !== doc.pipeline);
  return (
    <div className="row-meta" style={{ gridColumn: "1 / -1", padding: "4px 0 8px 22px" }}>
      <div>{doc.title}</div>
      {who !== null && <div>{who}{doc.routing?.reason ? `: ${doc.routing.reason}` : ""}</div>}
      {doc.goal !== undefined && <div>Goal: {doc.goal}</div>}
      {doc.success_check !== undefined && <div>Done when: {doc.success_check}</div>}
      {(doc.routing?.overrides ?? []).map((o) => (
        <div key={o.at}>{o.by} moved it from {o.from.replace(/_/g, " ")} to {o.to.replace(/_/g, " ")}</div>
      ))}
      {canMove(status) && (
        <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
          <span>Change pipeline:</span>
          {others.map((p) => (
            <button key={p} className="btn" disabled={state === "sending" || state === "sent"} onClick={() => void move(p)}>
              {p.replace(/_/g, " ")}
            </button>
          ))}
          {state === "sent" && <span>Sent. It updates once the factory has applied it.</span>}
          {state === "failed" && <span>Could not send that. Try again.</span>}
        </div>
      )}
    </div>
  );
}

/** What to focus on, set by asking. Added and removed through the factory's intake. */
export function StandingGoals({ client, file }: { client: GitHubClient; file: StandingGoalsFile | null }) {
  const [text, setText] = useState("");
  const [lane, setLane] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const goals = liveGoals(file);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setState("sending");
    try {
      await fn();
      setState("sent");
    } catch {
      setState("failed");
    }
  };

  return (
    <div>
      {goals.length === 0 ? (
        <div className="row-meta">No standing goals. The chief of staff and the gardener choose on their own.</div>
      ) : (
        <div className="rows">
          {goals.map((g) => (
            <div className="row" key={g.id} style={{ gridTemplateColumns: "1fr auto auto" }}>
              <span className="row-title">{g.text}</span>
              <span className="row-meta">{GOAL_LANES.find((l) => l.value === (g.lane ?? ""))?.label ?? g.lane} {g.by}</span>
              <button className="btn" disabled={state === "sending"} onClick={() => void run(() => client.removeStandingGoal(g.id))}>
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      <form
        style={{ display: "flex", gap: 8, marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() === "") return;
          void run(async () => {
            await client.addStandingGoal(text.trim(), lane === "" ? null : lane);
            setText("");
          });
        }}
      >
        <input
          aria-label="Standing goal"
          value={text}
          maxLength={200}
          placeholder="e.g. tighten auth this month"
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1 }}
        />
        <select aria-label="Applies to" value={lane} onChange={(e) => setLane(e.target.value)}>
          {GOAL_LANES.map((l) => (<option key={l.value} value={l.value}>{l.label}</option>))}
        </select>
        <button className="btn primary" type="submit" disabled={state === "sending" || text.trim() === ""}>Add</button>
      </form>
      {state === "sent" && <div className="row-meta">Sent. It shows here once the factory has recorded it.</div>}
      {state === "failed" && <div className="row-meta">Could not send that. Try again.</div>}
    </div>
  );
}
