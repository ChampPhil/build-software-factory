import { describe, it, expect } from "vitest";
import {
  synthesizeEnv,
  dependenciesFromDockerfile,
  BLOCKED_HOST,
  SENTINEL,
  REGISTRY_ALLOWLIST,
  envVarsViaHelper,
  unenumerableEnvReads,
  DENY_BY_DEFAULT_RATIONALE,
} from "../src/lib/sandbox.js";

/** The variables a real repo reads, taken from its own documentation. */
const TRINSPORTS = [
  "GOOGLESHEETS_SERVICE_ACCOUNT_READER_EMAIL",
  "GOOGLESHEETS_SERVICE_ACCOUNT_READER_PRIVATE_KEY",
  "GOOGLESHEETS_TRINSPORTS_SHEET_ID",
  "AUTH_JS_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "DATABASE_URL",
  "RESEND_API_KEY",
  "RESEND_EMAIL_FROM",
  "GOOGLESHEETS_PING_JOB_SECRET",
  "UNFOLLOW_LINK_SECRET",
  "SITE_URL",
];

describe("synthesizeEnv", () => {
  const byName = (vars: readonly { name: string; value: string; kind: string }[]) =>
    new Map(vars.map((v) => [v.name, v]));

  it("defuses the migration hazard instead of detecting it", () => {
    // The point of the whole module. A build that chains `drizzle-kit migrate`
    // is harmless here, because the only connection string in the sandbox
    // points at the sandbox's own database.
    const v = byName(synthesizeEnv(TRINSPORTS));
    expect(v.get("DATABASE_URL")?.value).toBe("postgresql://sandbox:sandbox@127.0.0.1:5432/sandbox");
    expect(v.get("DATABASE_URL")?.kind).toBe("usable");
  });

  it("points everything dialable at a name that cannot resolve", () => {
    const v = byName(synthesizeEnv(TRINSPORTS));
    expect(v.get("SITE_URL")?.value).toBe(`https://${BLOCKED_HOST}`);
    // RFC 2606 reserves .invalid, so this fails at DNS rather than reaching
    // whatever happens to answer.
    expect(BLOCKED_HOST.endsWith(".invalid")).toBe(true);
  });

  it("gives a private key that parses and opens nothing", () => {
    // An obviously-fake string makes the app crash on boot, which reads as a
    // broken sandbox and tempts whoever is debugging into pasting the real
    // key. A valid key that authenticates nothing is the safer failure.
    const v = byName(synthesizeEnv(TRINSPORTS));
    const key = v.get("GOOGLESHEETS_SERVICE_ACCOUNT_READER_PRIVATE_KEY")?.value ?? "";
    expect(key.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(key).toContain("-----END PRIVATE KEY-----");
    expect(v.get("GOOGLESHEETS_SERVICE_ACCOUNT_READER_PRIVATE_KEY")?.kind).toBe("inert");
  });

  it("makes addresses undeliverable", () => {
    const v = byName(synthesizeEnv(TRINSPORTS));
    for (const name of ["RESEND_EMAIL_FROM", "GOOGLESHEETS_SERVICE_ACCOUNT_READER_EMAIL"]) {
      expect(v.get(name)?.value).toMatch(/@sandbox\.invalid$/);
    }
  });

  it("marks every credential inert, so verification cannot overclaim", () => {
    const v = byName(synthesizeEnv(TRINSPORTS));
    for (const name of ["RESEND_API_KEY", "AUTH_JS_SECRET", "GOOGLE_OAUTH_CLIENT_SECRET", "UNFOLLOW_LINK_SECRET"]) {
      expect(v.get(name)?.kind).toBe("inert");
      expect(v.get(name)?.value.startsWith(SENTINEL)).toBe(true);
    }
  });

  it("covers every name it is given, and invents none", () => {
    // The positive-list property: output names are exactly input names. A
    // denylist would pass through whatever it failed to anticipate.
    const out = synthesizeEnv(TRINSPORTS).map((v) => v.name).sort();
    expect(out).toEqual([...TRINSPORTS].sort());
  });

  it("never emits a value that could be real", () => {
    for (const v of synthesizeEnv([...TRINSPORTS, "STRIPE_SECRET_KEY", "AWS_ACCESS_KEY_ID", "WEIRD_THING"])) {
      const looksLocal = v.value.includes("127.0.0.1");
      const looksBlocked = v.value.includes(".invalid");
      const looksSentinel = v.value.includes(SENTINEL);
      const looksGeneratedKey = v.value.startsWith("-----BEGIN PRIVATE KEY-----");
      expect(looksLocal || looksBlocked || looksSentinel || looksGeneratedKey).toBe(true);
    }
  });

  it("gives an unrecognized name an inert value rather than guessing", () => {
    const [only] = synthesizeEnv(["SOME_OPAQUE_SETTING"]);
    expect(only?.kind).toBe("inert");
    expect(only?.rationale).toContain("shape not recognized");
  });

  it("reads a URL-shaped secret name as a URL", () => {
    // `WEBHOOK_SECRET_URL` is a thing to dial before it is a credential, and
    // getting that order wrong hands the app a sentinel where it wants a host.
    const [only] = synthesizeEnv(["WEBHOOK_SECRET_URL"]);
    expect(only?.value).toBe(`https://${BLOCKED_HOST}`);
  });

  it("deduplicates and is order-independent", () => {
    const a = synthesizeEnv(["B_KEY", "A_URL", "B_KEY"]);
    const b = synthesizeEnv(["A_URL", "B_KEY"]);
    expect(a).toEqual(b);
  });
});

describe("dependenciesFromDockerfile", () => {
  const PROD = `
# The image this repo actually deploys
FROM node:22.4-alpine AS deps
RUN apk add --no-cache libc6-compat vips-dev
FROM deps AS runner
RUN apt-get update && apt-get install -y \\
      ca-certificates \\
      curl
ENV NODE_ENV=production
EXPOSE 3000
VOLUME /data
HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1
USER node
ENTRYPOINT ["./scripts/entrypoint.sh"]
CMD ["npm", "run", "start:prod"]
`;

  it("carries the environment over", () => {
    const d = dependenciesFromDockerfile(PROD);
    expect(d.bases).toEqual(["node:22.4-alpine", "deps"]);
    expect(d.runtimes).toEqual(["node@22.4"]);
    expect(d.systemPackages).toEqual(["ca-certificates", "curl", "libc6-compat", "vips-dev"]);
  });

  it("refuses to carry over what the production image DOES", () => {
    // The distinction the module exists for. Inheriting ENTRYPOINT is how a
    // sandbox ends up running the deployment path it was built to avoid.
    const d = dependenciesFromDockerfile(PROD);
    const dropped = d.dropped.map((x) => x.instruction);
    expect(dropped).toContain("ENTRYPOINT");
    expect(dropped).toContain("CMD");
    expect(dropped).toContain("HEALTHCHECK");
    expect(dropped).toContain("VOLUME");
    expect(dropped).toContain("EXPOSE");
    expect(d.dropped.find((x) => x.instruction === "ENTRYPOINT")?.value).toBe('["./scripts/entrypoint.sh"]');
  });

  it("explains every drop, because a silent one changes behaviour unannounced", () => {
    for (const d of dependenciesFromDockerfile(PROD).dropped) {
      expect(d.why.length).toBeGreaterThan(20);
    }
  });

  it("joins line continuations before looking for packages", () => {
    // Read line-wise, a RUN spanning five backslash-terminated lines finds no
    // package manager at all and the sandbox silently misses its deps.
    const d = dependenciesFromDockerfile("FROM x\nRUN apt-get install -y \\\n  foo \\\n  bar\n");
    expect(d.systemPackages).toEqual(["bar", "foo"]);
  });

  it("strips apt version pins and ignores flags", () => {
    const d = dependenciesFromDockerfile("FROM x\nRUN apt-get install -y --no-install-recommends git=1:2.39\n");
    expect(d.systemPackages).toEqual(["git"]);
  });

  it("skips a templated FROM rather than recording a variable as an image", () => {
    const d = dependenciesFromDockerfile("ARG BASE\nFROM $BASE\nFROM python:3.12-slim\n");
    expect(d.bases).toEqual(["python:3.12-slim"]);
    expect(d.runtimes).toEqual(["python@3.12"]);
  });

  it("handles an empty or comment-only file without inventing anything", () => {
    const d = dependenciesFromDockerfile("# nothing here\n\n");
    expect(d).toEqual({ bases: [], systemPackages: [], runtimes: [], dropped: [] });
  });
});

describe("REGISTRY_ALLOWLIST", () => {
  it("holds package registries and no application provider", () => {
    // An app that cannot build without reaching its production API has a
    // build coupled to production. The response is to say so, not to widen
    // this list.
    for (const host of REGISTRY_ALLOWLIST) {
      expect(host).not.toMatch(/vercel|neon|supabase|resend|stripe|openai|anthropic/);
    }
    expect(REGISTRY_ALLOWLIST).toContain("registry.npmjs.org");
  });
});

describe("envVarsViaHelper", () => {
  // The shape found in a real repo, which a literal-only scan misses entirely.
  const ONE_LEVEL = `
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(\`Missing env var \${name}\`);
  return value;
}
const sheetId = requireEnv("GOOGLESHEETS_TRINSPORTS_SHEET_ID");
`;

  const TWO_LEVELS = `${ONE_LEVEL}
function requirePrivateKey(name: string): string {
  const raw = requireEnv(name).replace(/\\\\n/g, "\\n");
  return raw;
}
const key = requirePrivateKey("SERVICE_ACCOUNT_PRIVATE_KEY");
`;

  it("finds a variable read through a helper", () => {
    expect(envVarsViaHelper(ONE_LEVEL)).toEqual(["GOOGLESHEETS_TRINSPORTS_SHEET_ID"]);
  });

  it("follows a helper that delegates to another helper", () => {
    // One level of resolution found 11 of a real repo's 12 variables, which is
    // the worst outcome available: complete enough to look trustworthy.
    expect(envVarsViaHelper(TWO_LEVELS)).toEqual([
      "GOOGLESHEETS_TRINSPORTS_SHEET_ID",
      "SERVICE_ACCOUNT_PRIVATE_KEY",
    ]);
  });

  it("finds the arrow form", () => {
    const src = `const env = (k: string) => process.env[k] ?? "";\nenv("API_BASE_URL");`;
    expect(envVarsViaHelper(src)).toEqual(["API_BASE_URL"]);
  });

  it("does not promote an unrelated function that merely sits above a dynamic read", () => {
    const src = `
function unrelated(name: string) { return name.trim(); }
${"\\n".repeat(1)}
${"// filler\\n".repeat(200)}
function real(key: string) { return process.env[key]; }
unrelated("NOT_AN_ENV_VAR");
real("REAL_VAR");
`;
    expect(envVarsViaHelper(src)).toEqual(["REAL_VAR"]);
  });

  it("terminates on mutually recursive helpers", () => {
    const src = `
function a(n: string) { return b(n); }
function b(n: string) { return a(n) ?? process.env[n]; }
a("SOME_VAR");
`;
    expect(envVarsViaHelper(src)).toContain("SOME_VAR");
  });

  it("reports nothing when there is no helper", () => {
    expect(envVarsViaHelper(`const x = process.env.PLAIN_NAME;`)).toEqual([]);
  });
});

describe("unenumerableEnvReads", () => {
  it("reports a computed name, because no scan can list what it asks for", () => {
    const found = unenumerableEnvReads(`const v = process.env[name];`);
    expect(found).toEqual(["name"]);
  });

  it("reports the whole object being aliased", () => {
    // `const env = process.env` hands the app everything, which is exactly
    // what a closed sandbox has to make harmless.
    expect(unenumerableEnvReads(`const env = process.env;`)).toContain("aliased as `env`");
  });

  it("does not report a literal index, which is enumerable", () => {
    expect(unenumerableEnvReads(`process.env["DATABASE_URL"]`)).toEqual([]);
  });

  it("stays quiet on a file that reads nothing dynamically", () => {
    expect(unenumerableEnvReads(`const a = process.env.FOO; const b = 1;`)).toEqual([]);
  });
});

describe("planSandbox fail-closed guarantee", () => {
  it("says the environment is closed, not additive", () => {
    // The guarantee is a property of the container, not of the scanner: a
    // variable the scan missed must be absent rather than inherited.
    expect(DENY_BY_DEFAULT_RATIONALE).toContain("exactly the variables listed and nothing else");
    expect(DENY_BY_DEFAULT_RATIONALE).toContain("absent rather than");
  });
});
