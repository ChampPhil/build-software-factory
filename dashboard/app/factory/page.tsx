"use client";

import { useMemo, useState } from "react";
import { readSession } from "@/lib/session";
import { useClient, useFactorySettings, useIndex, useStandingGoals, useWriters } from "@/lib/data";
import { AskFactory, SettingsPanel, WhoCanStart } from "@/components/settings";
import { StandingGoals } from "@/components/routing";
import { PageHead, Section, Dot } from "@/components/primitives";
import { EmptyFactoryNote } from "@/components/empty-factory";

/**
 * How the factory is configured, and where a person changes it.
 *
 * Every setting a person may change has a control here. Saving opens a pull
 * request and merges it as the signed-in person, so there is still a commit
 * saying who changed what, without anyone opening a file. What a control
 * cannot do yet goes through "Ask the factory".
 */
export default function Factory() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const index = useIndex(client);
  const goals = useStandingGoals(client);
  const [version, setVersion] = useState(0);
  const settings = useFactorySettings(client, version);
  const writers = useWriters(client);

  const data = index.state === "ready" ? index.data : null;
  const health = data?.health;
  const repo = session?.repo;

  return (
    <>
      <PageHead
        title="Factory"
        lede="How this factory is set up. Change a setting here and it is saved in one step; every change is still a commit with your name on it."
      />

      {data === null && index.state === "ready" && (
        <EmptyFactoryNote installed={settings.state === "ready" ? settings.data !== null : null} />
      )}

      {data !== null && (
        <>
          <Section title="Version">
            <div className="rows">
              <Row label="Runner" value={data.factory.runner} />
              <Row label="Harness" value={data.factory.harness} />
              {data.factory.setup_completed_at !== undefined && (
                <Row label="Set up" value={new Date(data.factory.setup_completed_at).toLocaleDateString()} />
              )}
            </div>
          </Section>

          <Section
            title="Health"
            lede="What has to be true for the factory to run. Anything wrong here stops work rather than producing bad work."
          >
            <div className="rows">
              <HealthRow
                label="Lock files"
                ok={health?.lock_files_current !== false}
                good="Current"
                bad="Need recompiling — role workflows will not start"
              />
              <HealthRow
                label="Nightly gardening"
                ok={health?.gardening_schedule_active !== false}
                good="Scheduled"
                bad="Disabled by GitHub after 60 days without activity"
              />
              <Row
                label="Enforcement"
                value={
                  health?.enforcement === "audit"
                    ? "Audit mode — a merge that skipped the gates gets a revert pull request"
                    : health?.enforcement === "branch_protection"
                      ? "Branch protection — the gates are required checks"
                      : "Not recorded"
                }
              />
              {health?.sandbox_profile !== undefined && (
                <Row
                  label="Sandbox"
                  value={
                    health.sandbox_profile === "docker-sudo-iptables"
                      ? "docker-sudo-iptables — needed for this app's sidecar services, and a weaker isolation level than the default"
                      : health.sandbox_profile
                  }
                />
              )}
            </div>
          </Section>

          {client !== null && (
            <Section
              title="Standing goals"
              lede="What to lean toward for a while. They break ties when the chief of staff and the gardener choose; they never override a request. You can also write /focus followed by a goal in any issue comment."
            >
              <StandingGoals client={client} file={goals.state === "ready" ? goals.data : null} />
            </Section>
          )}

          <Section
            title="Autonomy"
            lede="Every toggle starts off, so a person approves each draft pull request. Turn one on when its revert rate and scorer results give you reason to."
          >
            <div className="rows">
              {["product_work", "gardening", "hardening"].map((p) => {
                const metrics = data.metrics.by_pipeline?.[p];
                return (
                  <div className="row" key={p} style={{ gridTemplateColumns: "1fr auto auto auto" }}>
                    <span className="row-title">{p.replace(/_/g, " ")}</span>
                    <span className="row-meta">
                      {metrics?.runs === undefined ? "no runs yet" : `${metrics.runs} runs`}
                    </span>
                    <span className="row-meta">
                      {metrics?.revert_rate === undefined
                        ? "no revert data"
                        : `${(metrics.revert_rate * 100).toFixed(1)}% reverted`}
                    </span>
                    <span className="row-meta">{metrics?.paused === true ? "paused — budget" : "—"}</span>
                  </div>
                );
              })}
            </div>
          </Section>
        </>
      )}

          {client !== null && settings.state === "ready" && settings.data !== null && (
            <Section title="Settings" lede="Changes save in one step, as you. The factory's own check still has to pass.">
              <SettingsPanel client={client} yaml={settings.data} onApplied={() => setVersion((v) => v + 1)} />
            </Section>
          )}

          {client !== null && repo !== undefined && (
            <Section title="Who can start work" lede="The factory acts on requests from people with write access to this repository.">
              <WhoCanStart repo={repo} writers={writers.state === "ready" ? writers.data : null} />
            </Section>
          )}

          {client !== null && (
            <Section title="Ask the factory" lede="For a change that has no control above. Say what you want in your own words; it is filed as a request and answered on the issue.">
              <AskFactory client={client} />
            </Section>
          )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ gridTemplateColumns: "180px 1fr" }}>
      <span className="row-meta">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function HealthRow({ label, ok, good, bad }: { label: string; ok: boolean; good: string; bad: string }) {
  return (
    <div className="row" style={{ gridTemplateColumns: "180px auto 1fr" }}>
      <span className="row-meta">{label}</span>
      <Dot tone={ok ? "pass" : "fail"} />
      <span>{ok ? good : bad}</span>
    </div>
  );
}
