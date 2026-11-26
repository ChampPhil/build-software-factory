"use client";

import { useEffect, useState } from "react";
import type { WorkflowRunSummary } from "@/lib/github";
import { useActions, useHealthIssues, useStandingGoals, useWriters } from "@/lib/data";
import { ago, clock, day } from "@/lib/view";
import { useApp } from "@/components/app";
import { AskFactory, Goals, SettingsForm } from "@/components/settings";
import { WorkflowState } from "@/components/run-view";
import { Check, Cross, Loading, Out } from "@/components/ui";
import { EmptyFactoryNote } from "@/components/empty-factory";

const SECTIONS = [
  ["settings", "Settings"],
  ["goals", "Standing goals"],
  ["workflows", "Workflows"],
  ["people", "People"],
  ["health", "Health"],
  ["install", "Installation"],
  ["ask", "Ask for a change"],
] as const;

/** Workflows that can be started by hand with no input. The rest start from a request or an event. */
const RUNNABLE = new Set(["factory-audit.yml", "factory-conflicts.yml", "factory-garden.yml", "factory-merge.yml", "factory-recompile.yml", "factory-review.yml", "factory-rollup.yml", "factory-sync.yml"]);
const WHAT: Readonly<Record<string, string>> = {
  "factory-audit.yml": "Checks merges that skipped the gates",
  "factory-budget-settle.yml": "Settles what each run spent",
  "factory-conflicts.yml": "Rebuilds pull requests that conflict with main",
  "factory-drop.yml": "Drops requests you stop",
  "factory-garden.yml": "Nightly tidying",
  "factory-gates.yml": "The static and verification gates",
  "factory-intake.yml": "Reads new requests and decisions",
  "factory-merge.yml": "Merges what may merge itself",
  "factory-policy.yml": "Stops changes to protected files",
  "factory-recompile.yml": "Recompiles the agent workflows",
  "factory-review.yml": "The factory's self-review",
  "factory-rollup.yml": "Writes the figures this dashboard reads",
  "factory-run.yml": "Builds a request",
  "factory-setup.yml": "Setup",
  "factory-sync.yml": "Keeps the factory's copy of main current",
};

