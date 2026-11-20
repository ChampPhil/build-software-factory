import { generateKeyPairSync } from "node:crypto";

/**
 * Building a sandbox the app cannot escape.
 *
 * The original design had the sandbox *reuse the repo's deployment logic*: an
 * existing Dockerfile became the base, the repo's own commands became the
 * runbook, and step 5 said to list the secrets the app needs and give them to
 * the sandbox. A warning thirty lines below said never to let the sandbox
 * inherit real credentials. Both were prose addressed to an agent, and they
 * contradicted each other, so whichever the agent read more literally won.
 *
 * The deeper problem is that deployment logic exists in order to reach
 * production. Reusing it and then trying to spot the dangerous parts is a
 * denylist: it works until the hazard takes a shape nobody enumerated — a
 * Dockerfile ENTRYPOINT, a compose service pointed at a real host, a config
 * file that loads `.env.local` on import, a Makefile target, a postinstall
 * hook, a framework's instrumentation file that opens a connection on boot.
 *
 * So the safety here does not come from which commands the sandbox avoids
 * running. It comes from what the sandbox cannot reach:
 *
 * 1. Every variable the app reads is SYNTHESIZED (`synthesizeEnv`). No real
 *    credential is placed in the sandbox, so there is nothing for a command to
 *    misuse. Values are shaped to parse, so the app fails at connect time
 *    rather than at startup, which is what makes verification meaningful.
 * 2. Anything the app would dial points at a name that cannot resolve. Hosts
 *    come from `.invalid`, reserved by RFC 2606 and guaranteed never to
 *    resolve, so a command aimed at production fails at DNS.
 * 3. A repo's Dockerfile is read for DEPENDENCIES and never for BEHAVIOUR
 *    (`dependenciesFromDockerfile`). Runtimes and system packages carry over.
 *    ENTRYPOINT, CMD and HEALTHCHECK do not, and what was dropped is reported.
 *
 * Under this, `drizzle-kit migrate` in a build chain stops being a hazard to
 * detect and becomes a command that migrates a throwaway database, because the
 * only connection string present points at one. The command-level check in
 * `script_hazards.ts` stays, demoted to what it should always have been: a
 * diagnostic that explains a failure and flags commands needing a throwaway
 * target, not the thing standing between an agent and production.
 */

/** Guaranteed not to resolve: RFC 2606 reserves `.invalid` for exactly this. */
export const BLOCKED_HOST = "blocked.sandbox.invalid";

/**
 * Prefixes every synthesized secret. Recognizable on purpose: finding this
 * string in a log line, an outbound request or a database row says a fake
 * value travelled somewhere, which is a bug to fix but not a disclosure. A
 * real credential in the same place is an incident.
 */
export const SENTINEL = "sandbox-fake";

export interface SynthesizedVar {
  readonly name: string;
  readonly value: string;
  /** Why this value, in the terms a reader needs to judge it. */
  readonly rationale: string;
  /**
   * Whether the app can actually work against this value. A local sidecar is
   * `usable`; a fake API key is `inert` and any code path needing it fails.
   * The runbook records inert variables, because they bound what verification
   * can claim to have checked.
   */
  readonly kind: "usable" | "inert";
}

/** Services the sandbox can genuinely run, so these get real local targets. */
const SIDECARS: readonly { match: RegExp; value: string; what: string }[] = [
  {
    match: /^(DATABASE_URL|POSTGRES_(URL|URI)|PG(_|)DATABASE_URL|DB_URL)$/,
    value: "postgresql://sandbox:sandbox@127.0.0.1:5432/sandbox",
    what: "the sandbox's own Postgres",
  },
  { match: /^(REDIS_URL|REDIS_URI|CACHE_URL)$/, value: "redis://127.0.0.1:6379", what: "the sandbox's own Redis" },
  { match: /^(MONGO(DB)?_(URL|URI))$/, value: "mongodb://127.0.0.1:27017/sandbox", what: "the sandbox's own MongoDB" },
  { match: /^(MYSQL_URL|MYSQL_URI)$/, value: "mysql://sandbox:sandbox@127.0.0.1:3306/sandbox", what: "the sandbox's own MySQL" },
  { match: /^(S3_ENDPOINT|AWS_ENDPOINT_URL|MINIO_ENDPOINT)$/, value: "http://127.0.0.1:9000", what: "the sandbox's own MinIO" },
];

/**
 * A throwaway RSA key, generated once per process.
 *
 * Apps that read a private key parse it on boot: an obviously-fake string
 * makes the app crash at startup, which looks like a broken sandbox and sends
 * whoever is debugging it toward pasting in the real key. A valid key that
 * opens nothing lets the app start and fail at the point of use, which is the
 * behaviour worth having.
 */
