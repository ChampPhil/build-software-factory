/**
 * Scripts that touch persistent state, and the scripts that reach them.
 *
 * Phase 2 of the setup skill tells the agent to "classify the repo's commands
 * rather than copying them," because a documented build command is not safe to
 * run just because it is documented. That was prose, and prose addressed to an
 * agent is a suggestion. This is the check.
 *
 * The case it exists for, found in a real repository:
 *
 *     "build": "npm run db:migrate && next build"
 *
 * A human running that migrates their own development database, which they
 * know about and accept. A factory running it as its verification command
 * migrates whatever `DATABASE_URL` points at, on every verification, including
 * verifications of pull requests that generated the migration being applied.
 * Nobody has read that SQL. `drizzle-kit generate` emits `DROP COLUMN` without
 * being asked when a field leaves the schema file.
 *
 * So the hazard is not "this command is destructive." It is "a command whose
 * name says `build` has an irreversible effect outside the working tree, and
 * the factory is about to run it a few hundred times unattended."
 *
 * What this does NOT do: judge whether the effect is acceptable. A repo whose
 * build deploys may be exactly right for its owner. The finding says where the
 * effect is and which script carries it there; the factory definition decides.
 */

/** A command that changes something that outlives the process. */
interface Hazard {
  readonly pattern: RegExp;
  /** What the command does, in the terms a reader needs to judge it. */
  readonly effect: string;
  readonly kind: "migration" | "deploy" | "publish" | "infra";
}

/**
 * Matched against script bodies. Anchored on the tool name and the subcommand
 * together: `prisma generate` is pure codegen and `prisma migrate deploy`
 * applies SQL, and a pattern that caught the tool alone would flag every repo
 * that uses an ORM.
 */
const HAZARDS: readonly Hazard[] = [
  // Schema migrations. Each of these applies SQL to whatever the connection
  // string points at, and each is routinely wired into a build.
  { pattern: /\bdrizzle-kit\s+(migrate|push)\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\bprisma\s+migrate\s+(deploy|dev)\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\bprisma\s+db\s+push\b/, effect: "pushes the schema to the database", kind: "migration" },
  { pattern: /\bknex\s+migrate:(latest|up)\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\bsequelize\s+db:migrate\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\balembic\s+upgrade\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\brails\s+db:migrate\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\b(atlas\s+migrate\s+apply|flyway\s+migrate|goose\s+up|dbmate\s+up)\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\bmikro-orm\s+migration:up\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\btypeorm\s+migration:run\b/, effect: "applies database migrations", kind: "migration" },
  { pattern: /\bsupabase\s+db\s+push\b/, effect: "pushes the schema to the database", kind: "migration" },

  // Deploys. These make a change the public can see.
  { pattern: /\bvercel\s+(deploy|--prod)\b/, effect: "deploys to Vercel", kind: "deploy" },
  { pattern: /\bwrangler\s+(deploy|publish)\b/, effect: "deploys to Cloudflare", kind: "deploy" },
  { pattern: /\bfirebase\s+deploy\b/, effect: "deploys to Firebase", kind: "deploy" },
  { pattern: /\b(sls|serverless)\s+deploy\b/, effect: "deploys with Serverless", kind: "deploy" },
  { pattern: /\bnetlify\s+deploy\b/, effect: "deploys to Netlify", kind: "deploy" },
  { pattern: /\beb\s+deploy\b/, effect: "deploys to Elastic Beanstalk", kind: "deploy" },
  { pattern: /\bkubectl\s+(apply|delete)\b/, effect: "changes a Kubernetes cluster", kind: "infra" },
  { pattern: /\bhelm\s+(install|upgrade)\b/, effect: "changes a Kubernetes release", kind: "infra" },
  { pattern: /\bterraform\s+(apply|destroy)\b/, effect: "changes infrastructure", kind: "infra" },
  { pattern: /\bpulumi\s+up\b/, effect: "changes infrastructure", kind: "infra" },
  { pattern: /\baws\s+s3\s+(sync|cp|rm)\b/, effect: "writes to an S3 bucket", kind: "infra" },

  // Publishes. These are irreversible in the strongest sense: a registry
  // version, once taken, stays taken.
  { pattern: /\bnpm\s+publish\b/, effect: "publishes to the npm registry", kind: "publish" },
  { pattern: /\b(pnpm|yarn)\s+publish\b/, effect: "publishes to the npm registry", kind: "publish" },
  { pattern: /\btwine\s+upload\b/, effect: "publishes to PyPI", kind: "publish" },
  { pattern: /\bcargo\s+publish\b/, effect: "publishes to crates.io", kind: "publish" },
  { pattern: /\bgem\s+push\b/, effect: "publishes to RubyGems", kind: "publish" },
  { pattern: /\bdocker\s+push\b/, effect: "pushes a container image", kind: "publish" },
  { pattern: /\bgh\s+release\s+create\b/, effect: "creates a GitHub release", kind: "publish" },
];