/** How the factory runs here: what it may spend, what merges itself, what it is focused on, and what it runs on. */
export default function Factory() {
  const { client, index, settings, installed, act, repo, version } = useApp();
  const goals = useStandingGoals(client);
  const writers = useWriters(client);
  const actions = useActions(client, version);
  const healthIssues = useHealthIssues(client, version);
  // The shared list holds the newest runs of everything; a quiet workflow can fall off it, so ask for its own last run.
  const [fetched, setFetched] = useState<Record<number, WorkflowRunSummary | null>>({});
  useEffect(() => {
    const list = actions.state === "ready" ? actions.data : null;
    if (list === null) return;
    for (const w of list.workflows) {
      if (list.runs.some((r) => r.workflow_id === w.id) || w.id in fetched) continue;
      void client.lastRunOf(w.id).then((r) => setFetched((f) => ({ ...f, [w.id]: r }))).catch(() => setFetched((f) => ({ ...f, [w.id]: null })));
    }
  }, [actions, client, fetched]);
  const data = index.state === "ready" ? index.data : null;
  const health = data?.health;
  const name = repo.split("/")[1] ?? repo;

  return (
    <main className="wrap">
      <header className="page-head">
        <h1>Factory</h1>
        <p className="rest">How the factory runs on {name}: what it may spend, what it merges by itself, what it&rsquo;s focused on, and what it runs on.</p>
      </header>
      <div className="fac">
        <nav className="subnav" aria-label="Factory sections">
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="fac-main">
          {index.state === "ready" && data === null && <EmptyFactoryNote installed={installed} />}

          <section id="settings">
            <h2 className="sect">Settings</h2>
            {settings.state === "loading" && <Loading what="the settings" />}
            {settings.state === "ready" && settings.data === null && <p className="muted">There&rsquo;s no settings file yet. Setup writes it.</p>}
            {settings.state === "ready" && settings.data !== null && <SettingsForm yaml={settings.data} enforcement={health?.enforcement ?? null} />}
          </section>

          <section id="goals">
            <h2 className="sect">Standing goals</h2>
            <p className="muted">A focus the factory holds for a while. It breaks ties toward it when it chooses what to do next; it never overrides a request.</p>
            <Goals file={goals.state === "ready" ? goals.data : null} />
          </section>

          <section id="workflows">
            <h2 className="sect">Workflows</h2>
            <p className="muted">The GitHub Actions workflows the factory installed. Run any that can start by hand, or re-run one whose last run failed.</p>
            {actions.state === "loading" && <Loading what="the workflows" />}
            {actions.state === "ready" && actions.data === null && <p className="muted">This sign-in can&rsquo;t read GitHub Actions, so the workflows aren&rsquo;t shown. <Out href={`https://github.com/${repo}/actions`}>See them on GitHub</Out></p>}
            {actions.state === "ready" && actions.data !== null && actions.data.workflows.length === 0 && <p className="muted">No factory workflows on this repository yet.</p>}
            {actions.state === "ready" && actions.data !== null && actions.data.workflows.length > 0 && (
              <div className="table wf-t" role="table" aria-label="Workflows">
                {actions.data.workflows.map((w) => {
                  const file = w.path.split("/").pop() ?? w.path;
                  const last = actions.data!.runs.find((r) => r.workflow_id === w.id) ?? fetched[w.id] ?? undefined;
                  return (
                    <div className="tr" role="row" key={w.id}>
                      <span role="cell" className="t">
                        <b>{WHAT[file] ?? w.name}</b>
                        <small>
                          <code>{file}</code>
                          {w.state !== "active" ? `, ${w.state.replace(/_/g, " ")}` : ""}
                        </small>
                      </span>
                      <span role="cell" className="wf-state">
                        {last === undefined ? <span className="muted">No recent run</span> : <><WorkflowState run={last} /><small>{ago(last.created_at)}</small></>}
                      </span>
                      <span role="cell" className="r">
                        {last?.conclusion === "failure" && (
                          <button className="btn small" type="button" onClick={() => void act(() => client.rerunFailedJobs(last.id), "Re-running the failed jobs.")}>
                            Re-run failed jobs
                          </button>
                        )}
                        {last !== undefined && last.status !== "completed" && (
                          <button className="btn small" type="button" onClick={() => void act(() => client.cancelWorkflowRun(last.id), "Cancelling.")}>
                            Cancel
                          </button>
                        )}
                        {RUNNABLE.has(file) ? (
                          <button className="btn small" type="button" onClick={() => void act(() => client.runWorkflowNow(file), `Started ${file}.`)}>
                            Run now
                          </button>
                        ) : (
                          <small className="muted">Starts by itself</small>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section id="people">
            <h2 className="sect">People</h2>
            <p className="muted">Anyone with write access can start work. Requests from anyone else wait for one of you to let them start.</p>
            {writers.state === "ready" && writers.data === null && <p className="muted">This sign-in can&rsquo;t list who has access.</p>}
            {writers.state === "ready" && writers.data !== null && (
              <ul className="goals">
                {writers.data.map((w) => (
                  <li key={w.login}>
                    <span>
                      <b>{w.login}</b>
                      <small>{w.role === "admin" ? "Admin" : w.role === "maintain" ? "Maintain" : "Write"} access</small>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Out href={`https://github.com/${repo}/settings/access`}>Add or remove people on GitHub</Out>
          </section>

          <section id="health">
            <h2 className="sect">Health</h2>
            {healthIssues.state === "ready" && healthIssues.data.length > 0 && (
              <div className="health-issues">
                <h3>Problems the factory reported about itself</h3>
                <ul className="plain-list">
                  {healthIssues.data.map((i) => (
                    <li key={i.number}>
                      <Cross /> <Out href={i.html_url}>#{i.number} {i.title}</Out>{" "}
                      <button className="btn small" type="button" onClick={() => void act(() => client.setIssueState(i.number, "closed"), "Closed. It comes back only if the problem does.")}>
                        Close
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {health === undefined ? (
              <p className="muted">Nothing recorded yet. The first run writes it.</p>
            ) : (
              <ul className="plain-list ok-list">
                <li>
                  {health.gardening_schedule_active === false ? <Cross /> : <Check />}
                  {health.gardening_schedule_active === false ? "Nightly gardening is off: GitHub turns schedules off after 60 days without activity. Run it once to turn it back on." : "Nightly gardening is scheduled."}
                </li>
                <li>
                  {health.lock_files_current === false ? <Cross /> : <Check />}
                  {health.lock_files_current === false ? "The workflow lock files are out of date, so agent workflows won't start. Run recompile." : "Workflow lock files match their sources."}
                </li>
                <li>
                  <Check />
                  {health.enforcement === "audit"
                    ? "Audit mode: a merge that skipped the gates gets a revert pull request."
                    : "Branch protection requires the factory's checks on main."}
                </li>
                {health.sandbox_profile !== undefined && (
                  <li>
                    <Check />
                    The sandbox runs as <code>{health.sandbox_profile}</code>
                    {health.sandbox_profile === "docker-sudo-iptables" ? ", which this app's services need; it isolates less than the default." : "."}
                  </li>
                )}
                {health.last_review !== undefined && (
                  <li>
                    <Check />
                    Last self-review {ago(health.last_review)}.
                  </li>
                )}
              </ul>
            )}
          </section>

          <section id="install">
            <h2 className="sect">Installation</h2>
            {data === null ? (
              <p className="muted">Not set up yet.</p>
            ) : (
              <dl className="kv wide">
                <dt>Runner</dt>
                <dd>
                  {data.factory.runner}
                  {data.factory.setup_completed_at !== undefined ? `, set up ${day(data.factory.setup_completed_at)}` : ""}
                </dd>
                <dt>Agent</dt>
                <dd>{data.factory.harness.replace(/-/g, " ")}</dd>
                <dt>Records</dt>
                <dd>
                  Kept in this repository under <code>refs/factory/data</code>, last written {clock(data.updated_at)}.
                </dd>
              </dl>
            )}
            <p className="muted small">
              To remove the factory, run <code>/setup-my-software-factory uninstall</code> from your coding agent in this repository.
            </p>
          </section>

          <section id="ask">
            <h2 className="sect">Ask for a change</h2>
            <p className="muted">For something there&rsquo;s no control for here. Say it in your own words; it&rsquo;s filed as a request and answered on the issue.</p>
            <AskFactory />
          </section>
        </div>
      </div>
    </main>
  );
}
