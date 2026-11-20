import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  synthesizeEnv,
  dependenciesFromDockerfile,
  REGISTRY_ALLOWLIST,
  BLOCKED_HOST,
  envVarsViaHelper,
  unenumerableEnvReads,
  DENY_BY_DEFAULT_RATIONALE,
  type SynthesizedVar,
  type DockerfileDependencies,
} from "../lib/sandbox.js";
import { scriptHazards, describeHazard, type ScriptHazard } from "../lib/script_hazards.js";
import { envVarsUsed, isTestPath, IGNORED_ENV } from "./consistency.js";

/**
 * `bsf sandbox-plan` — what the sandbox gets, derived rather than inherited.
 *
 * Phase 2 used to tell the agent to build the sandbox by judgment, from prose
 * that contradicted itself about credentials. This produces the answer
 * mechanically, so the sandbox is the same whichever agent builds it and the
 * user can read what it will contain before it runs.
 */

export interface SandboxPlan {
  readonly env: readonly SynthesizedVar[];
  readonly allowedHosts: readonly string[];
  readonly dependencies: DockerfileDependencies | null;
  /**
   * Commands that touch persistent state. Diagnostics, not guards: with the
   * env above, each one acts on a throwaway target. They are listed so the
   * runbook records which verification steps have side effects at all.
   */
  readonly sideEffects: readonly ScriptHazard[];
  /**
   * What verification cannot establish, given which variables are inert. The
   * honest counterweight to a sandbox that denies everything: a factory that
   * cannot send an email also cannot verify that email sending works.
   */
  readonly cannotVerify: readonly string[];
  /**
   * Always true, and recorded so it appears in the artifact rather than only
   * in this comment: the sandbox receives exactly `env` and nothing else.
   */
  readonly denyByDefault: true;
  /**
   * Env reads this scan could not resolve to a name, with where. Not a
   * failure: the proof that `denyByDefault` is doing the work, since these
   * are exactly the variables the plan cannot list.
   */
  readonly unenumerable: readonly { readonly file: string; readonly expression: string }[];
}

export interface SandboxPlanInput {
  readonly root: string;
  readonly files: readonly string[];
  readonly read?: (path: string) => string;
}

/** Capability names inferred from inert variables, for `cannotVerify`. */
const CAPABILITY: readonly { match: RegExp; what: string }[] = [
  { match: /RESEND|SENDGRID|POSTMARK|MAILGUN|SMTP|_EMAIL_|EMAIL_FROM/, what: "sending email" },
  { match: /STRIPE|PADDLE|BRAINTREE|PAYPAL/, what: "taking payments" },
  { match: /OAUTH|AUTH_JS|CLERK|AUTH0|NEXTAUTH/, what: "signing in through the real identity provider" },
  { match: /S3|GCS|BLOB|CLOUDINARY|UPLOADTHING/, what: "reading or writing object storage" },
  { match: /GOOGLESHEETS|AIRTABLE|NOTION|SALESFORCE/, what: "reading the external data source" },
  { match: /ANTHROPIC|OPENAI|GEMINI|COHERE|MISTRAL/, what: "calling the model provider" },
  { match: /TWILIO|SLACK|DISCORD|TELEGRAM|PUSHER/, what: "sending notifications" },
];

export function planSandbox(input: SandboxPlanInput): SandboxPlan {
  const read = input.read ?? ((p: string) => readFileSync(join(input.root, p), "utf8"));
  const exists = (p: string): boolean =>
    input.read === undefined ? existsSync(join(input.root, p)) : safe(() => input.read?.(p)) !== null;

  /* ------------------------------------- every variable the app actually reads */

  const names = new Set<string>();
  const unenumerable: { file: string; expression: string }[] = [];
  for (const file of input.files) {
    // A name invented inside a test fixture is not a variable the app needs,
    // and synthesizing it pads the sandbox with settings nothing reads.
    if (isTestPath(file)) continue;
    const text = safe(() => read(file));
    if (text === null) continue;
    for (const name of [...envVarsUsed(text), ...envVarsViaHelper(text)]) {
      if (!IGNORED_ENV.has(name)) names.add(name);
    }
    for (const expression of unenumerableEnvReads(text)) {
      unenumerable.push({ file, expression });
    }
  }
  const env = synthesizeEnv([...names]);

  /* ------------------------------------------- the environment, not the intent */

  const dockerfile = ["Dockerfile", "docker/Dockerfile", ".devcontainer/Dockerfile"].find(exists);
  const dependencies = dockerfile === undefined ? null : dependenciesFromDockerfile(read(dockerfile));

  /* ----------------------------------------------- side effects, as diagnostics */

  const manifest = exists("package.json") ? "package.json" : null;
  const pkg =
    manifest === null ? null : (safeJson(() => read(manifest)) as { scripts?: Record<string, string> } | null);
  const sideEffects = pkg?.scripts === undefined ? [] : scriptHazards(pkg.scripts);

  /* ---------------------------------------------- what this sandbox cannot show */

  const inert = env.filter((v) => v.kind === "inert").map((v) => v.name);
  const cannotVerify = [
    ...new Set(CAPABILITY.filter((c) => inert.some((n) => c.match.test(n))).map((c) => c.what)),
  ].sort();

  return {
    env,
    allowedHosts: REGISTRY_ALLOWLIST,
    dependencies,
    sideEffects,
    cannotVerify,
    denyByDefault: true,
    unenumerable,
  };
}