/**
 * Scripts a runbook is likely to record as safe to run repeatedly. A hazard
 * reachable from one of these is the finding; a hazard in a script named
 * `deploy` is that script doing its job.
 */
const EXPECTED_SAFE = /^(build|test|tests|verify|check|ci|lint|typecheck|start|dev|serve|preview|compile|bundle)(:|$)/;

export interface ScriptHazard {
  /** The script a runbook would record, e.g. `build`. */
  readonly script: string;
  /** How the hazard is reached: ["build", "db:migrate"] for a one-hop chain. */
  readonly via: readonly string[];
  /** The matched command text, trimmed. */
  readonly command: string;
  readonly effect: string;
  readonly kind: Hazard["kind"];
}

/**
 * Other scripts a script body invokes.
 *
 * `npm run db:migrate && next build` yields ["db:migrate"]. Covers the npm,
 * pnpm and yarn spellings, `run-s`/`run-p` from npm-run-all, and yarn's
 * bare-name form (`yarn db:migrate`), which has no `run` to key on and so is
 * matched only against names the manifest actually defines.
 */
export function invokedScripts(body: string, defined: ReadonlySet<string>): readonly string[] {
  const out = new Set<string>();

  for (const m of body.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+run\s+([a-zA-Z0-9:_.-]+)/g)) {
    const name = m[1];
    if (name !== undefined && defined.has(name)) out.add(name);
  }
  // npm-run-all: `run-s lint test` invokes each argument as a script.
  for (const m of body.matchAll(/\b(?:run-s|run-p|npm-run-all)\s+([^&|;]+)/g)) {
    for (const word of (m[1] ?? "").split(/\s+/)) {
      // Flags, and globs like `test:*`, which we do not expand.
      if (word.startsWith("-") || word.includes("*")) continue;
      if (defined.has(word)) out.add(word);
    }
  }
  // `yarn <script>` with no `run`. Guarded by `defined` because otherwise
  // `yarn install` reads as a script named install.
  for (const m of body.matchAll(/\byarn\s+([a-zA-Z0-9:_.-]+)/g)) {
    const name = m[1];
    if (name !== undefined && name !== "run" && defined.has(name)) out.add(name);
  }
  return [...out];
}

/** The hazards in one script body, ignoring anything it delegates to. */
function hazardsIn(body: string): readonly { command: string; effect: string; kind: Hazard["kind"] }[] {
  const found: { command: string; effect: string; kind: Hazard["kind"] }[] = [];
  for (const h of HAZARDS) {
    const m = h.pattern.exec(body);
    if (m === null) continue;
    // The matched command plus a little of what follows, so a reader can see
    // `drizzle-kit migrate --config=x` rather than a bare tool name.
    const start = m.index;
    const slice = body.slice(start).split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? m[0];
    found.push({ command: slice.trim(), effect: h.effect, kind: h.kind });
  }
  return found;
}

/**
 * Every hazard reachable from a script whose name promises it is safe to run.
 *
 * Walks each script's chain depth-first with a visited set, so a manifest
 * whose scripts reference each other in a cycle terminates instead of
 * recursing until the stack gives out. A cycle is a broken manifest, but a
 * check that crashes on broken input reports nothing about the input it could
 * have read.
 */
export function scriptHazards(scripts: Readonly<Record<string, string>>): readonly ScriptHazard[] {
  const defined = new Set(Object.keys(scripts));
  const out: ScriptHazard[] = [];

  for (const entry of Object.keys(scripts)) {
    if (!EXPECTED_SAFE.test(entry)) continue;

    const walk = (name: string, path: readonly string[], seen: ReadonlySet<string>): void => {
      if (seen.has(name)) return;
      const body = scripts[name];
      if (body === undefined) return;
      const nextSeen = new Set([...seen, name]);

      for (const h of hazardsIn(body)) {
        out.push({ script: entry, via: path, command: h.command, effect: h.effect, kind: h.kind });
      }
      // A `pre`/`post` hook runs as part of the script whether or not the
      // body mentions it, so it is part of the chain.
      for (const hook of [`pre${name}`, `post${name}`]) {
        if (defined.has(hook)) walk(hook, [...path, hook], nextSeen);
      }
      for (const child of invokedScripts(body, defined)) {
        walk(child, [...path, child], nextSeen);
      }
    };

    walk(entry, [entry], new Set());
  }

  return out;
}

/** One line a human can act on. */
export function describeHazard(h: ScriptHazard): string {
  const chain = h.via.length > 1 ? ` (via ${h.via.join(" → ")})` : "";
  return `\`${h.script}\`${chain} ${h.effect}: \`${h.command}\``;
}
