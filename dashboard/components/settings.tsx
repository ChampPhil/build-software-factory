"use client";

import { useEffect, useMemo, useState } from "react";
import { applySettingsChange, type SettingsOutcome, type Stage } from "@/lib/apply-settings";
import { SETTINGS, applySettings, changesFrom, describeValue, readSettings, type Setting, type SettingValue } from "@/lib/settings";
import { saveButtonLabel, saveHint } from "@/lib/save-copy";
import { storedEnforcement } from "@/lib/settings";
import { GOAL_LANES, liveGoals } from "@/lib/routing";
import { day, hourLabel, pipeName } from "@/lib/view";
import type { StandingGoalsFile } from "@/lib/types";
import { useApp, explain } from "@/components/app";
import { usePull, useCheckRuns } from "@/lib/data";
import { Out } from "@/components/ui";

const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  reading: "Reading the current settings…",
  opening: "Opening the change…",
  checking: "Waiting for the factory's policy check…",
  merging: "Merging…",
};

const ORDER = ["monthly_budget", "share_product_work", "share_gardening", "share_review", "auto_merge_product_work", "auto_merge_gardening", "auto_merge_hardening", "auto_merge_definition_change", "auto_merge_conflict_fix", "gardening_prs", "gardening_hour"];
const SHARE_IDS = ["share_product_work", "share_gardening", "share_review"];

/**
 * The settings a person may change, each with its own control. Saving opens a
 * pull request that changes the factory's settings file and merges it once the
 * policy check passes, as the signed-in person: nobody opens a file.
 */
