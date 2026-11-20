"use client";

import { useMemo } from "react";
import { readSession } from "@/lib/session";
import { useClient, useIndex } from "@/lib/data";
import { PageHead, Section, Note, Empty, Dot } from "@/components/primitives";

/**
 * How the factory is configured.
 *
 * Read-only on purpose. Every setting here lives in the factory definition,
 * and a change to it goes through a pull request so there is a commit saying
 * who changed what — a toggle that silently rewrote a file would be the one
 * part of the factory with no audit trail.
 */
export default function Factory() {
  const session = useMemo(() => readSession(), []);
  const auth = session === null ? null : { token: session.token, repo: session.repo };
  const client = useClient(auth);
  const index = useIndex(client);

  const data = index.state === "ready" ? index.data : null;
  const health = data?.health;
  const repo = session?.repo;

  return (
    <>
      <PageHead
        title="Factory"
        lede="How this factory is set up. Changing any of it opens a pull request against the factory definition, so every change has a commit behind it."
      />

      {data === null && index.state === "ready" && (
        <Empty title="No factory data yet">
          Once setup has run, this page reads the definition from the repository.
        </Empty>
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
            {repo !== undefined && (
              <div style={{ marginTop: 12 }}>
                <Note tone="quiet">
                  Edit{" "}
                  <a className="mono" href={`https://github.com/${repo}/blob/HEAD/.factory/definition/factory.yaml`}>
                    .factory/definition/factory.yaml
                  </a>{" "}
                  to change a toggle. The policy check requires a trusted person&rsquo;s approval on
                  any pull request that touches the definition.
                </Note>
              </div>
            )}
          </Section>
        </>
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
