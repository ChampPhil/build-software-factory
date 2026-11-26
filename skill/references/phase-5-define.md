# Phase 5 — Define the factory

Write the factory definition and install the workflows.

1. **`factory.yaml`**: `harness: claude-code` (the only harness the factory
   runs on: it is the one whose spend the budget can stop), a model per step
   from the template, each one Anthropic has a list price for, **all auto-merge
   toggles off**, nightly gardening, review every 3 days, retry cap 3,
   concurrency 5, the budget and shares from phase 6, the sandbox posture from
   phase 2, and the repo's own test check if it has one.
2. **`policy.yaml`**: trust settings, guardrail paths **including the existing
   tool configs found in phase 1**, and per-pipeline path rules.
3. **Seven role files** from templates, with the repo name, languages and
   conventions filled in.
4. **Context files**: `feature-map.md` from the folder structure, `runbook.md`
   from phase 2, `fundamentals.md` from the dominant patterns and accepted
   context candidates, `history.md` seeded from the mined corrections.
5. **Rubrics** from templates: one per pipeline plus shared.
6. **The workflows.** One gh-aw workflow per role, compiled with
   `gh aw compile` into `.lock.yml` (install the `gh aw` extension locally if
   missing), plus the trigger workflows under `.github/workflows/factory-*.yml`,
   pinned to the runner's commit SHA with the version in a trailing comment
   (`runner@<sha> # v0.1.0`). Nothing runs on a polling timer except nightly
   gardening, the daily review check and the daily rollup sweep.
7. **Runner upgrades**: `install-factory.mjs` has already written
   `factory-runner-pin.yml` and a `.github/dependabot.yml` entry for the
   `github-actions` ecosystem, limited to the runner, with a 3-day cooldown
   (an existing `dependabot.yml` is added to without touching the other
   entries). **Check, do not retype:** both files exist, the entry is present,
   and the pin line names a real release. If the install printed that no
   release is pinned, say so in the setup summary: upgrades will not open
   themselves until the factory publishes one.
8. **Local session hooks** for Claude Code, and for any other agent CLI the
   repo's developers use, found in the repo (these only capture past sessions
   for correction mining; they run no factory step). Each hook asks its developer once, on first run on their machine,
   whether to capture their sessions, and stores the answer locally. **No
   answer means no capture.** On a public repo without the private data repo,
   install the hooks but leave capture off.
9. **Trigger sources**: note any Slack or Linear GitHub integration already
   installed; otherwise print the two-minute steps. Both are free.

## Compiling the role workflows

`gh aw compile` is the only real check that the role workflows are valid.
Run it, and fix what it rejects rather than working around it.

Things it will reject, which are easy to write by accident:

- **`outputs` under `workflow_call`.** gh-aw accepts `inputs` and `secrets`
  only. Roles exchange results as artifacts under deterministic names.
- **An expression where a literal is required**, `sandbox.agent.runtime` above
  all.
- **`allowed-files` as anything but a literal array.** It is also *exclusive*:
  every file in a patch must match it, so setting it refuses ordinary source
  files. Leave it unset; `factory/policy` is the path allowlist.
- **A tool gh-aw does not have.** The set is `bash`, `edit`, `github`, `grep`,
  `playwright`, `web-fetch`, `web-search`, and the memory and queue tools.
  There is no `read`.

One thing it will *not* catch: an unknown `engine` id validates as a catalog
name and fails later. Check the engine against the adapter list yourself.

## What to watch for

- **Every auto-merge toggle starts off.** The user turns them on from the
  dashboard when they are ready, per pipeline. Do not default any of them on
  because the repo looks well-tested.
- **Do not overwrite an existing `dependabot.yml`.** Add to it.
- **Do not turn on session capture for anyone but the setup user**, who answers
  for themselves during setup.
