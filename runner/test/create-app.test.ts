import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error -- a plain .mjs script with no type declarations; the
// helpers under test are pure, and importing them is only possible because
// the script now guards its own entry point.
import { appName, APP_NAME_MAX, slugForAppName, runningAsEntryPoint, installUrlFor, appJwt, confirmInstallation } from "../../skill/scripts/create-app.mjs";
// @ts-expect-error -- plain .mjs helpers, no declarations
import { waitFor, checkFor } from "../../skill/scripts/wait-for.mjs";
// @ts-expect-error -- plain .mjs helpers, no declarations
import { nextLine, currentJob, JOB_LINES } from "../../skill/scripts/progress.mjs";
import { generateKeyPairSync } from "node:crypto";

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
      // /nope, not /start. The start page is served once; this probe must
      // not use up that one response before the assertions read it.
      const res = await fetch(`http://localhost:${PORT}/nope`, { redirect: "manual" });
      if (res.status === 404) return;
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
  // The first /start is the only one that carries the manifest. Later tests
  // read this copy so they do not spend that one response.
  let formBody = "";

  it("starts and serves the page that posts the manifest", async () => {
    await startServer();
    const res = await get("/start");
    formBody = res.body;
    expect(res.status).toBe(200);
    expect(res.body).toContain('action="https://github.com/settings/apps/new"');
    expect(res.body).toContain('name="manifest"');
  });

  it("sends a state value, so a forged redirect can be told apart", () => {
    expect(/name="state" value="[0-9a-f]{32}"/.test(formBody)).toBe(true);
  });

  it("works without JavaScript", () => {
    expect(formBody).toContain("<noscript>");
  });

  it("the posted manifest does not request workflows", () => {
    expect(formBody).not.toContain("&quot;workflows&quot;");
  });

  it("a second visit does not send another manifest", async () => {
    const res = await get("/start");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('name="manifest"');
    expect(res.body).toContain("Use the tab already open");
    expect(res.body).toContain("does not send another manifest");
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
    const state = /name="state" value="([0-9a-f]{32})"/.exec(formBody)?.[1];
    expect(state).toBeDefined();
    const res = await get(`/callback?state=${state}`);
    expect(res.status).toBe(400);
  });

  it("tells the user what permissions it will ask for before printing the link", () => {
    expect(stdout).toContain("contents: write");
    expect(stdout).toContain("workflows: not requested");
  });

  it("the install landing page is the dashboard's, and says what to do next", async () => {
    const res = await get("/installed?installation_id=1&setup_action=install");
    expect(res.status).toBe(200);
    expect(res.body).toContain("#f4f5f2");
    expect(res.body).toContain("Your factory is connected");
    expect(res.body).toContain("You can close this tab. Setup continues in your terminal.");
    expect(res.body).toContain("window.close()");
  });

  it("refuses an install redirect that names no installation", async () => {
    const res = await get("/installed");
    expect(res.status).toBe(400);
    expect(res.body).toContain("#f4f5f2");
  });

  it("the callback sends the browser straight to the install page, not through an interstitial", () => {
    const src = readFileSync(join(SCRIPTS, "create-app.mjs"), "utf8");
    expect(src).toContain('res.writeHead(302, { location: installUrl })');
    expect(src).not.toContain("donePage");
    expect(src).not.toContain("repos/${repo}/installation");
  });

  // Last in this block on purpose: a handled callback closes the server.
  it("in preview, does not exchange a code even when the state is right", async () => {
    // The code is single-use, so exchanging it would spend it and create a
    // real App. This is the one thing a preview must not do.
    const state = /name="state" value="([0-9a-f]{32})"/.exec(formBody)?.[1];
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

  it("shortens a multi-word repo to initials, and never mixes in the owner", () => {
    expect(appName("Build Software Factory", "bsf-fixtures-ts-webapp")).toBe("Factory (BFTW)");
    expect(appName("Build Software Factory", "vibecoding-for-marketing")).toBe("Factory (VFM)");
    expect(appName("Build Software Factory", "vibecoding_for_marketing")).toBe("Factory (VFM)");
  });

  it("uses Factory plus initials even when the old long prefix would have fit", () => {
    expect(appName("Build Software Factory", "a-b")).toBe("Factory (AB)");
  });

  it("keeps a single word's first five letters and still closes the paren", () => {
    const name = appName("Build Software Factory", "organisation");
    expect(name).toBe("Factory (organ)");
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX);
    expect(name.endsWith(")")).toBe(true);
  });

  it("has its own prefixes for the recompiler App", () => {
    const name = appName("Factory Recompiler", "bsf-fixtures-ts-webapp");
    expect(name.length).toBeLessThanOrEqual(APP_NAME_MAX);
    expect(name.toLowerCase()).toContain("recomp");
    expect(name).toBe("Recomp (BFTW)");
  });

  it("holds only characters GitHub accepts, whatever the repo is called", () => {
    // The live run's repo was CS2_Rob_The_Bobber. GitHub refuses an underscore
    // in an App name, so the default name was rejected on the Create page with
    // nothing on it saying why, and the user was left editing a field nobody
    // had told them was editable.
    for (const slug of [
      "ChampPhil-CS2_Rob_The_Bobber",
      "owner-repo.with.dots",
      "owner-repo_with_many_underscores_and_more",
      "owner-ünïcödé",
      "_-_-_",
    ]) {
      const name = appName("Build Software Factory", slug);
      expect(name, name).toMatch(/^[A-Za-z0-9 ()-]+$/);
      expect(name.length, name).toBeLessThanOrEqual(APP_NAME_MAX);
      expect(name.endsWith(")"), name).toBe(true);
      expect(name, name).not.toContain("_");
    }
  });

  it("does not leave a hyphen hanging where it cut the repo", () => {
    expect(slugForAppName("owner-repo_name")).toBe("owner-repo-name");
    expect(slugForAppName("__lead_and_trail__")).toBe("lead-and-trail");
    expect(appName("Build Software Factory", "owner-a_b_c_d_e_f_g_h_i_j_k_l_m")).not.toMatch(/-\)$/);
  });
});