/** The plan as the runbook section phase 2 is meant to write. */
export function formatPlan(plan: SandboxPlan): string {
  const lines: string[] = [];

  lines.push("## Sandbox environment");
  lines.push("");
  lines.push(
    "Every value below is synthesized. No credential of yours is present, so a command " +
      "that tries to reach production fails rather than succeeding against the real thing.",
  );
  lines.push("");
  lines.push(DENY_BY_DEFAULT_RATIONALE);
  lines.push("");

  const usable = plan.env.filter((v) => v.kind === "usable");
  if (usable.length > 0) {
    lines.push("Backed by a real throwaway service in the sandbox:");
    lines.push("");
    for (const v of usable) lines.push(`- \`${v.name}\` — ${v.rationale}`);
    lines.push("");
  }

  const inert = plan.env.filter((v) => v.kind === "inert");
  if (inert.length > 0) {
    lines.push(`Inert (${inert.length}): ${inert.map((v) => `\`${v.name}\``).join(", ")}`);
    lines.push("");
  }

  lines.push(`Egress is refused except: ${plan.allowedHosts.join(", ")}.`);
  lines.push(`Anything else resolves to \`${BLOCKED_HOST}\`, which does not resolve.`);
  lines.push("");

  if (plan.dependencies !== null) {
    const d = plan.dependencies;
    lines.push("## From the repo's Dockerfile");
    lines.push("");
    lines.push("Carried over (what the app needs installed):");
    lines.push("");
    if (d.runtimes.length > 0) lines.push(`- runtimes: ${d.runtimes.join(", ")}`);
    if (d.systemPackages.length > 0) lines.push(`- system packages: ${d.systemPackages.join(", ")}`);
    if (d.runtimes.length === 0 && d.systemPackages.length === 0) lines.push("- nothing recognized");
    lines.push("");
    if (d.dropped.length > 0) {
      lines.push("Deliberately **not** carried over (what the production image does):");
      lines.push("");
      for (const x of d.dropped) lines.push(`- \`${x.instruction}\` — ${x.why}`);
      lines.push("");
    }
  }

  if (plan.sideEffects.length > 0) {
    lines.push("## Commands with side effects");
    lines.push("");
    lines.push("Each acts on a throwaway target under the environment above. Listed so it is on the record:");
    lines.push("");
    for (const h of plan.sideEffects) lines.push(`- ${describeHazard(h)}`);
    lines.push("");
  }

  if (plan.unenumerable.length > 0) {
    lines.push("## Env reads this scan could not name");
    lines.push("");
    lines.push(
      "Each of these reads the environment by a computed name, so no scan can list what it " +
        "asks for. They are why the environment above is closed rather than additive: if one " +
        "of them wants a variable that is not listed, the app fails on boot and the fix is to " +
        "add it here — it never silently reaches a real service.",
    );
    lines.push("");
    for (const u of plan.unenumerable) lines.push(`- \`${u.file}\` — \`process.env[${u.expression}]\``);
    lines.push("");
  }

  if (plan.cannotVerify.length > 0) {
    lines.push("## What verification here cannot establish");
    lines.push("");
    lines.push(
      "A sandbox that reaches nothing real also proves nothing about the parts that need " +
        "something real. These paths are not covered by runtime verification:",
    );
    lines.push("");
    for (const what of plan.cannotVerify) lines.push(`- ${what}`);
    lines.push("");
  }

  return lines.join("\n");
}

function safe<T>(fn: () => T): T | null {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch {
    return null;
  }
}

function safeJson(fn: () => string): unknown {
  const text = safe(fn);
  if (text === null) return null;
  return safe<unknown>(() => JSON.parse(text) as unknown);
}
