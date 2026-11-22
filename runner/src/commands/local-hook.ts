import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { classifyCorrection, recordOf, workItemBody, workItemTitle, type CorrectionRecord } from "./corrections.js";

/**
 * Corrections made to an agent on someone's own machine.
 *
 * Most corrections are said in a local session, not on a PR: "no, don't mock
 * the database", typed to the agent a person is working with. A hook on the
 * person's own harness sees each message they send, judges it with the same
 * rule a PR comment gets, and hands a correction to the factory through its
 * intake workflow, which turns it into a hardening work item.
 *
 * Three things make this safe to leave on. It never writes to the session: a
 * hook's output can be fed back to the agent, so this prints nothing and
 * always succeeds. It sends only what it judged a correction, redacted and cut
 * short. And installing it is a deliberate act that refuses a public repository
 * unless the person says they know the text will be visible there.
 */

/** What Claude Code gives a `UserPromptSubmit` hook on stdin. */
export interface HookInput {
  readonly session_id?: string;
  readonly prompt?: string;
  readonly hook_event_name?: string;
}

export interface LocalCapture {
  readonly send: boolean;
  readonly why: string;
  readonly record?: CorrectionRecord;
  readonly title?: string;
  readonly body?: string;
  /** Stable for the same words, so one correction is not sent twice. */
  readonly key?: string;
}

export function parseHookInput(stdin: string): HookInput | null {
  try {
    const v = JSON.parse(stdin) as unknown;
    return v !== null && typeof v === "object" ? { ...v } : null;
  } catch {
    return null;
  }
}

/** Decide what, if anything, a message from a local session sends. */
export function captureLocal(input: HookInput | null, who: string, now: string): LocalCapture {
  if (input === null || typeof input.prompt !== "string" || input.prompt.trim() === "") {
    return { send: false, why: "no message" };
  }
  // A slash command or a pasted file is not a person correcting an agent.
  if (input.prompt.trimStart().startsWith("/")) return { send: false, why: "a command" };

  const verdict = classifyCorrection(input.prompt, "local_session");
  if (!verdict.correction) return { send: false, why: verdict.why };

  const record = recordOf({ at: now, by: who, kind: "local_session", text: input.prompt });
  return {
    send: true,
    why: verdict.why,
    record,
    title: workItemTitle(record),
    body: workItemBody(record, {}),
    key: createHash("sha256").update(record.text).digest("hex").slice(0, 16),
  };
}

/* ------------------------------------------------------------------ memory */

const SEEN_CAP = 500;

export const seenPath = (home = homedir()): string => join(home, ".cache", "bsf", "sent-corrections.json");

export function alreadySent(key: string, path = seenPath()): boolean {
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as string[]).includes(key);
  } catch {
    return false;
  }
}

export function markSent(key: string, path = seenPath()): void {
  let seen: string[] = [];
  try {
    seen = JSON.parse(readFileSync(path, "utf8")) as string[];
  } catch {
    seen = [];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify([...seen, key].slice(-SEEN_CAP)));
}

/* ----------------------------------------------------------------- install */

const MARK = "bsf local-hook";

interface HookEntry {
  readonly matcher?: string;
  readonly hooks?: readonly { readonly type?: string; readonly command?: string }[];
}

/**
 * The settings file with the hook added, or null when it is already there.
 * `.claude/settings.local.json` rather than the shared `settings.json`: the
 * hook sends what a person types, so it is theirs to turn on, not the team's.
 */
export function withHook(existing: unknown, command: string): Record<string, unknown> | null {
  const base = (existing !== null && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const hooks = (base["hooks"] !== null && typeof base["hooks"] === "object" ? base["hooks"] : {}) as Record<string, unknown>;
  const list = (Array.isArray(hooks["UserPromptSubmit"]) ? hooks["UserPromptSubmit"] : []) as HookEntry[];
  if (list.some((e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes(MARK)))) return null;
  return {
    ...base,
    hooks: { ...hooks, UserPromptSubmit: [...list, { hooks: [{ type: "command", command }] }] },
  };
}

/** The settings file with this hook taken out and everything else left alone. */
export function withoutHook(existing: unknown): Record<string, unknown> | null {
  if (existing === null || typeof existing !== "object") return null;
  const base = existing as Record<string, unknown>;
  const hooks = base["hooks"] as Record<string, unknown> | undefined;
  const list = hooks?.["UserPromptSubmit"];
  if (hooks === undefined || !Array.isArray(list)) return null;
  const kept = (list as HookEntry[]).filter((e) => !(e.hooks ?? []).some((h) => (h.command ?? "").includes(MARK)));
  if (kept.length === list.length) return null;
  const nextHooks: Record<string, unknown> = { ...hooks };
  if (kept.length === 0) delete nextHooks["UserPromptSubmit"];
  else nextHooks["UserPromptSubmit"] = kept;
  const next: Record<string, unknown> = { ...base, hooks: nextHooks };
  if (Object.keys(nextHooks).length === 0) delete next["hooks"];
  return next;
}

export const hookCommand = (repo: string): string => `"$CLAUDE_PROJECT_DIR"/.factory/bin/bsf local-hook --repo ${repo}`;

export function settingsPath(repoPath: string): string {
  return join(repoPath, ".claude", "settings.local.json");
}

export function readSettings(path: string): unknown {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}
