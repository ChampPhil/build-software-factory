import { spawnSync } from "node:child_process";
import type { Dependency, Probe, SandboxManifest } from "./sandbox.js";

/**
 * Proof that the sandbox matches the app: a signed-in session minted without
 * the identity provider, and one request per dependency that succeeds only
 * when that dependency's stand-in works.
 *
 * A sandbox whose app answers at `/` can still be useless: every page behind
 * sign-in redirects away, the database is unreachable, the stubbed API is
 * never called. The trial runs these probes, so setup cannot claim what it
 * did not see, and the freeze records whatever failed as not exercised.
 */

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly secure?: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  readonly expires?: number;
}

export type Minted =
  | { readonly ok: true; readonly cookies: readonly SessionCookie[]; readonly detail: string }
  | { readonly ok: false; readonly cookies: readonly []; readonly detail: string };

/** Parse what a sign_in command printed. The JSON may follow other output. */
export function parseSession(stdout: string): readonly SessionCookie[] | string {
  // Tools print their own lines first; the JSON is the object that holds
  // "cookies", up to the last closing brace.
  const key = stdout.search(/\{\s*"cookies"/);
  const start = key >= 0 ? key : stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  let doc: unknown;
  try {
    doc = JSON.parse(start >= 0 && end > start ? stdout.slice(start, end + 1) : stdout);
  } catch (e) {
    return `the command did not print {"cookies": [...]} as JSON: ${(e as Error).message}`;
  }
  const cookies = (doc as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) return "the command printed no cookies";
  const out: SessionCookie[] = [];
  for (const c of cookies as Record<string, unknown>[]) {
    if (typeof c["name"] !== "string" || c["name"] === "" || typeof c["value"] !== "string") {
      return "every cookie needs a name and a string value";
    }
    const same = c["sameSite"];
    out.push({
      name: c["name"],
      value: c["value"],
      ...(typeof c["path"] === "string" ? { path: c["path"] } : {}),
      ...(typeof c["httpOnly"] === "boolean" ? { httpOnly: c["httpOnly"] } : {}),
      ...(typeof c["secure"] === "boolean" ? { secure: c["secure"] } : {}),
      ...(same === "Strict" || same === "Lax" || same === "None" ? { sameSite: same } : {}),
      ...(typeof c["expires"] === "number" ? { expires: c["expires"] } : {}),
    });
  }
  return out;
}

/** Run the manifest's sign_in command in the sandbox's environment. */
export function mintSession(
  m: SandboxManifest,
  workspace: string,
  env: Record<string, string>,
  run: (command: string) => { status: number | null; stdout: string; stderr: string } = (command) => {
    const r = spawnSync("bash", ["-c", command], { cwd: workspace, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
): Minted {
  if (m.sign_in === undefined) return { ok: false, cookies: [], detail: "the manifest declares no sign_in" };
  const r = run(m.sign_in.command);
  if (r.status !== 0) {
    return { ok: false, cookies: [], detail: `sign_in exited ${String(r.status)}: ${`${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-15).join("\n")}` };
  }
  const parsed = parseSession(r.stdout);
  if (typeof parsed === "string") return { ok: false, cookies: [], detail: parsed };
  return { ok: true, cookies: parsed, detail: `minted ${parsed.length} cookie(s): ${parsed.map((c) => c.name).join(", ")}` };
}

export function cookieHeader(cookies: readonly SessionCookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** Playwright storage state for a browser that reaches the app at `host`. */
export function storageState(cookies: readonly SessionCookie[], host: string): unknown {
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: host,
      path: c.path ?? "/",
      expires: c.expires ?? -1,
      httpOnly: c.httpOnly ?? true,
      // The roles reach the app over plain http; a Secure cookie would never be sent.
      secure: false,
      sameSite: c.sameSite ?? "Lax",
    })),
    origins: [],
  };
}

export interface ProbeOutcome {
  readonly dependency: string;
  readonly path: string;
  readonly signed_in: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  location: string | null;
  text: () => Promise<string>;
}>;

const defaultFetch: Fetcher = async (url, init) => {
  const r = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  return { status: r.status, location: r.headers.get("location"), text: () => r.text() };
};

function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  return norm(a) === norm(b);
}

/**
 * One probe: the request, its redirects followed within the app's own origin.
 * It passes when the app ends at the same path with a 2xx and, if asked, the
 * text. A redirect to a sign-in page, an error page or another host fails.
 */
export async function runProbe(
  appUrl: string,
  dep: Dependency,
  probe: Probe,
  cookies: readonly SessionCookie[],
  fetcher: Fetcher = defaultFetch,
): Promise<ProbeOutcome> {
  const base = { dependency: dep.name, path: probe.path, signed_in: probe.signed_in };
  if (probe.signed_in && cookies.length === 0) {
    return { ...base, ok: false, detail: "needs a signed-in session, and sign_in minted none" };
  }
  const origin = new URL(appUrl).origin;
  const target = new URL(probe.path, origin);
  let url = target.toString();
  let method = probe.method ?? "GET";
  let body = probe.body;
  for (let hop = 0; hop < 6; hop++) {
    const headers: Record<string, string> = {};
    if (probe.signed_in) headers["cookie"] = cookieHeader(cookies);
    if (body !== undefined) headers["content-type"] = probe.content_type ?? "application/json";
    let r: Awaited<ReturnType<Fetcher>>;
    try {
      r = await fetcher(url, { method, headers, ...(body === undefined ? {} : { body }) });
    } catch (e) {
      return { ...base, ok: false, detail: `${method} ${url}: ${(e as Error).message}` };
    }
    if (r.status >= 300 && r.status < 400 && r.location !== null) {
      const next = new URL(r.location, url);
      if (next.origin !== origin) return { ...base, ok: false, detail: `redirected off the app to ${next.origin}${next.pathname}` };
      url = next.toString();
      // A 303, or a 301/302 after a POST, is a GET from here on, as browsers do.
      if (r.status === 303 || method === "POST") { method = "GET"; body = undefined; }
      continue;
    }
    const finalPath = new URL(url).pathname;
    if (r.status < 200 || r.status >= 300) {
      const text = await r.text().catch(() => "");
      return { ...base, ok: false, detail: `${finalPath} answered ${r.status}: ${text.replace(/\s+/g, " ").slice(0, 300)}` };
    }
    if (!samePath(finalPath, target.pathname)) {
      return { ...base, ok: false, detail: `ended at ${finalPath} instead of ${target.pathname}${probe.signed_in ? " (the session was not accepted)" : ""}` };
    }
    if (probe.expect_text !== undefined) {
      const text = await r.text().catch(() => "");
      if (!text.includes(probe.expect_text)) return { ...base, ok: false, detail: `${finalPath} answered ${r.status} without "${probe.expect_text}"` };
    }
    return { ...base, ok: true, detail: `${probe.method ?? "GET"} ${probe.path} answered ${r.status}${probe.expect_text === undefined ? "" : ` with "${probe.expect_text}"`}` };
  }
  return { ...base, ok: false, detail: "too many redirects" };
}

/** Every dependency's probe, in order. Inert ones and ones with no probe are reported, not run. */
export async function runProbes(
  m: SandboxManifest,
  appUrl: string,
  cookies: readonly SessionCookie[],
  fetcher?: Fetcher,
): Promise<readonly ProbeOutcome[]> {
  const out: ProbeOutcome[] = [];
  for (const d of m.dependencies ?? []) {
    if (d.stand_in === "inert") {
      out.push({ dependency: d.name, path: "", signed_in: false, ok: false, detail: "inert: present so the app starts, not exercised" });
      continue;
    }
    if (d.probe === null) {
      out.push({ dependency: d.name, path: "", signed_in: false, ok: false, detail: "no probe: nothing shows this stand-in works" });
      continue;
    }
    out.push(await runProbe(appUrl, d, d.probe, cookies, fetcher));
  }
  return out;
}

/** Whether a trial's proof is complete: sign-in worked if declared, and every dependency was proven. */
export function proofComplete(t: { readonly sign_in?: { readonly ok: boolean }; readonly probes?: readonly ProbeOutcome[] }): boolean {
  return (t.sign_in?.ok ?? true) && (t.probes ?? []).every((p) => p.ok);
}