let throwawayKey: string | null = null;
function throwawayPrivateKey(): string {
  if (throwawayKey === null) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    throwawayKey = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }
  return throwawayKey;
}

/**
 * A throwaway value for every variable the app reads.
 *
 * A positive list by construction: the input is the set of names the code
 * actually reads, and every one of them gets a value from here. There is no
 * path by which a value from the host environment reaches the result, which
 * is the property that matters — a denylist of secret-looking names would let
 * through whatever it failed to anticipate.
 */
export function synthesizeEnv(names: readonly string[]): readonly SynthesizedVar[] {
  const out: SynthesizedVar[] = [];

  for (const name of [...new Set(names)].sort()) {
    const sidecar = SIDECARS.find((s) => s.match.test(name));
    if (sidecar !== undefined) {
      out.push({
        name,
        value: sidecar.value,
        rationale: `points at ${sidecar.what}, so a migration or a write here touches throwaway data`,
        kind: "usable",
      });
      continue;
    }

    if (/PRIVATE_KEY$/.test(name)) {
      out.push({
        name,
        value: throwawayPrivateKey(),
        rationale: "a generated key that parses and authenticates nothing, so the app boots and fails at use",
        kind: "inert",
      });
      continue;
    }

    // Anything the app would dial. Checked before the credential shapes
    // because names like `WEBHOOK_SECRET_URL` are a URL first.
    if (/(_URL|_URI|_ENDPOINT|_HOST|_DOMAIN|_ORIGIN|_BASE)$/.test(name)) {
      out.push({
        name,
        value: `https://${BLOCKED_HOST}`,
        rationale: `${BLOCKED_HOST} cannot resolve, so a request aimed at production fails at DNS`,
        kind: "inert",
      });
      continue;
    }

    if (/(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASS|_CREDENTIALS|_DSN|_SIGNATURE)$/.test(name)) {
      out.push({
        name,
        value: `${SENTINEL}-${name.toLowerCase().replace(/_/g, "-")}`,
        rationale: "an inert value; any code path that needs the real credential fails loudly",
        kind: "inert",
      });
      continue;
    }

    if (/(_EMAIL|_FROM|_SENDER|_RECIPIENT)$/.test(name)) {
      // `.invalid` again, so a message that escapes the sandbox cannot be
      // delivered to a real person.
      out.push({
        name,
        value: `${SENTINEL}@sandbox.invalid`,
        rationale: "an undeliverable address, so a message that escapes reaches nobody",
        kind: "inert",
      });
      continue;
    }

    if (/(_ID|_ACCOUNT|_PROJECT|_ORG|_TENANT|_BUCKET|_REGION|_SHEET_ID)$/.test(name)) {
      out.push({
        name,
        value: `${SENTINEL}-${name.toLowerCase().replace(/_/g, "-")}`,
        rationale: "an identifier that matches nothing real",
        kind: "inert",
      });
      continue;
    }

    out.push({
      name,
      value: `${SENTINEL}-${name.toLowerCase().replace(/_/g, "-")}`,
      rationale: "shape not recognized, so an inert sentinel; adjust in the runbook if the app needs more",
      kind: "inert",
    });
  }

  return out;
}

export interface DockerfileDependencies {
  /** Base images, in order, so a multi-stage file is not flattened silently. */
  readonly bases: readonly string[];
  /** System packages installed by a recognized package manager. */
  readonly systemPackages: readonly string[];
  /** Language runtime versions pinned in the file, as `tool@version`. */
  readonly runtimes: readonly string[];
  /**
   * Instructions deliberately NOT carried into the sandbox, each with the
   * reason. Reported rather than silently dropped: a sandbox that quietly
   * discards an ENTRYPOINT behaves differently from the image the user knows,
   * and they should be told which difference.
   */
  readonly dropped: readonly { readonly instruction: string; readonly value: string; readonly why: string }[];
}

/**
 * Read a Dockerfile for what the app needs installed, never for what it does.
 *
 * The distinction is the whole point. `FROM node:22` and `apt-get install
 * libvips` describe an environment and carry over. `ENTRYPOINT ["./deploy.sh"]`
 * and `CMD ["npm", "run", "start:prod"]` describe an intent aimed at
 * production and do not — inheriting them is how a sandbox ends up running the
 * deployment path it was built to avoid.
 */
