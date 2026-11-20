import { describe, it, expect } from "vitest";
import { scriptHazards, invokedScripts, describeHazard } from "../src/lib/script_hazards.js";

describe("scriptHazards", () => {
  it("finds a migration chained into build — the case this exists for", () => {
    // Taken verbatim from a real repository's package.json.
    const found = scriptHazards({
      build: "npm run db:migrate && next build",
      "db:migrate": "drizzle-kit migrate",
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.script).toBe("build");
    expect(found[0]?.via).toEqual(["build", "db:migrate"]);
    expect(found[0]?.kind).toBe("migration");
    expect(describeHazard(found[0]!)).toContain("via build → db:migrate");
  });

  it("finds a hazard written inline, with no chain", () => {
    const found = scriptHazards({ build: "prisma migrate deploy && tsc" });
    expect(found).toHaveLength(1);
    expect(found[0]?.via).toEqual(["build"]);
    expect(found[0]?.command).toBe("prisma migrate deploy");
  });

  it("leaves a hazard alone when the script's own name declares it", () => {
    // `deploy` deploying is that script doing its job, not a finding. The
    // check is about commands whose names promise they are safe to re-run.
    expect(scriptHazards({ deploy: "vercel deploy --prod" })).toEqual([]);
    expect(scriptHazards({ "db:migrate": "drizzle-kit migrate" })).toEqual([]);
    expect(scriptHazards({ release: "npm publish" })).toEqual([]);
  });

  it("does not flag the pure-codegen subcommands of the same tools", () => {
    // The distinction that keeps this check usable: every repo using an ORM
    // runs `generate`, and almost none of them should be flagged for it.
    expect(scriptHazards({ build: "prisma generate && next build" })).toEqual([]);
    expect(scriptHazards({ build: "drizzle-kit generate && tsc" })).toEqual([]);
    expect(scriptHazards({ test: "knex migrate:make foo" })).toEqual([]);
  });

  it("follows pre and post hooks, which run whether or not the body says so", () => {
    const found = scriptHazards({
      prebuild: "drizzle-kit migrate",
      build: "next build",
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.via).toEqual(["build", "prebuild"]);
  });

  it("follows run-s and the bare yarn form", () => {
    expect(scriptHazards({ ci: "run-s lint migrate-db", "migrate-db": "alembic upgrade head", lint: "eslint ." }))
      .toHaveLength(1);
    expect(scriptHazards({ verify: "yarn seed", seed: "rails db:migrate" })).toHaveLength(1);
  });

  it("terminates on a manifest whose scripts reference each other in a cycle", () => {
    // Broken input, but a check that blows the stack reports nothing about
    // the input it could have read.
    const found = scriptHazards({
      build: "npm run test",
      test: "npm run build && terraform apply",
    });
    // Reported once per entry point, not once per path to the hazard: the
    // runbook might record either `build` or `test`, and each is a separate
    // thing for a reader to decide about.
    expect(found.map((h) => h.script).sort()).toEqual(["build", "test"]);
    expect(new Set(found.map((h) => h.kind))).toEqual(new Set(["infra"]));
  });

  it("reports nothing for an ordinary manifest", () => {
    expect(
      scriptHazards({
        build: "next build",
        test: "vitest run",
        lint: "eslint .",
        start: "next start",
        "db:generate": "drizzle-kit generate",
      }),
    ).toEqual([]);
  });

  it("covers each hazard family", () => {
    const kinds = new Set(
      [
        "drizzle-kit push",
        "wrangler deploy",
        "npm publish",
        "terraform apply",
      ].flatMap((cmd) => scriptHazards({ build: cmd }).map((h) => h.kind)),
    );
    expect([...kinds].sort()).toEqual(["deploy", "infra", "migration", "publish"]);
  });
});

describe("invokedScripts", () => {
  it("only counts names the manifest actually defines", () => {
    // Without that guard, `yarn install` reads as a script named install and
    // `npm run build` inside a comment invents a dependency.
    expect(invokedScripts("yarn install && yarn seed", new Set(["seed"]))).toEqual(["seed"]);
    expect(invokedScripts("npm run nope", new Set([]))).toEqual([]);
  });

  it("does not expand globs it cannot resolve", () => {
    expect(invokedScripts("run-s test:*", new Set(["test:unit"]))).toEqual([]);
  });
});
