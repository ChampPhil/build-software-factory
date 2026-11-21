import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

/**
 * Stubs that stand in for a third party at its own address.
 *
 * Many clients do not let the app choose where they connect: a Google API
 * client calls sheets.googleapis.com, a serverless database driver derives
 * its HTTPS endpoint from the connection string, an OAuth provider is found
 * by discovery at a fixed URL. A stub the app cannot be pointed at is no
 * stub. So a stub may name the hosts it answers for, and the sandbox makes
 * those names resolve to it: the names go into /etc/hosts as 127.0.0.1, a
 * TLS front on 443 presents a certificate for them from a CA made for this
 * run and trusted only on this runner, and each request is forwarded to the
 * stub's own plain-HTTP port. Language blind: it changes name resolution and
 * trust, which every HTTP client already uses, not any client's code.
 *
 * The CA's key never leaves the runner and is made fresh each run, so a
 * certificate it signs is worth nothing anywhere else.
 */

export interface InterceptedStub {
  readonly name: string;
  readonly path: string;
  readonly hosts?: readonly string[];
  readonly port?: number;
  readonly start?: string;
}

export interface Interception {
  readonly caFile: string;
  /** Environment that makes common runtimes trust the CA, on top of the system store. */
  readonly env: Record<string, string>;
  readonly routes: Record<string, number>;
}

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Problems with the stubs that name hosts, or none. */
export function interceptionProblems(stubs: readonly InterceptedStub[]): readonly string[] {
  const out: string[] = [];
  const seen = new Map<string, string>();
  for (const s of stubs) {
    if (s.hosts === undefined || s.hosts.length === 0) continue;
    if (s.port === undefined) out.push(`stub ${s.name} names hosts but no port to forward them to`);
    if (s.start === undefined) out.push(`stub ${s.name} names hosts but no command to start it`);
    for (const h of s.hosts) {
      if (!HOST.test(h)) out.push(`stub ${s.name}: "${h}" is not a hostname`);
      const other = seen.get(h.toLowerCase());
      if (other !== undefined) out.push(`${h} is claimed by both ${other} and ${s.name}`);
      seen.set(h.toLowerCase(), s.name);
    }
  }
  return out;
}

export function routesOf(stubs: readonly InterceptedStub[]): Record<string, number> {
  const routes: Record<string, number> = {};
  for (const s of stubs) for (const h of s.hosts ?? []) if (s.port !== undefined) routes[h.toLowerCase()] = s.port;
  return routes;
}

function run(cmd: string, args: readonly string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${(r.stderr ?? "").trim() || `exit ${r.status}`}`);
}

/** A CA made for this run, and one certificate for every intercepted host. */
export function makeCertificates(dir: string, hosts: readonly string[]): { ca: string; cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const ca = join(dir, "ca.crt");
  const caKey = join(dir, "ca.key");
  const key = join(dir, "stubs.key");
  const csr = join(dir, "stubs.csr");
  const cert = join(dir, "stubs.crt");
  const ext = join(dir, "stubs.ext");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", ca, "-days", "2", "-subj", "/CN=bsf sandbox stubs (this run only)",
    // Strict verifiers (Python 3.13, Go) reject a CA without these.
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-addext", "subjectKeyIdentifier=hash"]);
  run("openssl", ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${hosts[0] ?? "stub"}`]);
  writeFileSync(
    ext,
    `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(",")}\n` +
      "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" +
      "subjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n",
  );
  run("openssl", ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert, "-days", "2", "-extfile", ext]);
  return { ca, cert, key };
}

const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * Point the hosts at this runner and trust the CA. Needs sudo, which GitHub's
 * runners give a job; it changes only this runner, which is thrown away.
 */
export function applyInterception(dir: string, stubs: readonly InterceptedStub[], log: (l: string) => void): Interception | null {
  const routes = routesOf(stubs);
  const hosts = Object.keys(routes);
  if (hosts.length === 0) return null;
  const problems = interceptionProblems(stubs);
  if (problems.length > 0) throw new Error(`stubs cannot be set up:\n  ${problems.join("\n  ")}`);
  const { ca, cert, key } = makeCertificates(dir, hosts);
  const current = existsSync("/etc/hosts") ? readFileSync("/etc/hosts", "utf8") : "";
  const add = hosts.filter((h) => !new RegExp(`\\s${h.replace(/\./g, "\\.")}(\\s|$)`, "m").test(current));
  if (add.length > 0) {
    run("sudo", ["sh", "-c", `printf '%s\\n' ${add.map((h) => `'127.0.0.1 ${h}'`).join(" ")} >> /etc/hosts`]);
  }
  run("sudo", ["cp", ca, "/usr/local/share/ca-certificates/bsf-sandbox-stubs.crt"]);
  run("sudo", ["update-ca-certificates"]);
  // The front needs port 443, so it runs as root; it only forwards to the
  // stubs' own ports on 127.0.0.1.
  const routesFile = join(dir, "routes.json");
  writeFileSync(routesFile, JSON.stringify({ routes, cert, key }));
  const logFile = openSync(join(dir, "front.log"), "a");
  // A standalone script, so the front runs the same whether bsf was started
  // from its bundle, from source, or from a test.
  const frontFile = join(dir, "front.mjs");
  writeFileSync(frontFile, FRONT_SOURCE);
  const front = spawn("sudo", [process.execPath, frontFile, routesFile], {
    detached: true,
    stdio: ["ignore", logFile, logFile],
  });
  front.unref();
  log(`stubs answer for ${hosts.join(", ")} through a TLS front on 443`);
  const bundle = existsSync(SYSTEM_BUNDLE) ? SYSTEM_BUNDLE : ca;
  return {
    caFile: ca,
    routes,
    env: {
      // Node keeps its own CA list; the others read the system bundle,
      // which update-ca-certificates has just extended.
      NODE_EXTRA_CA_CERTS: ca,
      SSL_CERT_FILE: bundle,
      REQUESTS_CA_BUNDLE: bundle,
      CURL_CA_BUNDLE: bundle,
    },
  };
}

/** Start each stub with its port, and wait for it to listen. */
export async function startStubs(
  stubs: readonly InterceptedStub[],
  root: string,
  env: Record<string, string>,
  logDir: string,
  log: (l: string) => void,
): Promise<void> {
  mkdirSync(logDir, { recursive: true });
  for (const s of stubs) {
    if (s.start === undefined || s.port === undefined) continue;
    log(`starting stub ${s.name} on ${s.port}: ${s.start}`);
    const out = openSync(join(logDir, `${s.name}.log`), "a");
    const child = spawn("bash", ["-c", s.start], {
      cwd: root,
      env: { ...env, PORT: String(s.port) },
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.unref();
    const deadline = Date.now() + 60_000;
    while (!(await listening(s.port))) {
      if (Date.now() > deadline) throw new Error(`stub ${s.name} did not listen on ${s.port} within 60s (see ${logDir}/${s.name}.log)`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
  });
}

/** The TLS front, run as root by applyInterception: forwards each host to its stub. */
const FRONT_SOURCE = `import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { request } from "node:http";
const { routes, cert, key } = JSON.parse(readFileSync(process.argv[2], "utf8"));
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  const host = (req.headers.host || "").replace(/:\\d+$/, "").toLowerCase();
  const port = routes[host];
  if (port === undefined) { res.writeHead(502); res.end("no stub answers for " + host + "\\n"); return; }
  const up = request({ host: "127.0.0.1", port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on("error", (e) => { res.writeHead(502); res.end("stub for " + host + " did not answer: " + e.message + "\\n"); });
  req.pipe(up);
}).listen(443, "127.0.0.1");
`;