export function dependenciesFromDockerfile(text: string): DockerfileDependencies {
  const bases: string[] = [];
  const systemPackages = new Set<string>();
  const runtimes = new Set<string>();
  const dropped: { instruction: string; value: string; why: string }[] = [];

  // Join continuations first: a RUN spanning five backslash-terminated lines
  // is one instruction, and reading it line-wise finds no package manager.
  const logical = text.replace(/\\\r?\n\s*/g, " ").split(/\r?\n/);

  const DROP: Record<string, string> = {
    ENTRYPOINT: "describes what the production image runs, not what the app needs installed",
    CMD: "describes what the production image runs, not what the app needs installed",
    HEALTHCHECK: "probes a production service; the sandbox verifies through the runbook instead",
    EXPOSE: "the sandbox publishes only what the runbook needs",
    VOLUME: "a production mount point; the sandbox mounts the workspace instead",
    USER: "re-applied by the sandbox, not inherited",
    ONBUILD: "runs in images built FROM this one, which the sandbox is not",
    STOPSIGNAL: "production lifecycle",
  };

  for (const raw of logical) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(line);
    if (m === null) continue;
    const instruction = (m[1] ?? "").toUpperCase();
    const value = (m[2] ?? "").trim();

    if (instruction === "FROM") {
      const image = value.split(/\s+/)[0];
      if (image !== undefined && !image.startsWith("$")) {
        bases.push(image);
        // `node:22.1-alpine` → `node@22.1`. The tag is the version the repo
        // chose, and it is the single most useful thing in the file.
        const tag = /^([a-z0-9./-]+):([0-9][0-9a-zA-Z.\-]*)/.exec(image);
        if (tag?.[1] !== undefined && tag[2] !== undefined) {
          runtimes.add(`${tag[1].split("/").pop() ?? tag[1]}@${tag[2].replace(/-(alpine|slim|bookworm|bullseye).*$/, "")}`);
        }
      }
      continue;
    }

    if (DROP[instruction] !== undefined) {
      dropped.push({ instruction, value, why: DROP[instruction] });
      continue;
    }

    if (instruction === "RUN") {
      for (const pm of [
        /\bapt(?:-get)?\s+install\b([^&|;]*)/g,
        /\bapk\s+add\b([^&|;]*)/g,
        /\b(?:dnf|yum|microdnf)\s+install\b([^&|;]*)/g,
        /\bpacman\s+-S\b([^&|;]*)/g,
      ]) {
        for (const hit of value.matchAll(pm)) {
          for (const word of (hit[1] ?? "").split(/\s+/)) {
            // Flags, and the version pins apt accepts as `pkg=1.2`.
            if (word === "" || word.startsWith("-")) continue;
            const pkg = word.split("=")[0];
            if (pkg !== undefined && /^[a-z0-9][a-z0-9+._-]*$/.test(pkg)) systemPackages.add(pkg);
          }
        }
      }
    }
  }

  return {
    bases,
    systemPackages: [...systemPackages].sort(),
    runtimes: [...runtimes].sort(),
    dropped,
  };
}

/**
 * Hosts the sandbox may reach. Everything else is refused.
 *
 * Package registries only, because an install has to work. Deliberately NOT
 * here: the app's own provider domains. An app that cannot build without
 * reaching its production API is an app whose build is coupled to production,
 * and the right response is to say so rather than to open the hole.
 */
export const REGISTRY_ALLOWLIST: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "rubygems.org",
  "repo.maven.apache.org",
  "api.nuget.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

/* ========================================================================== *
 * Enumerating what the app reads — and never trusting that enumeration
 * ========================================================================== */

/**
 * Variables read through a local helper, e.g. `requireEnv("DATABASE_URL")`.
 *
 * Found by scanning a real repo and noticing three variables missing from the
 * plan. The code read them like this:
 *
 *     function requireEnv(name: string) { const value = process.env[name]; ... }
 *     requireEnv("GOOGLESHEETS_SERVICE_ACCOUNT_READER_EMAIL")
 *
 * A scanner looking for `process.env.NAME` sees no literal and reports
 * nothing, and this indirection is what careful code looks like, so the miss
 * lands hardest on the repos that did the most to be tidy.
 *
 * Resolved transitively, because helpers delegate. The same repo had a second
 * layer:
 *
 *     function requirePrivateKey(name) { return requireEnv(name).replace(...) }
 *     requirePrivateKey("GOOGLESHEETS_SERVICE_ACCOUNT_READER_PRIVATE_KEY")
 *
 * One level of resolution finds eleven of that repo's twelve variables and
 * misses the twelfth, which is the worst possible outcome: complete enough to
 * look trustworthy. So a function that passes its own parameter to a known
 * helper becomes a helper itself, to a fixed point.
 *
 * Still deliberately not a type-aware analysis — a helper re-exported across
 * modules is missed. That is what `unenumerableEnvReads` is for, and why the
 * sandbox never assumes this list is complete.
 */
