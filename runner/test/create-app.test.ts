import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- a plain .mjs script with no type declarations; the
// helpers under test are pure, and importing them is only possible because
// the script now guards its own entry point.
import { appName, APP_NAME_MAX } from "../../skill/scripts/create-app.mjs";

/**
 * Exercises the App-creation script's local server: the page it posts to
 * GitHub, and above all that a redirect carrying the wrong state, or no
 * state, is refused and stores nothing.
 *
 * No App is ever created here: the test never supplies a real code, so the
 * conversion call is never reached.
 */

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "skill")) && existsSync(join(dir, "runner"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}

const ROOT = repoRoot();
const SCRIPTS = join(ROOT, "skill/scripts");
const MANIFESTS = join(ROOT, "skill/manifests");
const PORT = 8901;

let proc: ChildProcess | undefined;
let stdout = "";

async function startServer(): Promise<void> {
  // --preview runs the whole server — the page, the state check, the
  // callback refusals — and stops before exchanging a code, so it needs no
  // `gh` login. Without it these tests only pass on a machine already signed
  // in to GitHub, which is how they passed locally and failed in CI.
  proc = spawn("node", ["create-app.mjs", "--repo", "bsf-fixtures/ts-webapp", "--port", String(PORT), "--preview"], {
    cwd: SCRIPTS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
  proc.stderr?.on("data", (d: Buffer) => { stdout += d.toString(); });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      await fetch(`http://localhost:${PORT}/start`, { redirect: "manual" });
      return;
    } catch { /* not up yet */ }
  }
  throw new Error(`server never came up. output:\n${stdout}`);
}

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${PORT}${path}`, { redirect: "manual" });
  return { status: res.status, body: await res.text() };
}

afterAll(() => { proc?.kill("SIGKILL"); });

describe("the App manifests", () => {
  it("the factory App never requests the workflows permission", () => {
    // This is the permission that would let it rewrite the gates that judge
    // its own work. It is absent rather than set to none: a permission that
    // is not requested cannot be granted.
    const m = JSON.parse(readFileSync(join(MANIFESTS, "factory-app.json"), "utf8")) as {
      default_permissions: Record<string, string>;
    };
    expect(m.default_permissions).not.toHaveProperty("workflows");
  });

  it("the factory App requests exactly the permissions the architecture doc lists", () => {
    const m = JSON.parse(readFileSync(join(MANIFESTS, "factory-app.json"), "utf8")) as {
      default_permissions: Record<string, string>;
    };
    expect(m.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "write",
      statuses: "write",
      actions: "write",
      administration: "write",
      metadata: "read",
    });
  });

  it("the recompiler App can change files and nothing else", () => {
    // It holds workflows: write, which the factory App must never have. The
    // split is the point: one can clear a gate but not rewrite one, the other
    // can rewrite one but not clear it.
    const m = JSON.parse(readFileSync(join(MANIFESTS, "recompiler-app.json"), "utf8")) as {
      default_permissions: Record<string, string>;
    };
    expect(m.default_permissions).toEqual({
      contents: "write",
      workflows: "write",
      metadata: "read",
    });
    for (const scope of ["pull_requests", "checks", "administration", "issues", "actions"]) {
      expect(m.default_permissions, `recompiler has ${scope}`).not.toHaveProperty(scope);
    }
  });

  it("neither App subscribes to webhook events it does not need", () => {
    for (const f of ["factory-app.json", "recompiler-app.json"]) {
      const m = JSON.parse(readFileSync(join(MANIFESTS, f), "utf8")) as {
        default_events: string[];
        hook_attributes: { active: boolean };
      };
      expect(m.default_events).toEqual([]);
      expect(m.hook_attributes.active).toBe(false);
    }
  });
});

describe("create-app.mjs --dry-run", () => {
  it("creates nothing and needs no credentials", () => {
    const out = execFileSync("node", ["create-app.mjs", "--repo", "owner/name", "--dry-run"], {
      cwd: SCRIPTS, encoding: "utf8",
    });
    expect(out).toContain("Would create the factory App");
    expect(out).toContain("would be written to owner/name");
  });

  it("refuses a malformed repo", () => {
    expect(() =>
      execFileSync("node", ["create-app.mjs", "--repo", "not-a-repo", "--dry-run"], {
        cwd: SCRIPTS, encoding: "utf8", stdio: "pipe",
      }),
    ).toThrow();
  });

  it("names the recompiler App when asked for it", () => {
    const out = execFileSync("node", ["create-app.mjs", "--repo", "owner/name", "--recompiler", "--dry-run"], {
      cwd: SCRIPTS, encoding: "utf8",
    });
    expect(out).toContain("Would create the recompiler App");
    expect(out).toContain("workflows");
  });
});

describe("create-app.mjs local server", () => {
  it("starts and serves the page that posts the manifest", async () => {
    await startServer();
    const res = await get("/start");
    expect(res.status).toBe(200);
    expect(res.body).toContain('action="https://github.com/settings/apps/new"');
    expect(res.body).toContain('name="manifest"');
  });

  it("sends a state value, so a forged redirect can be told apart", async () => {
    const res = await get("/start");
    expect(/name="state" value="[0-9a-f]{32}"/.test(res.body)).toBe(true);
  });

  it("works without JavaScript", async () => {
    expect((await get("/start")).body).toContain("<noscript>");
  });

  it("the posted manifest does not request workflows", async () => {
    const res = await get("/start");
    expect(res.body).not.toContain("&quot;workflows&quot;");
  });

  it("404s an unknown path", async () => {
    expect((await get("/nope")).status).toBe(404);
  });

  it("refuses a callback with no state, and says nothing was stored", async () => {
    const res = await get("/callback?code=forged-code-12345");
    expect(res.status).toBe(400);
    expect(res.body).toContain("Nothing was stored");
  });

  it("refuses a callback whose state does not match", async () => {
    const res = await get("/callback?code=x&state=" + "d".repeat(32));
    expect(res.status).toBe(400);
  });

  it("refuses the right state with no code", async () => {
    const start = await get("/start");
    const state = /name="state" value="([0-9a-f]{32})"/.exec(start.body)?.[1];
    expect(state).toBeDefined();
    const res = await get(`/callback?state=${state}`);
    expect(res.status).toBe(400);
  });

  it("tells the user what permissions it will ask for before opening the browser", () => {
    expect(stdout).toContain("contents: write");
    expect(stdout).toContain("workflows: not requested");
  });

  // Last in this block on purpose: a handled callback closes the server.
  it("in preview, does not exchange a code even when the state is right", async () => {
    // The code is single-use, so exchanging it would spend it and create a
    // real App. This is the one thing a preview must not do.
    const start = await get("/start");
    const state = /name="state" value="([0-9a-f]{32})"/.exec(start.body)?.[1];
    expect(state).toBeDefined();
    const res = await get(`/callback?state=${state}&code=not-a-real-code`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("not exchanged");
    expect(res.body).toContain("Nothing was created and nothing was stored");
  });
});

describe("the App's name", () => {
  it("never exceeds GitHub's 34-character limit", () => {
    for (const slug of ["a-b", "bsf-fixtures-ts-webapp", "ChampPhil-trinsports", "x".repeat(80)]) {
      const name = appName("Build Software Factory", slug);
      expect(name.length, name).toBeLessThanOrEqual(APP_NAME_MAX);
    }
  });

  it("never leaves a dangling parenthesis", () => {
    // The bug this replaces: slicing the finished string to 34 produced
    // "Build Software Factory (bsf-fixtur" — cut mid-word, paren gone. The
    // name shows as the author on every factory PR, so it is user-visible.
    for (const slug of ["a-b", "bsf-fixtures-ts-webapp", "x".repeat(80)]) {
      const name = appName("Build Software Factory", slug);
      expect(name.endsWith(")"), name).toBe(true);
      expect((name.match(/\(/g) ?? []).length).toBe(1);
    }
  });

  it("keeps the whole repo suffix, shortening the prefix instead", () => {
    // The suffix is what makes the name unique across GitHub, so it is the
    // part worth protecting.
    expect(appName("Build Software Factory", "bsf-fixtures-ts-webapp")).toBe(
      "Factory (bsf-fixtures-ts-webapp)",
    );
  });

  it("keeps the long prefix when there is room for it", () => {
    expect(appName("Build Software Factory", "a-b")).toBe("Build Software Factory (a-b)");
  });

  it("cuts into the repo only when no prefix fits, and still closes the paren", () => {
    const name = appName("Build Software Factory", "some-really-long-organisation-name");
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX);
    expect(name.startsWith("Factory (")).toBe(true);
    expect(name.endsWith(")")).toBe(true);
  });

  it("has its own prefixes for the recompiler App", () => {
    const name = appName("Factory Recompiler", "bsf-fixtures-ts-webapp");
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX);
    expect(name.toLowerCase()).toContain("recomp");
  });
});
