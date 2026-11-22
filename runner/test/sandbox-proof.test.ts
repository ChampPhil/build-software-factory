import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSession, mintSession, runProbe, runProbes, storageState, proofComplete } from "../src/commands/sandbox-proof.js";
import { applyProof, freezeManifest, needsHost, trialMet, type SandboxManifest, type TrialReport } from "../src/commands/sandbox.js";

const base: SandboxManifest = {
  schema: "sandbox/1",
  tier: "renders",
  commands: { install: "npm ci", build: "npm run build", run: "npm start", test: "npm test" },
  app_url: "http://localhost:3000",
  env: [],
  services: [],
};

/** An app as a table of responses: path → status, redirect and body; signed-in paths need the cookie. */
function app(routes: Record<string, { status: number; location?: string; body?: string; needs?: string }>) {
  const seen: { url: string; cookie?: string }[] = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
    const u = new URL(url);
    seen.push({ url: u.pathname, ...(init.headers["cookie"] === undefined ? {} : { cookie: init.headers["cookie"] }) });
    const r = routes[u.pathname] ?? { status: 404 };
    if (r.needs !== undefined && !(init.headers["cookie"] ?? "").includes(r.needs)) {
      return { status: 307, location: `/sign-in?next=${u.pathname}`, text: async () => "" };
    }
    return { status: r.status, location: r.location ?? null, text: async () => r.body ?? "" };
  };
  return { fetcher, seen };
}

