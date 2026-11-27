# Guardrails

Static rules check code without running it. They are the garden's fence: a change that breaks one does not merge. Setup installs them; this is what they are.

## Kinds of static rules

Static rules check code without running it. There are 12 base kinds, from shallowest to deepest; every higher-level rule is built from them.

1. **Text and regex** → patterns in raw text, no understanding of the code.
2. **Structured-data schema** → config files (JSON, YAML, TOML) checked against a schema.
3. **Syntax tree (AST)** → patterns in the parsed structure of the code.
4. **Canonical form** → does the code match its formatted version?
5. **Type analysis** → what every symbol and expression actually is.
6. **Dependency graph** → which modules import which: cycles, layers, forbidden edges.
7. **Call graph** → which functions call which: dead code, reachability.
8. **Control flow** → the possible execution paths inside a function.
9. **Data flow and taint** → where values travel, from where they come in to where they're used.
10. **Clone detection** → duplicated code.
11. **Cross-artifact consistency** → two artifacts that must agree (API spec vs handlers, migrations vs models).
12. **Formal verification** → properties proven mathematically.

The twelve kinds are a taxonomy, not a launch list: the rule packs ship text and regex, structured-data schema, syntax tree, canonical form, types and dependency graph in v0.1; call graph, control flow and clone detection in v0.2; data flow and cross-artifact consistency in v1.0. Formal verification is only ever targeted ([Verification](Verification.md)).

The last two arrived in v1.0 and are worth distinguishing, because they are the two a conventional linter cannot do.

**Data flow** asks where a value came from, not what a line says. `execSync(command)` is not a problem; `execSync(command)` where `command` was built from `req.query` is. The rule packs carry these as Semgrep taint rules — sources and sinks — and each one's good example *still calls the sink*, so the rule is demonstrably about the path and not a ban on a useful function. A ban would be easier to write and worse: it would forbid the safe call too.

**Cross-artifact consistency** compares two artifacts that are supposed to agree, where each is individually fine. `bsf consistency` checks environment variables the code reads against `.env.example` in both directions, commands the README tells people to run against the manifest's scripts, and declared dependencies against the lockfile — plus the commonest case of all, a repo that reads a dozen variables and has no example file at all, reported once rather than once per variable. It also checks the runbook against what the runbook's own commands do: if the runbook tells the factory to run a script whose chain applies migrations, deploys, publishes or changes infrastructure, and the runbook does not say so, that is a finding. Phase 2 promises the runbook classifies commands by whether they touch persistent state; this is what holds it to the promise, because a build command that migrates a database is safe for the developer who wrote it and not safe for an agent running it unattended a few hundred times. Every finding names both files, because a mismatch is never a fault in one of them alone and the fix depends on which one is right. It reports and does not fail: deciding which artifact is wrong is a person's job.

Higher-level rules are combinations of the base kinds:

| Higher-level rule | Built from |
| --- | --- |
| Filesystem layout | File paths + dependency graph |
| Banned APIs | AST (+ types) |
| Dead code | Dependency graph + call graph |
| Complexity limits | Control flow |
| Secrets | Text and regex |
| Dependency allowlist | Structured-data schema |
| Contract drift | Cross-artifact consistency |

Two rules about the rules:

- **Suppression control** → every disable comment needs a written reason; suppressions are counted and capped.
- **Ratchets** → a rule's count of existing violations can only go down, never up, counted per file so a fix in one place can't pay for a new violation in another.
