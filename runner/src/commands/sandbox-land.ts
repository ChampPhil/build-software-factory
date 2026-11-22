import type { GitHub } from "../lib/github.js";
import type { FactoryStore, Ledger } from "../lib/store.js";
import { markLanded } from "./sandbox-reports.js";
import { tierAtLeast, type Dependency, type SandboxManifest } from "./sandbox.js";

/**
 * `bsf sandbox land`: an amendment of the sandbox merges itself when it is
 * safe to, and the changes that were stuck on it are verified again.
 *
 * The sandbox is protected because it decides what an agent may reach. An
 * amendment is let through without a person only when it cannot widen that:
 * it changes nothing outside .factory/sandbox/, adds no host to egress and
 * no secret to the environment, and its trial reached at least the tier and
 * proved at least the dependencies main's sandbox did. Anything else waits
 * for a person, who is told which condition stopped it.
 */

export interface LandInput {
  readonly mode: "automatic" | "reviewed";
  readonly files: readonly string[];
  readonly main: SandboxManifest | null;
  readonly candidate: SandboxManifest;
}

export function landBlockers(i: LandInput): readonly string[] {
  const out: string[] = [];
  if (i.mode === "reviewed") out.push("policy.yaml sets sandbox_repairs: reviewed");
  const outside = i.files.filter((f) => !f.startsWith(".factory/sandbox/"));
  if (outside.length > 0) out.push(`it changes files outside .factory/sandbox/: ${outside.slice(0, 5).join(", ")}`);
  if (i.main === null) {
    out.push("there is no sandbox on main to compare it with");
    return out;
  }
  const egress = new Set(((i.main as { egress?: string[] }).egress ?? []).map((h) => h.toLowerCase()));
  const newHosts = ((i.candidate as { egress?: string[] }).egress ?? []).filter((h) => !egress.has(h.toLowerCase()));
  if (newHosts.length > 0) out.push(`it lets the sandbox reach new hosts: ${newHosts.join(", ")}`);
  const secrets = new Set(i.main.env.filter((v) => v.secret !== undefined).map((v) => v.secret));
  const newSecrets = i.candidate.env.filter((v) => v.secret !== undefined && !secrets.has(v.secret)).map((v) => v.secret ?? "");
  if (newSecrets.length > 0) out.push(`it needs secrets main's sandbox does not: ${newSecrets.join(", ")}`);
  if (!tierAtLeast(i.candidate.tier, i.main.tier)) {
    out.push(`its trial reached ${i.candidate.tier}, below main's ${i.main.tier}`);
  }
  const proven = (deps: readonly Dependency[] | undefined): Set<string> =>
    new Set((deps ?? []).filter((d) => d.proven === true).map((d) => d.name.toLowerCase()));
  const now = proven(i.candidate.dependencies);
  const lost = [...proven(i.main.dependencies)].filter((n) => !now.has(n));
  if (lost.length > 0) out.push(`it no longer proves what main's sandbox did: ${lost.join(", ")}`);
  if (i.main.sign_in !== undefined && i.candidate.sign_in === undefined) out.push("it loses the signed-in session main's sandbox has");
  return out;
}

export interface AmendRequest {
  readonly reports: readonly { readonly key?: string; readonly work_item?: string }[];
}

export async function landAmendment(opts: {
  readonly gh: GitHub;
  readonly store: FactoryStore;
  readonly ledger: Ledger;
  readonly pr: number;
  readonly input: Omit<LandInput, "files">;
  readonly amend: AmendRequest;
  readonly verifyLabel: string;
  readonly now: string;
  readonly log: (l: string) => void;
}): Promise<{ merged: boolean; blockers: readonly string[]; reverified: readonly number[] }> {
  const files = (await opts.gh.pullFiles(opts.pr)).map((f) => f.filename);
  const blockers = landBlockers({ ...opts.input, files });
  if (blockers.length > 0) {
    const body =
      "This amendment waits for a person, because:\n\n" +
      blockers.map((b) => `- ${b}`).join("\n") +
      "\n\nMerge it if the sandbox should change this way; the changes that reported the need are verified again when the factory next runs them.";
    await opts.gh.send("POST", `repos/${opts.gh.repo}/issues/${opts.pr}/comments`, { body }).catch(() => undefined);
    for (const b of blockers) opts.log(`not merging: ${b}`);
    return { merged: false, blockers, reverified: [] };
  }
  try {
    await opts.gh.send("PUT", `repos/${opts.gh.repo}/pulls/${opts.pr}/merge`, {
      merge_method: "squash",
      commit_title: `Amend the factory's sandbox (#${opts.pr})`,
    });
  } catch (e) {
    const why = `GitHub refused the merge: ${(e as Error).message.split("\n")[0] ?? ""}`;
    await opts.gh
      .send("POST", `repos/${opts.gh.repo}/issues/${opts.pr}/comments`, {
        body: `This amendment met every condition to merge itself, but ${why}. Branch protection on the default branch is the usual cause; merge it by hand.`,
      })
      .catch(() => undefined);
    opts.log(why);
    return { merged: false, blockers: [why], reverified: [] };
  }
  opts.log(`merged #${opts.pr}: it changes only the sandbox and proves at least what main's did`);
  const keys = opts.amend.reports.map((r) => r.key).filter((k): k is string => typeof k === "string");
  await markLanded(opts.store, keys, opts.now);

  // The changes that ran into the old sandbox: judged again, against the new one.
  const items = new Set(opts.amend.reports.map((r) => r.work_item).filter((w): w is string => typeof w === "string"));
  const prs = [...new Set(opts.ledger.open.filter((o) => items.has(o.work_item) && typeof o.pr === "number").map((o) => o.pr as number))];
  const reverified: number[] = [];
  for (const pr of prs) {
    // Bring the branch up to date with main, which now holds the amended
    // sandbox. That is a push by the factory's App, the one event gh-aw lets
    // an App's checkout through for a verifier (a label event is refused), and
    // the new head is a commit nothing has judged, so it is verified in full.
    const updated = await opts.gh.send("PUT", `repos/${opts.gh.repo}/pulls/${pr}/update-branch`, {}).then(() => true, () => false);
    if (updated) {
      reverified.push(pr);
      opts.log(`#${pr}: brought up to date with main; it is verified again against the amended sandbox`);
      continue;
    }
    // Already level with main: nothing to push, so ask by label, which a
    // person's account honours.
    const label = encodeURIComponent(opts.verifyLabel);
    await opts.gh.send("DELETE", `repos/${opts.gh.repo}/issues/${pr}/labels/${label}`).catch(() => undefined);
    const ok = await opts.gh
      .send("POST", `repos/${opts.gh.repo}/issues/${pr}/labels`, { labels: [opts.verifyLabel] })
      .then(() => true, () => false);
    if (ok) reverified.push(pr);
    opts.log(ok ? `#${pr}: verifying again against the amended sandbox` : `#${pr}: could not ask for verification again`);
  }
  return { merged: true, blockers: [], reverified };
}