describe("the script knows when it is the entry point", () => {
  /**
   * The failure this guards: run from Cursor on Windows, the script exited 0,
   * printed nothing, created no App and stored no secrets — and the silence
   * read as success. Every agent's skills directory is a symlink, and Node
   * resolves `import.meta.url` to the real path while `process.argv[1]` keeps
   * the link's path, so comparing the two strings said "not direct".
   */
  it("recognises itself through a symlinked skills folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "bsf-entry-"));
    const real = join(dir, "real");
    const link = join(dir, "link");
    execFileSync("mkdir", ["-p", real]);
    writeFileSync(join(real, "create-app.mjs"), "// test\n");
    execFileSync("ln", ["-s", real, link]);
    const moduleUrl = pathToFileURL(join(real, "create-app.mjs")).href;
    expect(runningAsEntryPoint(moduleUrl, join(link, "create-app.mjs"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("recognises itself from a Windows-style argv path", () => {
    const moduleUrl = "file:///C:/Users/x/skill/scripts/create-app.mjs";
    expect(runningAsEntryPoint(moduleUrl, "C:\\Users\\x\\skill\\scripts\\create-app.mjs")).toBe(true);
  });

  it("stays out of the way when it is only imported", () => {
    expect(runningAsEntryPoint("file:///a/create-app.mjs", "/usr/lib/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(runningAsEntryPoint("file:///a/create-app.mjs", undefined)).toBe(false);
  });
});

describe("the App's owner has to be the repo's owner", () => {
  /**
   * A GitHub App can only be installed on repositories owned by whoever owns
   * the App. Getting this wrong fails silently: the App is created, looks
   * correct, and the install page simply does not list the repository.
   * That happened on this project — an App created under an organization
   * could never be installed on a personal repo, and nothing said so.
   */
  function run(args: string[], ghType: "User" | "Organization") {
    const dir = mkdtempSync(join(tmpdir(), "bsf-owner-"));
    writeFileSync(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        'case "$*" in',
        '  *"api user --jq .login"*) echo champphil ;;',
        '  *"users/"*) echo ' + ghType + " ;;",
        '  *"repos/"*) echo ok ;;',
        "  *) echo '' ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    const saved = process.env["PATH"];
    process.env["PATH"] = `${dir}:${saved ?? ""}`;
    try {
      return execFileSync("node", [join(SCRIPTS, "create-app.mjs"), ...args, "--dry-run"], {
        encoding: "utf8",
        stdio: "pipe",
        timeout: 20_000,
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    } finally {
      process.env["PATH"] = saved ?? "";
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses an --org that does not own the repo, even in a preview", () => {
    // A preview that does not catch an impossible configuration is a preview
    // that lies about what would happen, so this check runs before the
    // credentials gate rather than inside it.
    const out = run(["--repo", "ChampPhil/trinsports", "--org", "bsf-fixtures", "--port", "8931"], "User");
    expect(out).toContain("does not own");
    expect(out).toContain("can never be");
  });

  it("accepts the matching --org without complaint", () => {
    const out = run(["--repo", "bsf-fixtures/ts-webapp", "--org", "bsf-fixtures", "--port", "8932"], "Organization");
    expect(out).not.toContain("does not own");
  });
});


describe("installing the App on exactly one repository", () => {
  it("builds the install URL for the one repo", () => {
    expect(installUrlFor({ htmlUrl: "https://github.com/apps/x", ownerId: 7, repoId: 9 })).toBe(
      "https://github.com/apps/x/installations/new/permissions?target_id=7&repository_ids[]=9",
    );
    expect(installUrlFor({ htmlUrl: "https://github.com/apps/x" })).toBe("https://github.com/apps/x/installations/new");
  });

  it("signs an App JWT with RS256 and the documented claims", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }) as string;
    const jwt = appJwt({ pem, clientId: "Iv1.abc", now: 1000 }) as string;
    const [h, b] = jwt.split(".") as [string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(b, "base64url").toString())).toEqual({ iat: 940, exp: 1540, iss: "Iv1.abc" });
  });

  const fakeFetch = (selection: string, repos: string[]) =>
    (async (url: string) => {
      const ok = (o: unknown) => ({ ok: true, status: 200, json: async () => o });
      if (url.endsWith("/access_tokens")) return ok({ token: "t" });
      if (url.includes("/installation/repositories")) return ok({ repositories: repos.map((full_name) => ({ full_name })) });
      return ok({ repository_selection: selection });
    }) as unknown as typeof fetch;

  it("accepts an install limited to the repo", async () => {
    const r = await confirmInstallation({ installationId: 5, repo: "o/r", jwt: "j", fetchImpl: fakeFetch("selected", ["o/r"]) });
    expect(r.ok).toBe(true);
  });

  it("stops with the exact fix when the install covers all repositories", async () => {
    const r = await confirmInstallation({ installationId: 5, repo: "o/r", jwt: "j", fetchImpl: fakeFetch("all", ["o/r"]) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("https://github.com/settings/installations/5");
  });

  it("stops when the repo is missing from the install", async () => {
    const r = await confirmInstallation({ installationId: 5, repo: "o/r", jwt: "j", fetchImpl: fakeFetch("selected", ["o/other"]) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("not on o/r");
  });
});

describe("wait-for.mjs", () => {
  it("returns true the moment the check passes, and says one line a minute while waiting", async () => {
    let t = 0;
    let calls = 0;
    const said: string[] = [];
    const ok = await waitFor(async () => ++calls >= 30, {
      intervalMs: 5000, timeoutMs: 600000, label: "the PR", say: (l: string) => said.push(l),
      now: () => t, sleep: async (ms: number) => { t += ms; },
    });
    expect(ok).toBe(true);
    expect(said).toEqual(["still waiting for the PR", "still waiting for the PR"]);
  });

  it("gives up at the timeout", async () => {
    let t = 0;
    const ok = await waitFor(async () => false, { intervalMs: 5000, timeoutMs: 20000, say: () => {}, now: () => t, sleep: async (ms: number) => { t += ms; } });
    expect(ok).toBe(false);
  });

  it("treats a failing check as not yet", async () => {
    let t = 0, n = 0;
    const ok = await waitFor(async () => { if (++n < 3) throw new Error("blip"); return true; }, { say: () => {}, now: () => t, sleep: async (ms: number) => { t += ms; } });
    expect(ok).toBe(true);
  });

  it("knows its three checks and refuses others", () => {
    expect(checkFor("pr-merged", "4")).not.toBeNull();
    expect(checkFor("secret", "ANTHROPIC_API_KEY")).not.toBeNull();
    expect(checkFor("workflow-success", "factory-setup.yml")).not.toBeNull();
    expect(checkFor("nope", "x")).toBeNull();
  });
});

describe("progress.mjs", () => {
  const job = (name: string, status: string, conclusion: string | null = null) => ({ name, status, conclusion });

  it("names the job in progress", () => {
    expect(currentJob([job("ready", "completed", "success"), job("plan", "in_progress")])).toBe("plan");
    expect(currentJob([job("ready", "completed"), job("plan", "completed"), job("freeze", "completed"), job("release", "completed")])).toBeNull();
  });

  it("speaks when the job changes and again once a minute", () => {
    const jobs = [job("ready", "completed", "success"), job("plan", "in_progress")];
    const a = nextLine(jobs, { job: "ready", at: 0 }, 60000);
    expect(a.line).toBe(`${JOB_LINES.plan}.`);
    const quiet = nextLine(jobs, a.state, 90000);
    expect(quiet.line).toBeNull();
    const again = nextLine(jobs, a.state, 120000);
    expect(again.line).toBe(`${JOB_LINES.plan}.`);
  });

  it("repeats after one quiet minute", () => {
    const jobs = [job("ready", "completed", "success"), job("plan", "in_progress")];
    const first = nextLine(jobs, { job: null, at: 0 }, 0);
    expect(nextLine(jobs, first.state, 60 * 1000).line).toBe(`${JOB_LINES.plan}.`);
  });

  it("speaks the work while the private copy is being written, not the machine name", () => {
    const jobs = [
      { name: "ready", status: "completed", conclusion: "success" },
      { name: "plan", status: "completed", conclusion: "success" },
      { name: "Computer A. Writing the launch and how each journey is tested", status: "in_progress", conclusion: null },
    ];
    const r = nextLine(jobs, { job: null, at: 0 }, 0);
    expect(r.line).toContain("Writing how the app starts and how each journey is tested");
    expect(r.line).not.toContain("Computer");
  });

  it("celebrates the sandbox starting once freeze succeeds", () => {
    const jobs = [job("freeze", "completed", "success"), job("release", "in_progress")];
    const r = nextLine(jobs, { job: "freeze", at: 0 }, 1000);
    expect(r.line).toContain("Your app just started in the sandbox.");
  });
});