export function SettingsForm({ yaml, enforcement }: { yaml: string; enforcement: "branch_protection" | "audit" | null }) {
  const { client, toast, bump, demo } = useApp();
  const current = useMemo(() => readSettings(yaml), [yaml]);
  const [draft, setDraft] = useState<Record<string, SettingValue>>({ ...current });
  const [stage, setStage] = useState<Stage | null>(null);
  const [outcome, setOutcome] = useState<SettingsOutcome | null>(null);
  // A new copy of the settings (after a save, or another person's change) resets the controls to it.
  useEffect(() => setDraft({ ...current }), [current]);

  const changes = changesFrom(current, draft);
  const pending = Object.keys(changes).length;
  const problem = pending === 0 ? null : (applySettings(yaml, changes).problems[0]?.message ?? null);
  const shareTotal = SHARE_IDS.reduce((n, id) => n + (typeof draft[id] === "number" ? draft[id] : 0), 0);
  const by = (id: string): Setting | undefined => SETTINGS.find((s) => s.id === id);
  const set = (id: string, v: SettingValue): void => setDraft((d) => ({ ...d, [id]: v }));
  const busy = stage !== null;

  const save = async (): Promise<void> => {
    setOutcome(null);
    try {
      const result = await applySettingsChange(client, changes, { onStage: setStage, enforcement, planLimited: storedEnforcement(yaml) === "audit" });
      setOutcome(result);
      if (result.status === "applied") {
        toast("Settings saved.");
        bump();
      }
    } catch (e) {
      setOutcome({ status: "failed", message: explain(e) });
    } finally {
      setStage(null);
    }
  };

  const row = (id: string) => {
    const s = by(id);
    if (s === undefined) return null;
    const v = draft[id] ?? null;
    const was = current[id] ?? null;
    const changed = v !== was && was !== null;
    const label = (
      <div>
        <label htmlFor={`s-${id}`}>
          <b>{s.label}</b>
        </label>
        <p className="muted small">
          {s.help}
          {changed && <> Was {describeValue(s, was)}.</>}
        </p>
      </div>
    );
    if (s.kind === "boolean") {
      return (
        <div className="setting" key={id}>
          {label}
          <span className="switch">
            <input id={`s-${id}`} type="checkbox" role="switch" checked={v === true} disabled={busy} onChange={(e) => set(id, e.target.checked)} />
            <span />
          </span>
        </div>
      );
    }
    if (s.kind === "cron_hour") {
      return (
        <div className="setting" key={id}>
          {label}
          <select id={`s-${id}`} className="field narrow" style={{ minWidth: "14ch" }} value={v === null ? "" : String(v)} disabled={busy} onChange={(e) => set(id, e.target.value === "" ? null : Number(e.target.value))}>
            {v === null && <option value="">Not scheduled</option>}
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
        </div>
      );
    }
    return (
      <div className="setting" key={id}>
        {label}
        <span className="unit-in">
          {s.unit === "usd" && <span>$</span>}
          <input
            id={`s-${id}`}
            className="field"
            type="number"
            value={v === null ? "" : String(v)}
            min={s.min}
            max={s.max}
            step={s.kind === "number" ? "any" : 1}
            disabled={busy}
            onChange={(e) => set(id, e.target.value === "" ? null : Number(e.target.value))}
          />
          {s.unit === "percent" && <span>%</span>}
        </span>
      </div>
    );
  };

  return (
    <form
      className="settings"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {ORDER.filter((id) => !SHARE_IDS.includes(id)).slice(0, 1).map(row)}
      <div className="setting">
        <div>
          <b>How the budget is shared</b>
          <p className="muted small">
            What each kind of work may use.{" "}
            {shareTotal === 100 ? "Adds up to 100%." : <span className="warn">Adds up to {shareTotal}%; it has to be 100%.</span>}
          </p>
        </div>
        <div className="shares">
          {SHARE_IDS.map((id) => {
            const s = by(id);
            if (s === undefined) return null;
            return (
              <label key={id}>
                {s.label.replace(/^Share for\s*/i, "").replace(/ share$/i, "")}
                <span className="unit-in">
                  <input className="field" type="number" min={0} max={100} value={draft[id] === null || draft[id] === undefined ? "" : String(draft[id])} disabled={busy} onChange={(e) => set(id, e.target.value === "" ? null : Number(e.target.value))} />
                  <span>%</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      {ORDER.filter((id) => !SHARE_IDS.includes(id)).slice(1).map(row)}
      <div className="acts">
        <button className="btn go" type="submit" disabled={pending === 0 || problem !== null || busy}>
          {saveButtonLabel(enforcement, pending)}
        </button>
        {pending > 0 && !busy && (
          <button className="btn quiet" type="button" onClick={() => setDraft({ ...current })}>
            Undo
          </button>
        )}
        <span className="muted small" role="status">
          {busy
            ? STAGE_TEXT[stage]
            : problem !== null
              ? problem
              : demo
                ? "In the demo, saving is refused like every change."
                : saveHint(enforcement, storedEnforcement(yaml) === "audit")}
        </span>
      </div>
      {outcome !== null && (
        <p className={outcome.status === "applied" || outcome.status === "unchanged" ? "note" : "note stop"} role="status">
          {outcome.status === "applied" && (
            <>
              Saved: {outcome.summary.join("; ")}. <Out href={outcome.url}>See the change</Out>
            </>
          )}
          {outcome.status === "open" && (
            <>
              {outcome.reason} <Out href={outcome.url}>Pull request #{outcome.pr}</Out>
              <MergeIt pr={outcome.pr} onDone={() => { setOutcome(null); bump(); }} />
            </>
          )}
          {outcome.status === "unchanged" && "Nothing to change."}
          {outcome.status === "refused" && outcome.problems.map((p) => p.message).join(" ")}
          {outcome.status === "failed" && outcome.message}
        </p>
      )}
    </form>
  );
}

/** After saving on an audit repository: a Merge button once the pull request is a non-draft with factory/gates green, else the pending check. */
function MergeIt({ pr, onDone }: { pr: number; onDone: () => void }) {
  const { client, act, version } = useApp();
  const pull = usePull(client, pr, version);
  const sha = pull.state === "ready" && pull.data !== null ? pull.data.head.sha : null;
  const checks = useCheckRuns(client, sha);
  if (pull.state !== "ready" || pull.data === null || checks.state !== "ready") return null;
  // A settings change has no verification step: factory/gates is the check that matters.
  const gates = checks.data.find((c) => c.name === "factory/gates");
  const label = pull.data.draft
    ? "In review: still a draft"
    : gates === undefined || gates.status !== "completed"
      ? "In review: waiting on factory/gates"
      : gates.conclusion === "success"
        ? "Ready to merge"
        : "In review: waiting on factory/gates (" + (gates.conclusion ?? "no result") + ")";
  if (label !== "Ready to merge") return <> {label.replace("In review: ", "Not yet: ")}.</>;
  return (
    <>
      {" "}
      <button className="btn small go" type="button" onClick={() => void act(() => client.mergePull(pr, "squash"), "Merged. The setting takes effect now.").then((ok) => ok && onDone())}>
        Merge it
      </button>
    </>
  );
}

/** A focus the factory holds for a while. Added and removed through intake, so it is recorded like everything else. */
export function Goals({ file }: { file: StandingGoalsFile | null }) {
  const { client, act } = useApp();
  const [text, setText] = useState("");
  const [lane, setLane] = useState("");
  const goals = liveGoals(file);
  return (
    <>
      <ul className="goals">
        {goals.length === 0 && <li className="muted">No goals. The factory works on requests in the order they come.</li>}
        {goals.map((g) => (
          <li key={g.id}>
            <span>
              <b>{g.text}</b>
              <small>
                {g.lane === null ? "Any kind of work" : pipeName(g.lane)}, set by {g.by} {day(g.at)}
                {g.until !== null ? `, until ${day(g.until)}` : ""}
              </small>
            </span>
            <button className="btn small" type="button" onClick={() => void act(() => client.removeStandingGoal(g.id), "Removing the goal. It goes once the factory has recorded it.")}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="goal-form"
        onSubmit={(e) => {
          e.preventDefault();
          const words = text.trim();
          if (words === "") return;
          void act(() => client.addStandingGoal(words, lane === "" ? null : lane), "Goal sent. It shows here once the factory has recorded it.").then((ok) => ok && setText(""));
        }}
      >
        <input className="field" value={text} maxLength={200} placeholder="For example: harden sign-in this month" aria-label="New goal" onChange={(e) => setText(e.target.value)} />
        <select className="field narrow" value={lane} aria-label="For which kind of work" onChange={(e) => setLane(e.target.value)}>
          {GOAL_LANES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label.charAt(0).toUpperCase() + l.label.slice(1)}
            </option>
          ))}
        </select>
        <button className="btn" type="submit" disabled={text.trim() === ""}>
          Add goal
        </button>
      </form>
      <p className="muted small">You can also write /focus followed by a goal in any issue comment.</p>
    </>
  );
}

/** For a change there is no control for yet. The words go to the factory as a request; nobody is pointed at a file. */
export function AskFactory() {
  const { client, act, compose } = useApp();
  const [text, setText] = useState("");
  const [about, setAbout] = useState<"settings" | "product" | null>(null);
  if (about === null) {
    return (
      <div className="ask-form">
        <p><b>Is this about the factory&rsquo;s own settings?</b></p>
        <div className="acts">
          <button className="btn" type="button" onClick={() => setAbout("settings")}>Yes, the factory itself</button>
          <button className="btn" type="button" onClick={() => compose()}>No, a change to my product</button>
        </div>
      </div>
    );
  }
  return (
    <form
      className="ask-form"
      onSubmit={(e) => {
        e.preventDefault();
        const words = text.trim();
        if (words === "") return;
        const first = words.split("\n")[0]!.slice(0, 70);
        void act(() => client.createIssue(`[Settings] ${first}`, `### What should change?\n\n${words}`, ["factory:ask"]), "Sent. The factory answers on the issue.").then((ok) => ok && setText(""));
      }}
    >
      <textarea className="field" rows={3} value={text} maxLength={2000} aria-label="What should change" placeholder="For example: use a cheaper model for triage" onChange={(e) => setText(e.target.value)} />
      <div className="acts">
        <button className="btn" type="submit" disabled={text.trim() === ""}>
          Ask the factory
        </button>
      </div>
    </form>
  );
}
