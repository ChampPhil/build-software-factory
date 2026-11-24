"use client";

import { useEffect, useMemo, useState } from "react";
import type { GitHubClient } from "@/lib/github";
import { applySettingsChange, type SettingsOutcome, type Stage } from "@/lib/apply-settings";
import { SETTINGS, applySettings, changesFrom, describeValue, readSettings, type Setting, type SettingValue } from "@/lib/settings";

const GROUPS: readonly { readonly title: string; readonly ids: readonly string[] }[] = [
  { title: "Budget", ids: ["monthly_budget", "share_product_work", "share_gardening", "share_review"] },
  { title: "Merge by itself", ids: ["auto_merge_product_work", "auto_merge_gardening", "auto_merge_hardening"] },
  { title: "Nightly cleanup", ids: ["gardening_prs", "gardening_hour"] },
];

const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  reading: "Reading the current settings…",
  opening: "Opening the change…",
  checking: "Waiting for the factory's check…",
  merging: "Merging…",
};

/**
 * The settings a person may change, each with its own control. Saving applies
 * the change in one step as the signed-in person; nobody opens a file.
 */
export function SettingsPanel({
  client, yaml, onApplied, enforcement,
}: {
  client: GitHubClient;
  yaml: string;
  onApplied: () => void;
  /** From `index.health.enforcement`; decides whether the policy check can ever finish. */
  enforcement?: "branch_protection" | "audit" | null | undefined;
}) {
  const current = useMemo(() => readSettings(yaml), [yaml]);
  const [draft, setDraft] = useState<Record<string, SettingValue>>({ ...current });
  const [stage, setStage] = useState<Stage | null>(null);
  const [outcome, setOutcome] = useState<SettingsOutcome | null>(null);

  // A new copy of the settings (after a save, or another person's change) resets the controls to it.
  useEffect(() => { setDraft({ ...current }); }, [current]);

  const changes = changesFrom(current, draft);
  const pending = Object.keys(changes).length;
  const check = pending === 0 ? null : applySettings(yaml, changes).problems[0]?.message ?? null;

  const save = async (): Promise<void> => {
    setOutcome(null);
    const result = await applySettingsChange(client, changes, { onStage: setStage, enforcement: enforcement ?? null });
    setStage(null);
    setOutcome(result);
    if (result.status === "applied") onApplied();
  };

  return (
    <div>
      {GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px" }}>{g.title}</h3>
          <div className="rows">
            {g.ids.map((id) => {
              const s = SETTINGS.find((x) => x.id === id);
              if (s === undefined) return null;
              return <Control key={id} setting={s} value={draft[id] ?? null} was={current[id] ?? null} disabled={stage !== null} onChange={(v) => setDraft((d) => ({ ...d, [id]: v }))} />;
            })}
          </div>
        </div>
      ))}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="btn primary" disabled={pending === 0 || check !== null || stage !== null} onClick={() => void save()}>
          {pending === 0 ? "No changes" : `Save ${pending} change${pending === 1 ? "" : "s"}`}
        </button>
        {pending > 0 && stage === null && (
          <button className="btn" onClick={() => setDraft({ ...current })}>Undo</button>
        )}
        {stage !== null && <span className="row-meta">{STAGE_TEXT[stage]}</span>}
        {check !== null && stage === null && <span className="row-meta">{check}</span>}
      </div>
      <Outcome outcome={outcome} />
    </div>
  );
}

function Control({ setting: s, value, was, disabled, onChange }: {
  setting: Setting; value: SettingValue; was: SettingValue; disabled: boolean; onChange: (v: SettingValue) => void;
}) {
  const changed = value !== was;
  return (
    <div className="row" style={{ gridTemplateColumns: "1fr auto" }}>
      <div>
        <div className="row-title">{s.label}{changed && was !== null ? <span className="row-meta"> was {describeValue(s, was)}</span> : null}</div>
        <div className="row-meta">{s.help}</div>
      </div>
      {s.kind === "boolean" ? (
        <label className="row-meta">
          <input type="checkbox" aria-label={s.label} disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {value === true ? "on" : "off"}
        </label>
      ) : (
        <span>
          <input
            type="number"
            aria-label={s.label}
            disabled={disabled}
            value={value === null ? "" : String(value)}
            min={s.min}
            max={s.max}
            step={s.kind === "number" ? "any" : 1}
            style={{ width: 88 }}
            onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          />{" "}
          <span className="row-meta">{s.unit === "usd" ? "USD" : s.unit === "percent" ? "%" : s.unit === "utc_hour" ? "UTC hour" : ""}</span>
        </span>
      )}
    </div>
  );
}

function Outcome({ outcome }: { outcome: SettingsOutcome | null }) {
  if (outcome === null) return null;
  const line = (() => {
    switch (outcome.status) {
      case "applied": return <>Saved: {outcome.summary.join("; ")}. <a href={outcome.url}>See the change</a>.</>;
      case "open": return <>{outcome.reason} <a href={outcome.url}>Pull request #{outcome.pr}</a>.</>;
      case "unchanged": return <>Nothing to change.</>;
      case "refused": return <>{outcome.problems.map((p) => p.message).join(" ")}</>;
      case "failed": return <>{outcome.message}</>;
    }
  })();
  return <div className="note quiet" style={{ marginTop: 8 }} role="status">{line}</div>;
}

/** Everyone with write access: the people the factory acts for. Changed in GitHub's own settings, not here. */
export function WhoCanStart({ repo, writers }: { repo: string; writers: readonly { login: string; role: string }[] | null }) {
  return (
    <div>
      {writers === null ? (
        <div className="row-meta">This token cannot list who has access. GitHub's access page shows it.</div>
      ) : (
        <div className="rows">
          {writers.map((w) => (
            <div className="row" key={w.login} style={{ gridTemplateColumns: "1fr auto" }}>
              <span className="row-title">{w.login}</span>
              <span className="row-meta">{w.role}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row-meta" style={{ marginTop: 8 }}>
        Anyone else&rsquo;s issue waits for an accept on Home. To add or remove a person, use{" "}
        <a href={`https://github.com/${repo}/settings/access`}>the repository&rsquo;s access page on GitHub</a>.
      </div>
    </div>
  );
}

/** For a change there is no control for yet. The words go to the factory as a request; nobody is pointed at a file. */
export function AskFactory({ client }: { client: GitHubClient }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed" | { url: string }>("idle");
  const send = async (): Promise<void> => {
    const words = text.trim();
    if (words === "") return;
    setState("sending");
    try {
      const first = words.split("\n")[0]!.slice(0, 70);
      const issue = await client.createIssue(`[Settings] ${first}`, `### What should change?\n\n${words}`, ["factory:ask"]);
      setState({ url: issue.html_url });
      setText("");
    } catch {
      setState("failed");
    }
  };
  return (
    <div>
      <textarea
        aria-label="What should change"
        rows={3}
        value={text}
        maxLength={2000}
        placeholder="e.g. use a cheaper model for triage"
        style={{ width: "100%" }}
        onChange={(e) => setText(e.target.value)}
      />
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 8 }}>
        <button className="btn primary" disabled={text.trim() === "" || state === "sending"} onClick={() => void send()}>Ask the factory</button>
        {state === "failed" && <span className="row-meta">Could not send that. Try again.</span>}
        {typeof state === "object" && <span className="row-meta">Sent. <a href={state.url}>Follow it on the issue</a>.</span>}
      </div>
    </div>
  );
}
