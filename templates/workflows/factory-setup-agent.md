---
# Setup agent. Compiled by `gh aw compile` into factory-setup-agent.lock.yml.
#
# One design round of phase 2, called by factory-setup. It reads the repo and
# writes what setup produces — the context files and a complete candidate
# sandbox manifest — into its output directory. Nothing it writes reaches the
# repo directly: a separate job runs the candidate on the runner and measures
# the tier it reaches, and only the best measured round is frozen into the
# setup PR. The agent designs; the runner observes.
on:
  # Who may start this: decided upstream, not here. This workflow's only
  # trigger is workflow_call, so only this repo's own workflows can start it, and
  # the run that calls it starts only from someone with write access or from the
  # factory's App after intake has checked the request's author is trusted.
  # gh-aw's default role check would test the App itself — whose name differs in
  # every repo and cannot be a compile-time literal — and skip every run.
  roles: all
  workflow_call:
    inputs:
      model:
        description: The model, from factory.yaml (the builder's), read by the caller with `bsf models`
        required: true
        type: string
      budget_key:
        description: Where this step's budget hold is kept; the caller settles it with the same key
        required: false
        default: ''
        type: string
      round:
        description: Which design round this is, 1..3
        required: true
        type: number
      amend:
        description: For an amendment, the inadequacy report that asked for it, as JSON
        required: false
        default: ''
        type: string
    secrets:
      ANTHROPIC_API_KEY:
        required: true
      FACTORY_APP_PRIVATE_KEY:
        required: true

github-app:
  client-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
  private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}

