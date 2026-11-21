#!/usr/bin/env node
/**
 * Derive the host-access variant of each role that runs the app.
 *
 * gh-aw fixes the agent's network posture at compile time, and the default
 * posture gives the agent no route to the runner. A repo whose sandbox needs
 * the runner — services, or stubs at a third party's own address — has its
 * app started there (bsf sandbox start, which serves it on HOST_APP_PORT) and
 * needs the agent to reach it. That takes the docker-sudo-iptables runtime
 * and that one port, which is a weaker isolation, so it is a separate
 * compiled workflow chosen per run from the frozen manifest, never the
 * default. The factory App cannot write workflows, so both variants ship.
 *
 *   node scripts/host-variants.mjs            write templates/workflows/*-host.md
 *   node scripts/host-variants.mjs --check    exit 1 if they are out of date
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST_APP_PORT = 8787;
/** The app, then up to three services forwarded for the agent's own shell. */
export const HOST_PORTS = [8787, 8788, 8789, 8790];
export const ROLES = ["builder", "verifier"];
const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../templates/workflows");

export function hostVariant(source, role) {
  const end = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || end < 0) throw new Error(`${role}: no frontmatter`);
  let fm = source.slice(0, end);
  const body = source.slice(end);
  const at = fm.indexOf("\nsandbox:\n  agent:\n");
  if (at < 0) throw new Error(`${role}: no sandbox.agent block`);
  // Drop any runtime line the base has; the variant states its own.
  fm = fm.replace(/\n    runtime: [^\n]*/, "");
  const insert =
    "\nsandbox:\n  agent:\n" +
    "    # Host-access variant, derived by runner/scripts/host-variants.mjs: the app\n" +
    "    # runs on the runner with its services and stubs, and these are the only\n" +
    "    # ports the agent may reach there. Chosen only when the frozen manifest\n" +
    "    # needs the runner; it is weaker isolation, and setup says so.\n" +
    "    runtime: docker-sudo-iptables\n" +
    `    allow-host-ports: [${HOST_PORTS.join(", ")}]\n`;
  fm = fm.replace("\nsandbox:\n  agent:\n", insert);
  fm = fm.replace(/^name: (.*)$/m, (_m, n) => `name: ${n.replace(/^"|"$/g, "")} (host access)`);
  return `${fm}${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const role of ROLES) {
    const base = readFileSync(join(DIR, `factory-role-${role}.md`), "utf8");
    const want = hostVariant(base, role);
    const path = join(DIR, `factory-role-${role}-host.md`);
    const have = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (have === want) continue;
    if (check) {
      process.stderr.write(`${path} is out of date: run node runner/scripts/host-variants.mjs\n`);
      stale++;
    } else {
      writeFileSync(path, want);
      process.stdout.write(`wrote ${path}\n`);
    }
  }
  process.exit(stale > 0 ? 1 : 0);
}
