// Builds the runner as a self-contained directory that setup copies into a
// user's repo at .factory/bin/.
//
// Why vendored rather than fetched: every pipeline step calls `bsf`, and a
// user's runner has to get it from somewhere. Fetching at run time ties every
// run to this repo's visibility and to the network, and makes the version a
// moving target. A committed bundle is pinned (the version is a reviewed file),
// works in private repos, needs no egress, and upgrades through factory-sync
// like the rest of the definition.
//
// Output, all of which must travel together:
//   bsf.mjs         the CLI, every dependency inlined
//   bsf             a shell launcher, so workflows can call `bsf` on PATH
//   schema/         read at run time to validate every shared file
//   vendor/gh-aw/   gh-aw's own hasher, loaded beside the bundle
//   VERSION         package version and a hash of bsf.mjs
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(runner, "..");
const out = process.argv[2] ?? join(runner, "dist-bundle");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  // Pinned so the output does not depend on where this is run from: esbuild
  // writes module paths relative to the working directory into the bundle,
  // and a build from the repo root differed from one inside runner/.
  absWorkingDir: runner,
  entryPoints: [join(runner, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: join(out, "bsf.mjs"),
  // The CJS packages inlined into an ESM bundle call require() for Node
  // built-ins; give them one. No shebang here: cli.ts carries its own and
  // esbuild keeps it on line 1, so a second one is a syntax error.
  banner: {
    js: [
      "import { createRequire as __bsfCreateRequire } from 'node:module';",
      "const require = __bsfCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
  logLevel: "warning",
});

cpSync(join(repo, "schema"), join(out, "schema"), { recursive: true });
cpSync(join(runner, "vendor", "gh-aw"), join(out, "vendor", "gh-aw"), { recursive: true });

writeFileSync(join(out, "bsf"), '#!/usr/bin/env sh\nexec node "$(dirname "$0")/bsf.mjs" "$@"\n');
chmodSync(join(out, "bsf"), 0o755);
chmodSync(join(out, "bsf.mjs"), 0o755);

// A content hash rather than a commit id, so rebuilding unchanged source gives
// byte-identical output. That is what lets CI check the committed copy in
// skill/runner/ against the source, and what lets a user's repo say exactly
// which runner it carries.
const version = JSON.parse(readFileSync(join(runner, "package.json"), "utf8")).version;
const digest = createHash("sha256").update(readFileSync(join(out, "bsf.mjs"))).digest("hex").slice(0, 12);
writeFileSync(join(out, "VERSION"), `${version} ${digest}\n`);

console.log(`bundled into ${out}`);
