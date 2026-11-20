# Contributing

Two things are most likely to be worth adding: a **rule pack** for a language
the factory does not cover, and a **harness adapter** for an agent CLI it does
not run. Both are data plus a small amount of code, and both have a bar that
is checked mechanically.

## Adding a rule pack

A rule pack is `rules/<language>.yaml`: the universal rules for one language,
each mapped onto a tool the repository already runs.

**The bar: every rule carries the two examples that prove it discriminates.**
A rule has a `bad` example it must fire on and a `good` example it must not.
Setup installs a rule only once it has failed on the first and passed on the
second, against the real tool. This is not ceremony — three of the rules
written for this project did not fire at all, and the examples are what caught
it:

- a clippy rule matched against `--message-format=short`, which prints messages
  and not lint names, so the check silently passed everything;
- a javac deprecation rule used a deprecated API *in the same outer class*,
  where javac suppresses the warning;
- a Semgrep taint rule whose good example dropped the dangerous call
  altogether would have passed while being indistinguishable from a ban.

That last one is the general trap. **A data-flow rule's good example must still
call the sink.** If the safe version simply does not call `exec`, the rule has
not been shown to be about the data path.

```yaml
- id: no-explicit-any
  concern: >-
    `any` switches off the type checker for everything it touches, so a type
    error becomes a runtime error somewhere else.
  tool: eslint
  config:
    "@typescript-eslint/no-explicit-any": error
  bad: |
    export function parse(input: any): string { return String(input); }
  good: |
    export function parse(input: unknown): string { return String(input); }
```

1. Write the pack. `concern` says what goes wrong, not what the rule is called.
2. `node runner/dist/cli.js validate rulepack rules/<language>.yaml`
3. Add a runner in `runner/src/commands/rulepack.ts` if the tool has none, and
   a block in `runner/test/rulepack.test.ts` that runs every rule through it.
4. Run the tests with the tool installed. If you cannot install it, mark the
   pack `verification: documented_not_run` and say so — a pack that nobody has
   run, presented as if it had been, is worse than an honest gap.

## Adding a harness adapter

An adapter is a gh-aw **engine definition** (`adapters/<harness>.yaml`), not a
wrapper script: gh-aw installs the CLI, runs it, and parses its log into the
unified session artifact, keeping its own retry, timeout and tool-policy
behaviour.

The definition needs `installation`, `execution`, `capabilities`,
`network.provider-domains` and a `log-parser`. `adapters/README.md` has the
shape and the two that exist as examples.

**The bar: the log parser produces a session the cost accounting can read.**
A harness whose tokens are not read ends up with an unknown cost, and the
factory writes `cost_source: unknown` rather than zero — a fabricated zero
quietly raises the ceiling on what the factory may spend.

## Changing a schema

`schema/SURFACE.json` holds the shape of every schema at the frozen major, and
`npm run schema-check` compares the live schemas against it.

- An **additive** change — a new optional field — keeps the major. Re-freeze
  with `node runner/dist/cli.js schema-surface --freeze` in the same commit.
- A **breaking** change — a field removed, an optional one becoming required,
  a type or pattern changed — fails the check. Bump the major, write the
  migration in `runner/src/commands/migrate.ts`, and re-freeze.
- An **enum member added** is reported separately as widening, because a
  reader on the frozen major rejects a value it does not know. It is allowed,
  but it is not free.

## The bar for a change

- **Tests decide the same question the code does.** A test that passes because
  the fixture was shaped to let it is worse than no test; one of this
  project's own test fixtures hid a real bug for weeks that way.
- **An absent measurement is not zero.** Unknown cost, unmeasured coverage, an
  empty window — each is reported as unknown. This comes up constantly and it
  is the single rule most worth internalising here.
- **`npm test`, `npm run lint`, `npm run typecheck` and `npm run schema-check`
  all pass.** CI runs them, plus the gate and rule-pack tests against the real
  fixtures with the real tools, and fails if any of those skipped.
- **Comments say why, not what.** The ones worth writing are the ones that
  stop the next person from "simplifying" a decision back into a bug.

## Running it

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run schema-check
```

The fixtures in `/fixtures` are not installed by `npm ci`; the gate tests that
need them skip unless you install them yourself:

```bash
npm ci --prefix fixtures/ts-webapp
npm ci --prefix fixtures/js-legacy
```
