# Changelog

Dates are the day the work landed on `main`. Each release lists the schema
versions the runner reads and writes, because that changelog is what a user
sees in their upgrade pull request.

## Unreleased

Schemas: reads `*/1`, writes `*/1`.

### Added

- `bsf doctor` — what is wrong with an installed factory, changing nothing.
  The diagnosis the setup skill's repair mode does before it touches anything.
- `bsf contribute-corrections` — a teammate adds the corrections from their own
  machine. Two steps on purpose: the first writes a file and submits nothing,
  so they can read and prune what would be shared before it goes.
- `bsf consistency` — cross-artifact checks: environment variables against
  `.env.example` in both directions, README commands against the manifest's
  scripts, declared dependencies against the lockfile.
- `bsf migrate` and `bsf schema-surface` — the schema freeze. An additive
  change passes; a breaking one fails and asks for a major bump with a
  migration.
- `bsf dashboard` — serves the dashboard from your own machine, loopback only.
- Data-flow rules (Semgrep taint) in the TypeScript and Python packs.
- Rust, C#, Ruby and polyglot-monorepo fixtures; Rust, C# and Ruby rule packs.
- Human interactions per PR, on the dashboard and in the rollup.
- The Improvement page: review results, scorer pass rates, and cost against
  quality for every configuration benchmarked.
- The repository's own CI: typecheck, lint, tests, the schema surface, and the
  gates run for real against the fixtures.

### Fixed

- Every GitHub API request with a body was sending an empty one.
  `promisify(execFile)` ignores an `input` option, so `gh api --input -` waited
  on a stdin nobody wrote. `reportCheck`, which is how every gate tells GitHub
  its verdict, had never worked.
- A baseline entry was read as a per-file map in two places, so the gardener
  filed items asking an agent to clean files called `count` and `by_file`, and
  never skipped a retired rule.
- The merge queue had its own review mapper writing the wrong field names,
  which silently disabled the stale-approval check where merging is decided.
- Three bare `require()` calls in ESM modules, each of which threw only on the
  code path that reached it.