engine:
  id: claude
  model: ${{ inputs.model }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    # Bounds on any one request, which is what the budget's margin is built
    # on: the 200k window instead of 1M, and Claude Code's default output cap
    # made explicit. Change one and the budget's ceilings are wrong.
    CLAUDE_CODE_DISABLE_1M_CONTEXT: "1"
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000"

permissions:
  contents: read

# It installs and builds the app while forming its hypothesis, and reads the
# documentation of what the app uses, so it reaches every common ecosystem
# and the general references the spec role does.
network:
  allowed:
    - api.anthropic.com
    - defaults
    - node
    - python
    - go
    - rust
    - ruby
    - java
    - dotnet
    - github
    - playwright
    - developer.mozilla.org
    - stackoverflow.com
    - en.wikipedia.org
    - pkg.go.dev
    - docs.rs
    - docs.python.org
    - nodejs.org
    - learn.microsoft.com

# The setup agent reads a repo it has never seen, and roles: all lets anyone
# who can start factory-setup reach it. Threat detection inspects what the
# agent produced before anything downstream acts on it: the trial and the
# setup PR wait for this whole workflow, detection included, to succeed.
safe-outputs:
  noop:
  threat-detection:
    enabled: true
    engine:
      id: claude
      model: claude-haiku-5-5
      max-turns: 3
      env:
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1"
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000"
    max-ai-credits: 50

sandbox:
  agent:
    id: awf
    mounts:
      - ${{ github.workspace }}:/workspace:rw

timeout-minutes: 60
# A ceiling per round, in gh-aw AI credits (1 credit = $0.01). Setup runs on
# the builder's model. On Opus a round on a real app (trinsports) ran past
# $10; on Sonnet it should not come near.
max-ai-credits: 1000
# gh-aw's default daily cap is 5000 credits. A computer that is skipped, or
# whose usage was never recorded, is counted at this workflow's per-run
# maximum until a usage artifact shows up. A few of those estimates, with a
# recorded spend of zero, fill 5000 and the next computer is skipped before
# it starts. Setup is several of those computers in one day. The factory's
# monthly budget is the ceiling that stops a step. This daily number is only
# high enough that zero-spend estimates do not block the rest of setup.
max-daily-ai-credits: 50000

tools:
  bash: [":*"]
  edit:
  playwright:
  web-fetch:
  web-search:

pre-agent-steps:
  # The runner that judges a change must not come from the change, so it is
  # taken from the default branch and parked outside the workspace.
  - name: Fetch the factory runner from the default branch
    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
    with:
      ref: ${{ github.event.repository.default_branch }}
      path: .factory-trusted
      sparse-checkout: |
        .factory/bin
        .factory/definition
      sparse-checkout-cone-mode: false
      persist-credentials: false
  - name: Put the trusted runner on PATH
    shell: bash
    run: |
      mkdir -p "$RUNNER_TEMP/bsf"
      cp -R .factory-trusted/.factory/bin/. "$RUNNER_TEMP/bsf/"
      mkdir -p "$RUNNER_TEMP/bsf-trusted/.factory"
      if [ -d .factory-trusted/.factory/definition ]; then cp -R .factory-trusted/.factory/definition "$RUNNER_TEMP/bsf-trusted/.factory/"; fi
      echo "BSF_TRUSTED_ROOT=$RUNNER_TEMP/bsf-trusted" >> "$GITHUB_ENV"
      rm -rf .factory-trusted
      echo "$RUNNER_TEMP/bsf" >> "$GITHUB_PATH"
      chmod +x "$RUNNER_TEMP/bsf/"*
      "$RUNNER_TEMP/bsf/bsf" --version
  # The conventions this repository already writes down for agents. The setup
  # agent reads them so that fundamentals.md does not become a paraphrase of
  # AGENTS.md: the owners maintain theirs, nobody maintains a copy, and the
  # copy is what goes stale.
  - name: Resolve the conventions this repository writes down
    shell: bash
    run: bsf repo-prose --out /tmp/gh-aw/agent/bsf/repo-prose.md
  # The budget: this step starts only if what is spent this month, what
  # running steps hold, and the most this step can cost (its credit cap plus
  # one request past it, for the agent and for threat detection) all fit.
  # A refusal fails here, before the agent spends anything.
  - name: Mint a token for the budget record
    id: budget-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: write
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Hold this step's budget
    shell: bash
    env:
      GH_TOKEN: ${{ steps.budget-token.outputs.token }}
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-setup-{2}', github.run_id, github.run_attempt, inputs.round) }}
      PIPELINE: ${{ contains(inputs.amend, 'one-journey') && 'sandbox_upkeep' || 'setup' }}
      MODEL: ${{ inputs.model }}
    run: bsf budget reserve --key "$BUDGET_KEY" --pipeline "$PIPELINE" --role setup --model "$MODEL" --cap 1000 --detection-model claude-haiku-5-5 --detection-cap 50
  - name: Make the output directory
    shell: bash
    run: mkdir -p /tmp/gh-aw/agent/bsf/setup/previous
  # Rounds after the first read what the last round designed and what the
  # trial measured. On round 1 there is nothing to fetch.
  - name: Fetch the previous round's design
    if: inputs.round > 1
    uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
    with:
      pattern: '*-round-*'
      path: /tmp/gh-aw/agent/bsf/setup/previous
  - name: Record the amendment request, if any
    shell: bash
    env:
      AMEND: ${{ inputs.amend }}
    run: |
      if [ -n "$AMEND" ]; then printf '%s\n' "$AMEND" > /tmp/gh-aw/agent/bsf/setup/amend.json; fi

post-steps:
  # What this step spent, for the caller's settle job: the agent's cost as
  # the session recorded it (or priced from its tokens at list price, if
  # higher), and the name of the threat-detection artifact, whose usage the
  # settle job prices. Runs even when the agent failed: a failed step spent
  # too, and a missing measure is charged at the ceiling.
  - name: Measure this step's cost for the budget
    if: always()
    shell: bash
    env:
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-setup-{2}', github.run_id, github.run_attempt, inputs.round) }}
      MODEL: ${{ inputs.model }}
      DETECTION_ARTIFACT: ${{ needs.activation.outputs.artifact_prefix }}detection
      PIPELINE: ${{ contains(inputs.amend, 'one-journey') && 'sandbox_upkeep' || 'setup' }}
    run: bsf budget measure --key "$BUDGET_KEY" --pipeline "$PIPELINE" --model "$MODEL" --detection-artifact "$DETECTION_ARTIFACT" --out /tmp/gh-aw/bsf-budget/measure.json
  - name: Upload the budget measure
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: budget-${{ inputs.budget_key || format('{0}-{1}-x', github.run_id, github.run_attempt) }}
      path: /tmp/gh-aw/bsf-budget/measure.json
      if-no-files-found: ignore
  - name: Keep this round's design for the trial
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: setup-round-${{ inputs.round }}
      path: /tmp/gh-aw/agent/bsf/setup/
      if-no-files-found: error
---

# Setup

You are setting up a software factory on `${{ github.repository }}`. Your job
is to work out what it takes to run this app for real, write it down so other
agents can work here, and prove it.

Everything you write goes in `/tmp/gh-aw/agent/bsf/setup/`. Nothing you write
in the repo itself is kept.

## Which computer you are

Read `/tmp/gh-aw/agent/bsf/setup/amend.json` when it exists. It says which of
the three computers you are. Do that computer's work and do not do the others.

**Computer 0** — `{"focus":"journeys"}`. Write only `context/journeys.md`.
The top things a person does in this product, not every route and not the
folder map (`feature-map.md` is a list of directories; this is not that).
One `##` heading per journey, then these two lines:

- `How a person gets there:` the path they take.
- `What proves it:` what on the screen or in the data shows it worked.

Do not boot the app. Do not write `manifest.json`, stubs, or
`guardrails.patch`. Ignore `previous/`.

**Computer B** — `{"focus":"standards"}`. Install only the factory's standard
rule pack, into the tools this repo already runs. Prove each rule on a bad
example and a good one. Fix the violations those rules already report, in
the same patch, until a count of them would be zero. Do not add rules taken
from this repo's own patterns or from past corrections. Do not write the
sandbox manifest. Ignore `previous/`.

**One new journey** — `{"focus":"one-journey", ...}`. The existing launch must
drive this one journey: seed it if the seed does not already, and add the
clicks. Add the journey to `context/journeys.md`. Do not redraw the other
journeys. If it needs a new secret or a new outside account, stop and say so
in the report. Do not install guardrails.

**Computer A** — anything else, including a journey list pasted as the amend
text (it contains `How a person gets there`). Do these in order, and do not
install guardrails:

1. Read the journey list. Do not drop or shrink a journey to make the boot pass.
2. Write one launch command that reaches a usable app from a private data
   directory, including migrations, the seed, a doctor check, and cleanup.
   `commands.seed` loads that private data on every boot. Bind the server
   to `127.0.0.1` and set `app_url` to that same host. Keep every `cd` in
   a subshell, as the launch rules below say.
3. Under each journey, add `How the sandbox tests it:` the seed user, the
   page, the click, and the side effect.
4. Boot and click every listed journey with no scratch. A missing seed
   precondition belongs in the shared seed, not in a note for one run.

Prefer a vendor's test mode (Clerk dev, Stripe test) when a test-mode secret
exists. Use a local stub only when it does not. No production keys. Cleanup
of objects this run created at a vendor is best effort: if it cannot finish,
say so and continue. The shared launch must perform every journey with no
scratch.

`previous/` may contain `seed-round-0`, `setup-round-8` and `setup-round-9`.
Those are Computer 0 and Computer B, not an earlier sandbox design. A later
design round reads `setup-round-N` and `trial-round-N` for the round before
it, and only when both exist.

## What to produce

1. **`context/feature-map.md`, `context/runbook.md`, `context/fundamentals.md`,
   `context/history.md`** — the templates for each are in
   `.factory/definition/context/`. Replace every `{{PLACEHOLDER}}` with what is
   true of this repo, from reading it. Say what you did not find rather than
   guessing; an empty table row is better than an invented one.

   **Read `/tmp/gh-aw/agent/bsf/repo-prose.md` and the files it lists before you
   write `fundamentals.md`, and do not restate them.** Where this repo already
   has an `AGENTS.md`, a `CLAUDE.md` or a contributing guide, that is its house
   style and every role reads it directly on every run. A convention copied
   into `fundamentals.md` is a second copy that the owners will not maintain,
   so it goes stale and then contradicts theirs. `fundamentals.md` is for what
   you worked out by reading the code and found written down nowhere.
2. **`manifest.json`** — the sandbox, as a complete hypothesis. Check it before
   you finish; an invalid manifest wastes the whole round:

   ```bash
   .factory/bin/bsf sandbox check --file /tmp/gh-aw/agent/bsf/setup/manifest.json
   ```
3. **`stubs/`**, if the app needs a third party you cannot reach (see below).
4. **`research-domains.txt`** — one host per line: the documentation sites of
   the frameworks and libraries this repo actually uses. The spec role reads
   them when it researches. **Not** the hosts the app loads at runtime: the
   sandbox has no egress by design, and those hosts get stubs instead (§
   "External hosts the app loads" below).
5. **`guardrails.patch`** and **`guardrails.json`** — the repo's own checkers,
   extended with the factory's rules (see "Guardrails" below). Skip both on an
   amendment.

## Read first, then hypothesize

Do not discover the app by crashing it fourteen times. Read it:

- the manifest files (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
  `Gemfile`, `*.csproj`, `pom.xml` — whatever is here) for how to install,
  build, test and run;
- the README and any docs, CI workflows, Dockerfiles, compose files and
  devcontainers, **for what the app needs installed — never for what
  production does**. A Dockerfile's `ENTRYPOINT`, a deploy script, a release
  step: those describe production. Record each one you deliberately leave out
  under `dropped`, with why;
- every place the code reads configuration — environment variables, config
  files, a settings module, a helper like `requireEnv("NAME")` — so you know
  every variable the app needs and what each one is *for*.

Then write the whole manifest at once.

## Choosing each variable's value

Read what the code does with it, and pick the kind that makes the app
genuinely work:

- **`self`** — the app's own configuration. Set it to the correct value, not a
  placeholder: the app's own origin is `http://localhost:<port>`, a domain
  allowlist is the real domain, a feature flag is what the app needs on. A
  placeholder here breaks things that are not secrets at all.
- **`service`** — something you can run: a database, a cache, object storage,
  a mail catcher. Add it under `services` (an official image, a port, throwaway
  credentials) and point the variable at `127.0.0.1:<port>`. A migration that
  runs at build time then migrates the throwaway, which is exactly what should
  happen.
- **`stub`** — a third party you cannot run. Write a small local server under
  `stubs/<name>/` that answers the requests this app actually makes with the
  shapes the real API returns (read the client code and the provider's docs),
  record it under `stubs` with where its fixture shapes came from and when.
  Where the app can be told the endpoint, point the variable at the stub and
  start it as part of `run`. Where it cannot — a client library with a fixed
  host, a driver that derives its endpoint from a connection string, an OAuth
  provider found by discovery — give the stub `hosts` (the names the app
  calls), a `port` and a `start` command: the sandbox makes those names
  resolve to this runner and serves them over HTTPS with a certificate the
  runtime trusts, forwarding to your stub. Any credential the client needs to
  sign with (a service-account key, a client secret) is one you generate for
  the stub, never the owner's. A fixed host is a reason for `hosts`, not for
  `inert`.
- **`test_mode`** — only when the provider has a real test mode and the app
  cannot be exercised otherwise. Name the secret; never write a value.
- **`inert`** — present so the app starts; any path needing it will not work
  here. Use it last, only once `service` and `stub` (with `hosts` where the
  address is fixed) are both impossible, and list what it costs under
  `capabilities.not_exercised`. Sign-in is never a reason for `inert`: see
  "Sign-in" below.

**No credential of the owner's goes in the sandbox.** Not a real database
URL, not a real API key, not a production origin. The environment is closed:
the sandbox gives the app exactly your list and nothing else, so a variable
you miss makes the app fail loudly rather than quietly reach something real.

## Every dependency, its stand-in, and its proof

A sandbox whose home page answers can still be useless: every page behind
sign-in redirects away, the database is never reached, the stubbed API is
never called. So list in `dependencies` **everything outside the app's own
code that it needs to work** — sign-in, each database or cache, email,
payments, each outside API, storage, queues — from what you read, not just
what crashed:

```json
{ "name": "Postgres", "kind": "database", "stand_in": "service",
  "probe": { "path": "/teams/varsity-soccer", "signed_in": true, "expect_text": "Roster" },
  "why": "team pages read follows and users from it" }
```

`stand_in` is how the sandbox stands in for it, simplest first: the app's own
`test_mode`; a `session` (sign-in, below); a `service` you run; a `stub`;
`inert` last. `probe` is a request to the running app that **only succeeds
when that stand-in works**: a page that reads the database, a page that calls
the stubbed API and shows what it returned. The trial sends it, follows the
app's own redirects, and passes it only when the app ends on that same path
with a 2xx (and `expect_text`, if given). Pick a probe that would fail if the
stand-in were missing. Use `null` only when no request can show it (an email
sent only by a scheduled job), and say so in `why`.

A round is not done until every probe passes. What still fails after the last
round is frozen as not exercised, with what happened, so no role is told the
sandbox can do something it cannot.

### External hosts the app loads to render

A page that front-loads a library from a CDN is one of these dependencies, and
the easiest to miss, because nothing crashes — the page just comes up empty.
The sandbox has **no egress** (`"egress": []`), so the browser's request to
that host fails, usually as `ERR_CERT_AUTHORITY_INVALID` rather than anything
that names the real problem, and every screenshot of that app for the rest of
the factory's life is a blank page.

Find them by reading the repo rather than by waiting for a trial to show it:

```bash
.factory/bin/bsf scan-asset-hosts --why
```

It prints every absolute https host the repo's own markup and styles name in a
`src=`, `href=` or `url()`, and the file each came from. Every one is a
dependency with `"stand_in": "stub"`: vendor the library if the repo already
has it, or capture it, and have the stub server rewrite those URLs to
same-origin paths. **Do not add them to `egress`.** The point of a hermetic
sandbox is that a third party being down, or rate-limiting a runner, cannot
change what the factory concludes about a change.

Give each one a `probe` that only passes when the library really loaded — a
page that renders something only that library can draw — rather than one that
passes on the shell of the page.

## Sign-in

The roles check the app in a browser that runs **inside their own sandbox**.
It reaches the app, and nothing else: an identity provider's pages
(accounts.google.com, a Clerk or Auth0 tenant, GitHub's OAuth screen) never
load there, stubbed or not. So the roles never sign in through the provider.
They are handed a session instead.

When any page needs a signed-in user, write `sign_in`: a command that prints
a session for a throwaway test user, made **the way the app's own auth makes
one**, as JSON on its last lines:

```json
{ "cookies": [{ "name": "authjs.session-token", "value": "…", "httpOnly": true, "sameSite": "Lax" }] }
```

Read the app's auth code and do exactly what it does after a successful
sign-in: insert the user and a session row into the sandbox database (a
database session), or sign a token with the sandbox's own secret (a JWT
session, using the library the app already depends on), or call a test-only
sign-in the app offers in development. Create the test user in the same
command or in `commands.seed`. The secret is the sandbox's own `self` value,
never the owner's. Put any script it runs under `stubs/sign-in/` (it lands in
`.factory/sandbox/stubs/sign-in/`) and run it from the repo root, in the
sandbox's environment, after the app is up. The runner sets each cookie's
domain; leave it out.

Then give sign-in its own dependency (`"kind": "sign_in"`, `"stand_in":
"session"`) whose probe is a page behind sign-in with `"signed_in": true`.

## Prove what you can, then claim honestly

Inside your own sandbox you can install, build and run the tests, so do — fix
the manifest until they pass. You cannot start services here; the trial does
that on the runner.

Set `tier` to what you believe the trial will reach: `renders` if the app will
start and show its main screen, `build_and_test` if it will build and test but
not start, `static` if neither. Set `app_url` to the page a person would land
on. Bind the server on `127.0.0.1` and use that same host and port in
`app_url` (`http://127.0.0.1:<port>/...`). On the runner, `localhost` is a
different socket from `127.0.0.1`, and a check of one does not reach a server
bound to the other. Any `cd` in `commands.build` or `commands.run` sits in a
subshell, `(cd dir && cmd)`, so the process that stays up still starts at the
repository root. A type-check is its own command. It is not the start of the
server command. Fill `capabilities` honestly: what verification here can exercise, and
under `not_exercised`, what it cannot and why. Write each thing you tried in
`episode`.

The trial measures the tier itself. Claiming higher than it reaches costs a
round; it does not change the result. It also runs the build and test
commands once more in an empty directory: commands that pass there too —
guarded on a file the repo does not have, or an `echo` — build and test
nothing, and the tier is `static`. When there is nothing to build or test,
say so with `static` and null commands.

## Coverage and checkers the gates run

The gates measure diff coverage and count static findings per rule per file.
They can only measure what this repo's own toolchain reports, so tell them how:

- **`commands.coverage`** with **`coverage_report`** — the tests, run so they
  also write a coverage report (`lcov`, `cobertura` or `istanbul-summary`) at
  `coverage_report.path`. The tests gate runs this instead of `commands.test`,
  so it must run the same tests. Use the coverage tool the repo's ecosystem
  already has; where its native format is another one, add the step that
  converts it. Leave both out when the repo has no tests.
- **`static_checks`** — for a language with a checker the repo uses (or a
  compiler's own warnings) that the factory does not run itself, each entry
  is `{ "name", "command", "sarif", "why" }`: a command that runs the checker
  over the repo and writes SARIF at `sarif`. A finding is usually a non-zero
  exit; the SARIF is what is counted. Skip a checker the repo does not use.

The trial runs each one after the tests. One that writes no report, or no
SARIF, is dropped from the frozen sandbox and recorded under `dropped` with
what happened, so the gates never fail every PR on a check that cannot run.

## What the setup PR shows

The person reviewing setup sees proof and diagrams first, then the key things
to focus on, then links to the long version. Write
`/tmp/gh-aw/agent/bsf/setup/report/report.json` (`schema/pr-report.json` in
`.factory/bin/runner.tgz` has the shape) and the files it names, under
`report/`:

- `summary`: three lines — what the factory will be able to do on this repo,
  what it cannot yet, and the one thing the reviewer should decide.
- `blocks`: Mermaid diagrams of the sandbox (the app, its services, the stubs
  standing in for third parties, what reaches the network) and of how a change
  will be checked here, mixed with any screenshots or logs you captured
  (`report/files/`). The trial's screenshot of the app running is added first
  by the factory; do not add your own copy of it.
- `focus`: what a reviewer must look at — a stub that fakes something real, a
  capability that is not exercised, a checker that was left out.
- `technical`: `report/technical.md`, the sandbox and checks in detail.
- `conceptual`: `report/conceptual.md`, what this setup means for how the
  factory will work on this repo.

An amendment writes the same report, about what it changed and why.

## Guardrails

`.factory/rules/<language>.yaml` holds the factory's rules for each language:
what each one guards against, the tool and config that enforce it, and a `bad`
and a `good` example. Install the ones that fit **into the tools this repo
already runs** — extend its eslint config, its ruff section in
`pyproject.toml`, its `.rubocop.yml`. Never add a second linter beside an
existing one, and do not add a tool the repo does not use.

**Every rule you install must fail on its `bad` example and pass on its
`good` one, with this repo's own config.** Write each example to a scratch
file inside the repo's source tree (so its config applies), run the tool on
it, and delete the file. A rule that fires on both would block correct code;
one that fires on neither is decoration. Leave either out and say why.

Change only checker configuration (and, if the tool has one, its native
baseline file). Do not fix any existing violation: the runner baselines them
per file after you, and gardening clears them in small reviewed PRs. Never
touch `.github/` or `.factory/`.

Write the result as a patch from the repo root, and what you decided:

```bash
git diff > /tmp/gh-aw/agent/bsf/setup/guardrails.patch
```

`guardrails.json`: `{ "installed": [{ "rule", "tool", "file" }], "skipped": [{ "rule", "why" }] }`.

## If this is not the first round

`previous/` holds the last round's design (`setup-round-1`, `setup-round-2`)
and what the trial measured (`trial-round-*/trial.json`): each step's command,
whether it passed, and the last lines of its output, then `sign_in` and each
dependency's probe in `probes`, with what the app did. Read the failing step's
output or probe's detail, change the smallest thing that explains it, and
write the whole manifest again. Ignore `seed-round-0`, `setup-round-8` and
`setup-round-9`: those are the journey list and the standard rules, not a
sandbox design.

## If this is an amendment

`amend.json` holds `reports`: one or more reports from roles that could not
exercise what a change needed. Several may describe the same shortfall in
different words; treat them as one need. Start from the current
`.factory/sandbox/manifest.json` and extend it to cover what the reports ask
for. Keep everything that already works: its stand-ins, its `sign_in`, and
every probe that passes today.

Find the cause, not the symptom. A role that could not reach a provider's
sign-in page needs a `sign_in` session, not a better stub of the provider. A
role that could not start the app needs the run command fixed, not
instructions to start it differently. Add a dependency and probe for what was
missing, so the trial proves the repair.

An amendment merges itself, with no person, when it changes only the sandbox,
adds no host to `egress` and no secret to `env`, and its trial proves at least
what the current sandbox does. Stay inside that whenever you can; if the
repair truly needs a new host or a provider's test-mode secret, it waits for
a person, so say in the report exactly what they must add and why.
