import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { GitHubClient, decodeBase64 } from "../lib/github.js";
import { applySettingsChange } from "../lib/apply-settings.js";

const template = readFileSync(new URL("../../templates/definition/factory.yaml", import.meta.url), "utf8");
const garden = readFileSync(new URL("../../templates/workflows/factory-garden.yml", import.meta.url), "utf8");
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

interface Call { method: string; path: string; body: unknown }

/** A small stand-in for the GitHub API, answering only what the flow asks. */
function fakeGitHub(opts: {
  checks?: (n: number) => { name: string; status: string; conclusion: string | null; completed_at: string | null }[];
  mergeStatus?: number;
  fail?: { match: RegExp; status: number };
  noWorkflow?: boolean;
  workflowText?: string;
} = {}) {
  const calls: Call[] = [];
  let polls = 0;
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const fetch = ((url: string, init?: RequestInit) => {
    const path = url.replace("https://api.github.com/", "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (opts.fail?.match.test(`${method} ${path}`)) return json({ message: "no" }, opts.fail.status);
    if (method === "GET" && path === "repos/o/r") return json({ default_branch: "main" });
    if (method === "GET" && path.endsWith("git/ref/heads/main")) return json({ object: { sha: "tipsha" } });
    if (method === "GET" && path.includes("contents/.factory/definition/factory.yaml")) return json({ content: b64(template), sha: "fsha" });
    if (method === "GET" && path.includes("contents/.github/workflows/factory-garden.yml")) {
      return opts.noWorkflow === true ? json({}, 404) : json({ content: b64(opts.workflowText ?? garden), sha: "wsha" });
    }
    if (method === "POST" && path.endsWith("git/refs")) return json({});
    if (method === "PUT" && path.includes("/contents/")) return json({});
    if (method === "POST" && path.endsWith("/pulls")) return json({ number: 12, html_url: "https://github.com/o/r/pull/12", head: { sha: "headsha" } }, 201);
    if (method === "POST" && path.endsWith("/labels")) return json([]);
    if (method === "GET" && path.endsWith("/pulls/12")) return json({ updated_at: "2026-11-22T20:00:10Z" });
    if (method === "GET" && path.includes("/check-runs")) {
      polls += 1;
      const rows = opts.checks?.(polls) ?? [{ name: "factory/policy", status: "completed", conclusion: "success", completed_at: "2026-11-22T20:00:30Z" }];
      return json({ check_runs: rows });
    }
    if (method === "PUT" && path.endsWith("/merge")) return json({ merged: true }, opts.mergeStatus ?? 200);
    if (method === "DELETE") return json({}, 204);
    return json({ message: `unexpected ${method} ${path}` }, 500);
  }) as unknown as typeof globalThis.fetch;
  return { client: new GitHubClient({ token: "t", repo: "o/r" }, fetch), calls };
}

const fast = { sleep: async () => undefined, pollMs: 0, waitMs: 5_000 };
const put = (calls: Call[], file: string) => calls.find((c) => c.method === "PUT" && c.path.includes(file))?.body as { content: string; branch: string; sha: string } | undefined;

describe("changing a setting from the dashboard", () => {
  it("opens a settings PR, waits for the factory's check, merges, and tidies the branch", async () => {
    const { client, calls } = fakeGitHub();
    const stages: string[] = [];
    const r = await applySettingsChange(client, { monthly_budget: 50 }, { ...fast, onStage: (s) => stages.push(s) });
    expect(r).toMatchObject({ status: "applied", pr: 12, summary: ["Monthly budget: $35 -> $50"] });
    expect(stages).toEqual(["reading", "opening", "checking", "merging"]);

    const written = put(calls, "factory.yaml")!;
    expect(written.sha).toBe("fsha");
    expect(written.branch).toMatch(/^factory-settings\//);
    const text = decodeBase64(written.content);
    expect((parseYaml(text) as { budget: { monthly_usd: number } }).budget.monthly_usd).toBe(50);
    expect(text).toContain("a ceiling, not an");

    const label = calls.find((c) => c.path.endsWith("/labels"))!;
    expect(label.body).toEqual({ labels: ["factory:settings"] });
    expect(calls.find((c) => c.method === "POST" && c.path.endsWith("/pulls"))!.body).toMatchObject({ base: "main" });
    expect(calls.find((c) => c.path.endsWith("/merge"))!.body).toEqual({ merge_method: "squash" });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE" });
    // Nothing was written to the default branch directly.
    expect(calls.filter((c) => c.method === "PUT" && c.path.includes("/contents/")).every((c) => (c.body as { branch: string }).branch.startsWith("factory-settings/"))).toBe(true);
  });

  it("changes the cleanup workflow's cron in the same PR, and nothing else in it", async () => {
    const { client, calls } = fakeGitHub();
    const r = await applySettingsChange(client, { gardening_hour: 3 }, fast);
    expect(r.status).toBe("applied");
    const wf = decodeBase64(put(calls, "factory-garden.yml")!.content);
    expect(wf).toContain('- cron: "0 3 * * *"');
    expect(wf.replace('"0 3 * * *"', '"0 6 * * *"')).toBe(garden);
  });

  it("ignores a check that finished before the label, and merges on the one after", async () => {
    const stale = { name: "factory/policy", status: "completed", conclusion: "failure", completed_at: "2026-11-22T20:00:05Z" };
    const real = { name: "factory/policy", status: "completed", conclusion: "success", completed_at: "2026-11-22T20:00:40Z" };
    const { client } = fakeGitHub({ checks: (n) => (n === 1 ? [stale] : n === 2 ? [stale, { name: "factory/policy", status: "in_progress", conclusion: null, completed_at: null }] : [stale, real]) });
    expect((await applySettingsChange(client, { monthly_budget: 50 }, fast)).status).toBe("applied");
  });

  it("leaves the PR open and says why when the check fails", async () => {
    const { client, calls } = fakeGitHub({ checks: () => [{ name: "factory/policy", status: "completed", conclusion: "failure", completed_at: "2026-11-22T20:00:30Z" }] });
    const r = await applySettingsChange(client, { monthly_budget: 50 }, fast);
    expect(r).toMatchObject({ status: "open", pr: 12 });
    expect(calls.some((c) => c.path.endsWith("/merge"))).toBe(false);
  });

  it("leaves it open when the check has not finished in time, and when GitHub wants a review or the queue", async () => {
    const waiting = fakeGitHub();
    const w = await applySettingsChange(waiting.client, { monthly_budget: 50 }, { ...fast, waitMs: 0 });
    expect(w).toMatchObject({ status: "open" });
    expect(waiting.calls.some((c) => c.path.endsWith("/merge"))).toBe(false);

    const blocked = fakeGitHub({ mergeStatus: 405 });
    expect(await applySettingsChange(blocked.client, { monthly_budget: 50 }, fast)).toMatchObject({ status: "open", reason: expect.stringMatching(/review or the merge queue/) });
  });

  it("opens nothing when a value is refused, or nothing would change", async () => {
    const a = fakeGitHub();
    const refused = await applySettingsChange(a.client, { share_gardening: 40 }, fast);
    expect(refused).toMatchObject({ status: "refused", problems: [{ message: expect.stringMatching(/add up to 115/) }] });
    expect(a.calls.every((c) => c.method === "GET")).toBe(true);

    const b = fakeGitHub();
    expect(await applySettingsChange(b.client, { monthly_budget: 35 }, fast)).toEqual({ status: "unchanged" });
    expect(b.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("opens nothing when the schedule cannot be changed safely", async () => {
    const a = fakeGitHub({ noWorkflow: true });
    expect((await applySettingsChange(a.client, { gardening_hour: 3 }, fast)).status).toBe("refused");
    const b = fakeGitHub({ workflowText: "on:\n  workflow_dispatch:\n" });
    expect((await applySettingsChange(b.client, { gardening_hour: 3 }, fast)).status).toBe("refused");
    expect(b.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says what to fix, in words, when the token cannot write", async () => {
    const { client } = fakeGitHub({ fail: { match: /POST .*git\/refs/, status: 403 } });
    const r = await applySettingsChange(client, { monthly_budget: 50 }, fast);
    expect(r).toMatchObject({ status: "failed", message: expect.stringMatching(/token cannot make this change/) });
  });
});
