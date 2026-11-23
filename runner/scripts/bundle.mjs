// Builds the runner as a self-contained directory that setup copies into a
// user's repo at .factory/bin/.
//
// Why vendored rather than fetched: every pipeline step calls `bsf`, and a
// user's runner has to get it from somewhere. Fetching at run time ties every
// run to this repo's visibility and to the network, and makes the version a
// moving target. A committed bundle is pinned (the version is a reviewed file),
// works in private repos, needs no egress at run time, and upgrades through
// factory-sync like the rest of the definition.
//
// Why packed: the first install on a real repo broke that repo's own CI. Its
// `eslint .` linted the vendored JavaScript. Every ecosystem's linter,
// formatter and type checker walks the tree differently, so asking each repo
// to ignore a directory cannot work across many repos. Nothing in any
// ecosystem reads inside a .tgz, so the runner ships as one:
//
//   bsf          a POSIX shell launcher (no extension, no language tooling
//                claims it) that unpacks once, beside itself or in a temp dir
//   bsf.cmd      the same launcher for Windows. Setup runs from the user's own
//                machine, which is as often Windows as not, and a `sh` script
//                there runs as nothing at all and exits 0 — so every local
//                `bsf` command looked like it had succeeded and printed
//                nothing. Both launchers ship, always, on every platform:
//                which one a repo needs is not known when the bundle is built.
//   runner.tgz   bsf.mjs + schema/ + vendor/gh-aw/, packed deterministically
//   VERSION      package version and a hash of runner.tgz
//
// Pass --unpacked to get the plain directory instead, for tests.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(runner, "..");
const args = process.argv.slice(2);
const unpacked = args.includes("--unpacked");
const out = args.find((a) => !a.startsWith("--")) ?? join(runner, "dist-bundle");

// Built into a staging directory; packed into `out` unless --unpacked.
const stage = unpacked ? out : mkdtempSync(join(tmpdir(), "bsf-stage-"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(stage, { recursive: true });

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
  outfile: join(stage, "bsf.mjs"),
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

cpSync(join(repo, "schema"), join(stage, "schema"), { recursive: true });
cpSync(join(runner, "vendor", "gh-aw"), join(stage, "vendor", "gh-aw"), { recursive: true });
chmodSync(join(stage, "bsf.mjs"), 0o755);

const version = JSON.parse(readFileSync(join(runner, "package.json"), "utf8")).version;

if (unpacked) {
  writeFileSync(join(out, "bsf"), '#!/usr/bin/env sh\nexec node "$(dirname "$0")/bsf.mjs" "$@"\n');
  chmodSync(join(out, "bsf"), 0o755);
  writeFileSync(join(out, "bsf.cmd"), ["@echo off", 'node "%~dp0bsf.mjs" %*', "exit /b %errorlevel%", ""].join("\r\n"));
  const digest = createHash("sha256").update(readFileSync(join(out, "bsf.mjs"))).digest("hex").slice(0, 12);
  writeFileSync(join(out, "VERSION"), `${version} ${digest}\n`);
  console.log(`bundled (unpacked) into ${out}`);
  process.exit(0);
}

// Deterministic: sorted names, fixed mtime and owner, and gzip without a
// timestamp, so unchanged source gives byte-identical output.
const tarball = join(out, "runner.tgz");
const tar = execFileSync(
  "tar",
  ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "--format=gnu", "-C", stage, "-cf", "-", "bsf.mjs", "schema", "vendor"],
  { maxBuffer: 64 * 1024 * 1024 },
);
writeFileSync(tarball, execFileSync("gzip", ["-n", "-9"], { input: tar, maxBuffer: 64 * 1024 * 1024 }));
rmSync(stage, { recursive: true, force: true });

const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex").slice(0, 12);
writeFileSync(join(out, "VERSION"), `${version} ${digest}\n`);

// Unpacks once per version into the temp dir — never beside itself, which
// would put the runner's JavaScript back into the user's working tree where
// their tools would find it.
//
// Lock-free and portable. Each caller extracts into a private directory;
// `mkdir` is atomic everywhere, so exactly one caller wins the shared
// directory and moves bsf.mjs in last, which makes its presence mean the rest
// is there. A caller that loses runs from its own private copy. (An earlier
// `mv tmp dir` nested the loser's copy inside the winner's whenever two jobs
// started together, and `mv -T` does not exist on macOS.)
writeFileSync(
  join(out, "bsf"),
  [
    "#!/usr/bin/env sh",
    "# Build Software Factory runner launcher. The runner itself is in runner.tgz,",
    "# packed so that no linter, formatter or type checker in this repo reads it.",
    "set -eu",
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'base="${TMPDIR:-/tmp}"',
    `dir="$base/bsf-${digest}"`,
    'if [ ! -f "$dir/bsf.mjs" ]; then',
    '  tmp=$(mktemp -d "$base/bsf-unpack.XXXXXX")',
    '  tar -xzf "$here/runner.tgz" -C "$tmp"',
    '  if mkdir "$dir" 2>/dev/null; then',
    '    mv "$tmp/schema" "$tmp/vendor" "$dir/"',
    '    mv "$tmp/bsf.mjs" "$dir/bsf.mjs"',
    '    rmdir "$tmp"',
    '  else',
    '    exec node "$tmp/bsf.mjs" "$@"',
    '  fi',
    "fi",
    'exec node "$dir/bsf.mjs" "$@"',
    "",
  ].join("\n"),
);
chmodSync(join(out, "bsf"), 0o755);

// The same launcher for `cmd`, which is what PowerShell runs a .cmd through.
// Batch has no `mktemp` and no reliable `&&` inside a parenthesised block, so
// the same win-or-lose-the-race logic is written with labels: `mkdir` is
// atomic on Windows too, so exactly one caller wins the shared directory and
// moves bsf.mjs in last. CRLF endings, because `cmd` mis-parses LF-only files
// whose lines end mid-token. `tar` is Windows 10 1803+ and is checked for,
// because the failure without it is otherwise a silent empty directory.
writeFileSync(
  join(out, "bsf.cmd"),
  [
    "@echo off",
    "setlocal enableextensions",
    'set "HERE=%~dp0"',
    'if not defined TMPDIR set "TMPDIR=%TEMP%"',
    `set "CACHE=%TMPDIR%\\bsf-${digest}"`,
    'if exist "%CACHE%\\bsf.mjs" goto run',
    'set "STAGE=%TMPDIR%\\bsf-unpack.%RANDOM%%RANDOM%"',
    'mkdir "%STAGE%" >nul 2>&1',
    'tar -xzf "%HERE%runner.tgz" -C "%STAGE%"',
    "if errorlevel 1 goto tarfail",
    'mkdir "%CACHE%" >nul 2>&1',
    "if errorlevel 1 goto loser",
    'move /y "%STAGE%\\schema" "%CACHE%\\" >nul',
    'move /y "%STAGE%\\vendor" "%CACHE%\\" >nul',
    'move /y "%STAGE%\\bsf.mjs" "%CACHE%\\bsf.mjs" >nul',
    'rmdir "%STAGE%" >nul 2>&1',
    "goto run",
    ":loser",
    'node "%STAGE%\\bsf.mjs" %*',
    "exit /b %errorlevel%",
    ":tarfail",
    "echo bsf: could not unpack runner.tgz. It needs tar, which Windows has shipped since 10 1803. 1>&2",
    "exit /b 1",
    ":run",
    'node "%CACHE%\\bsf.mjs" %*',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n"),
);
console.log(`bundled into ${out}`);
