import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOWS = join(ROOT, "templates/workflows");
const COMPILED = join(ROOT, "templates/compiled");

type Perms = Record<string, string>;
interface Job { uses?: string; permissions?: Perms | string; }
interface Workflow { permissions?: Perms | string; jobs: Record<string, Job & { permissions?: Perms }>; }

const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };

function load(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

/** The most each scope is requested by any job in a callee workflow. */
function requested(callee: Workflow): Perms {
  const out: Perms = {};
  for (const job of Object.values(callee.jobs)) {
    const p = job.permissions;
    if (p === undefined || typeof p === "string") continue;
    for (const [k, v] of Object.entries(p)) {
      if ((RANK[v] ?? 0) > (RANK[out[k] ?? "none"] ?? 0)) out[k] = v;
    }
  }
  return out;
}

/** What a calling job grants: its own block, else the workflow's. */
function granted(caller: Workflow, job: Job): Perms {
  const p = job.permissions ?? caller.permissions ?? {};
  return typeof p === "string" ? {} : p;
}

function calleePath(uses: string): string | null {
  const m = /^\.\/\.github\/workflows\/(.+)$/.exec(uses);
  if (m?.[1] === undefined) return null;
  const name = m[1];
  if (name.endsWith(".lock.yml")) return join(COMPILED, name);
  return join(WORKFLOWS, name);
}

describe("every call into a reusable workflow grants what that workflow's jobs request", () => {
  // GitHub refuses to start a run whose nested job asks for more than the
  // caller allows. Every role call once sat under a narrower top-level block,
  // so every pipeline would have failed at startup — something neither gh-aw
  // (which compiles the callee) nor actionlint (which does not compare
  // permission sets) reports.
  const callers = readdirSync(WORKFLOWS).filter((f) => /^factory-.*\.yml$/.test(f));
  for (const file of callers) {
    const wf = load(join(WORKFLOWS, file));
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (job.uses === undefined) continue;
      const path = calleePath(job.uses);
      it(`${file} → ${name}`, () => {
        expect(path, `${job.uses} is not a local workflow`).not.toBeNull();
        expect(existsSync(path ?? ""), `${job.uses} is not compiled or does not exist`).toBe(true);
        const want = requested(load(path ?? ""));
        const have = granted(wf, job);
        const short = Object.entries(want).filter(([k, v]) => (RANK[have[k] ?? "none"] ?? 0) < (RANK[v] ?? 0));
        expect(Object.fromEntries(short), `${file}:${name} grants less than ${job.uses} requests`).toEqual({});
      });
    }
  }
});