export function envVarsViaHelper(source: string): readonly string[] {
  /** Every `name(param` declaration, with the slice of body to search. */
  const declared: { name: string; param: string; body: string }[] = [];
  const decl =
    /(?:function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*))/g;
  for (const m of source.matchAll(decl)) {
    const name = m[1] ?? m[3];
    const param = (m[2] ?? m[4] ?? "").replace(/[?:].*$/, "").trim();
    if (name === undefined || param === "") continue;
    // Bounded, so a later unrelated `process.env[x]` does not promote every
    // function above it into a helper.
    declared.push({ name, param, body: source.slice(m.index, m.index + 1200) });
  }

  const helpers = new Set<string>();
  for (const d of declared) {
    if (new RegExp(`process\\.env\\s*\\[\\s*${d.param}\\b`).test(d.body)) helpers.add(d.name);
  }
  // Fixed point: a function handing its own parameter to a known helper is
  // reading the environment just as much as the helper is. Bounded by the
  // declaration count, so a mutually recursive pair terminates.
  for (let pass = 0; pass < declared.length + 1; pass += 1) {
    let grew = false;
    for (const d of declared) {
      if (helpers.has(d.name)) continue;
      for (const known of helpers) {
        if (new RegExp(`\\b${known}\\s*\\(\\s*${d.param}\\b`).test(d.body)) {
          helpers.add(d.name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }

  const found = new Set<string>();
  for (const helper of helpers) {
    const call = new RegExp(`\\b${helper}\\s*\\(\\s*["'\`]([A-Z][A-Z0-9_]{2,})["'\`]`, "g");
    for (const m of source.matchAll(call)) {
      const name = m[1];
      if (name !== undefined) found.add(name);
    }
  }
  return [...found].sort();
}

/**
 * Reads this scan cannot resolve to a name.
 *
 * `process.env[someExpression]` where the expression is not a literal: a
 * computed name, a loop over a list, a helper reached through a re-export.
 * Each one is a variable the scan cannot enumerate.
 *
 * This exists because the honest answer to "which variables does this app
 * read?" is that no static scan can promise completeness, and the sandbox
 * must not be built on a promise that cannot be kept. Reported so the plan
 * can say so, and so `denyByDefault` below is understood as load-bearing
 * rather than belt-and-braces.
 */
export function unenumerableEnvReads(source: string): readonly string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/process\.env\s*\[\s*([^\]]+?)\s*\]/g)) {
    const expr = (m[1] ?? "").trim();
    // A literal is enumerable and already handled.
    if (/^["'`][A-Za-z_][\w]*["'`]$/.test(expr)) continue;
    out.add(expr.slice(0, 60));
  }
  // Aliasing the whole object: `const { A, B } = process.env` is enumerable
  // and `const v = process.env[name]` is the case above, but `const env =
  // process.env` hands the app everything.
  //
  // The lookahead is load-bearing. Written with a trailing `\b`, this matched
  // `const a = process.env.FOO` — because `\b` sits happily before the dot —
  // and reported every ordinary single-variable read as an alias of the whole
  // environment. Caught by its own test.
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\s*(?![.[\w])/g)) {
    const name = m[1];
    if (name !== undefined) out.add(`aliased as \`${name}\``);
  }
  return [...out].sort();
}

/**
 * Why the sandbox starts from an empty environment.
 *
 * The guarantee cannot be "the scanner found every variable," because
 * `unenumerableEnvReads` shows that claim is unprovable. It has to be a
 * property of the container: the sandbox is given EXACTLY the synthesized
 * variables and nothing else, so a variable the scan missed is ABSENT rather
 * than INHERITED.
 *
 * That turns a scanner gap from a silent hole into a loud failure. A missed
 * `DATABASE_URL` makes the app throw on boot, which someone fixes by adding
 * it to the plan. A missed variable in an inheriting sandbox makes the app
 * work — against whatever the host had.
 *
 * Fail-closed, and the direction of failure is the whole design.
 */
export const DENY_BY_DEFAULT_RATIONALE =
  "The sandbox is given exactly the variables listed and nothing else. No static scan can " +
  "prove it found every variable an app reads, so a missed one must be absent rather than " +
  "inherited: the app then fails loudly on boot instead of quietly working against whatever " +
  "the host environment held.";