describe("a session minted without the identity provider", () => {
  it("reads the cookies from the last JSON the command printed, after its own output", () => {
    const out = 'prisma: 1 migration applied\ncreated user test@example.com\n{"cookies":[{"name":"authjs.session-token","value":"abc","httpOnly":true,"sameSite":"Lax"}]}\n';
    expect(parseSession(out)).toEqual([{ name: "authjs.session-token", value: "abc", httpOnly: true, sameSite: "Lax" }]);
  });

  it("says what is wrong with output that is not a session", () => {
    expect(parseSession("done")).toMatch(/did not print/);
    expect(parseSession('{"cookies":[]}')).toMatch(/no cookies/);
    expect(parseSession('{"cookies":[{"name":"s"}]}')).toMatch(/name and a string value/);
  });

  it("fails with the command's own output when it exits non-zero", () => {
    const m: SandboxManifest = { ...base, sign_in: { command: "node mint.mjs", why: "w" } };
    const r = mintSession(m, "/w", {}, () => ({ status: 1, stdout: "", stderr: "Error: relation \"sessions\" does not exist" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/sessions/);
  });

  it("is handed to the browser for the address it reaches the app at, over plain http", () => {
    const s = storageState([{ name: "sid", value: "v", secure: true, sameSite: "None" }], "host.docker.internal") as {
      cookies: { domain: string; secure: boolean; path: string }[];
    };
    expect(s.cookies[0]).toMatchObject({ domain: "host.docker.internal", secure: false, path: "/" });
  });

  it("makes an app with sign-in run on the runner, where the session is minted", () => {
    expect(needsHost(base)).toBe(false);
    expect(needsHost({ ...base, sign_in: { command: "x", why: "w" } })).toBe(true);
  });
});

describe("a dependency's probe", () => {
  const dep = { name: "sign-in", kind: "sign_in", stand_in: "session" as const, why: "w" };

  it("fails when a page behind sign-in sends the browser to sign in: the trinsports case", async () => {
    const { fetcher } = app({ "/teams/soccer": { status: 200, needs: "sid=good" }, "/sign-in": { status: 200 } });
    const r = await runProbe("http://localhost:3000", { ...dep, probe: null }, { path: "/teams/soccer", signed_in: true }, [{ name: "sid", value: "bad" }], fetcher);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/ended at \/sign-in.*not accepted/);
  });

  it("passes with a session the app accepts, and sends it", async () => {
    const { fetcher, seen } = app({ "/teams/soccer": { status: 200, needs: "sid=good", body: "Roster" } });
    const r = await runProbe("http://localhost:3000", { ...dep, probe: null }, { path: "/teams/soccer", signed_in: true, expect_text: "Roster" }, [{ name: "sid", value: "good" }], fetcher);
    expect(r.ok).toBe(true);
    expect(seen[0]?.cookie).toBe("sid=good");
  });

  it("fails on a redirect off the app, an error, or missing text", async () => {
    const { fetcher } = app({
      "/login": { status: 302, location: "https://accounts.google.com/o/oauth2/v2/auth" },
      "/broken": { status: 500, body: "ECONNREFUSED 127.0.0.1:5432" },
      "/empty": { status: 200, body: "<p>No teams</p>" },
    });
    const at = (path: string, expect_text?: string) =>
      runProbe("http://localhost:3000", { ...dep, probe: null }, { path, signed_in: false, ...(expect_text === undefined ? {} : { expect_text }) }, [], fetcher);
    expect((await at("/login")).detail).toMatch(/off the app to https:\/\/accounts.google.com/);
    expect((await at("/broken")).detail).toMatch(/500.*ECONNREFUSED/);
    expect((await at("/empty", "Roster")).ok).toBe(false);
  });

  it("follows the app's own redirects to the same page", async () => {
    const { fetcher } = app({ "/teams": { status: 308, location: "/teams/" }, "/teams/": { status: 200 } });
    expect((await runProbe("http://localhost:3000", { ...dep, probe: null }, { path: "/teams", signed_in: false }, [], fetcher)).ok).toBe(true);
  });

  it("does not count inert dependencies, or ones with no probe, as proven", async () => {
    const { fetcher } = app({ "/": { status: 200 } });
    const m: SandboxManifest = {
      ...base,
      dependencies: [
        { name: "home", kind: "other", stand_in: "service", probe: { path: "/", signed_in: false }, why: "w" },
        { name: "email", kind: "email", stand_in: "inert", probe: null, why: "w" },
        { name: "cron", kind: "other", stand_in: "stub", probe: null, why: "w" },
      ],
    };
    const out = await runProbes(m, "http://localhost:3000", [], fetcher);
    expect(out.map((p) => p.ok)).toEqual([true, false, false]);
    expect(proofComplete({ probes: out })).toBe(false);
  });
});

function trial(over: Partial<TrialReport>): TrialReport {
  return {
    schema: "sandbox-trial/1", claimed: "renders", reached: "renders", steps: [], app_url: "http://localhost:3000",
    app_status: 200, screenshot: "s.png", summary: "s", ...over,
  };
}

describe("a round is met only when the app is proven, not just answering", () => {
  it("is not met when a probe failed, even at the claimed tier", () => {
    expect(trialMet(trial({}))).toBe(true);
    expect(trialMet(trial({ sign_in: { ok: false, detail: "x" } }))).toBe(false);
    expect(trialMet(trial({ probes: [{ dependency: "db", path: "/", signed_in: false, ok: false, detail: "x" }] }))).toBe(false);
  });

  it("freezes what failed as not exercised, and drops a sign_in that minted nothing", () => {
    const kept: Record<string, unknown> = {
      sign_in: { command: "node mint.mjs", why: "w" },
      capabilities: { exercised: ["sign-in", "team pages"], not_exercised: [] },
      dependencies: [
        { name: "sign-in", kind: "sign_in", stand_in: "session", probe: { path: "/teams/a", signed_in: true }, why: "w" },
        { name: "Postgres", kind: "database", stand_in: "service", probe: { path: "/", signed_in: false }, why: "w" },
      ],
    };
    const dropped: { from: string; what: string; why: string }[] = [];
    applyProof(kept, trial({
      sign_in: { ok: false, detail: "exited 1" },
      probes: [
        { dependency: "sign-in", path: "/teams/a", signed_in: true, ok: false, detail: "needs a signed-in session" },
        { dependency: "Postgres", path: "/", signed_in: false, ok: true, detail: "ok" },
      ],
    }), dropped);
    expect(kept["sign_in"]).toBeUndefined();
    expect(dropped[0]?.what).toMatch(/sign_in/);
    const caps = kept["capabilities"] as { exercised: string[]; not_exercised: { what: string }[] };
    expect(caps.exercised).toEqual(["team pages"]);
    expect(caps.not_exercised.map((n) => n.what)).toEqual(["pages behind sign-in", "sign-in"]);
    expect((kept["dependencies"] as { proven: boolean }[]).map((d) => d.proven)).toEqual([false, true]);
  });

  it("prefers, at the same tier, the round that proved more", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-freeze-"));
    const dep = { name: "db", kind: "database", stand_in: "service", probe: { path: "/", signed_in: false }, why: "w" };
    const m = {
      ...base, egress: [], stubs: [], frozen_at: "2026-11-21T00:00:00Z", tier_reason: null,
      capabilities: { exercised: [], not_exercised: [] }, dependencies: [dep],
      episode: [{ attempt: 1, tried: "read the repo", observed: "o", changed: null }],
    };
    const write = (n: number, ok: boolean) => {
      writeFileSync(join(dir, `m${n}.json`), JSON.stringify({ ...m, commands: { ...m.commands, run: `npm start # ${n}` } }));
      writeFileSync(join(dir, `t${n}.json`), JSON.stringify(trial({ probes: [{ dependency: "db", path: "/", signed_in: false, ok, detail: "d" }] })));
      return { candidate: join(dir, `m${n}.json`), trial: join(dir, `t${n}.json`) };
    };
    const { manifest, chosen } = freezeManifest([write(1, true), write(2, false)], "2026-11-22T00:00:00Z");
    expect(chosen).toBe(0);
    expect((manifest["dependencies"] as { proven: boolean }[])[0]?.proven).toBe(true);
    void readFileSync;
  });
});
