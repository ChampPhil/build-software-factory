---
# Hardener role. Compiled by `gh aw compile` into factory-role-hardener.lock.yml.
# A workflow_call reusable workflow called as a job by factory-run (spike §3).
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
        description: This role's model, from factory.yaml, read by the caller with `bsf models`
        required: true
        type: string
      budget_key:
        description: Where this step's budget hold is kept; the caller settles it with the same key
        required: false
        default: ''
        type: string
      work_item:
        required: true
        type: string
      pipeline:
        required: false
        default: hardening
        type: string
      attempt:
        required: false
        default: 1
        type: number
      protected_files_policy:
        required: false
        default: request-review
        type: string
      staged:
        required: false
        default: false
        type: boolean
    secrets:
      ANTHROPIC_API_KEY:
        required: true
      FACTORY_APP_PRIVATE_KEY:
        required: true
      FACTORY_SANDBOX_ENV:
        required: false

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
  pull-requests: read
  issues: read

network:
  # Every common package ecosystem, so the app's dependencies install in any
  # repo. Extra hosts a sandbox manifest needs are added by a recompile at setup.
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
    - playwright

sandbox:
  agent:
    id: awf
    mounts:
      - ${{ github.workspace }}:/workspace:rw

timeout-minutes: 45
# A ceiling per run, in gh-aw AI credits (1 credit = $0.01). A normal run is
# well under it; it stops a runaway before it costs a week's budget.
max-ai-credits: 300

tools:
  bash: [":*"]
  edit:

safe-outputs:
  create-pull-request:
    draft: true
    branch-prefix: factory/
    title-prefix: "[factory] "
    labels: [factory:hardening]
    # Hardening is the one pipeline that legitimately writes under .factory/.
    # gh-aw protects every top-level dot-folder by default, so without the
    # caller's exclusion every hardening PR would arrive carrying an automatic
    # REQUEST_CHANGES review (spike §6).
    protected-files:
      policy: ${{ inputs.protected_files_policy }}
    staged: ${{ inputs.staged }}
  add-comment:
    # A role is dispatched, not triggered by an issue, so there is no
    # triggering item to default to: the agent names the issue or PR.
    target: "*"
    staged: ${{ inputs.staged }}
  # No upload-artifact safe output here: with create-pull-request beside it,
  # gh-aw 1.2 and 1.3 put the PR checkout ahead of the App token it reads, and
  # the PR never opened. Media goes through bsf store-media instead.
  threat-detection:
    enabled: true
    # The scan for injected or malicious output reads one diff and one
    # transcript: a small model does it, not the role's own.
    engine:
      id: claude
      model: claude-haiku-5-5
      max-turns: 3
      env:
        CLAUDE_CODE_DISABLE_1M_CONTEXT: "1"
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000"
    max-ai-credits: 50

pre-agent-steps:
  # The runner that judges a change must not come from the change. A pull
  # request, a merge-group commit or an agent's workspace can all modify
  # .factory/bin, so it is taken from the default branch and parked outside the
  # workspace, which is the only directory the agent sandbox can write to.
  - name: Fetch the factory runner from the default branch
    uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
    with:
      ref: ${{ github.event.repository.default_branch }}
      path: .factory-trusted
      sparse-checkout: |
        .factory/bin
        .factory/definition
        .factory/sandbox
      sparse-checkout-cone-mode: false
      persist-credentials: false
  - name: Put the trusted runner on PATH
    shell: bash
    run: |
      mkdir -p "$RUNNER_TEMP/bsf"
      cp -R .factory-trusted/.factory/bin/. "$RUNNER_TEMP/bsf/"
      # The definition and the sandbox decide how a change is judged, so
      # bsf reads them from this copy, never from the checkout.
      mkdir -p "$RUNNER_TEMP/bsf-trusted/.factory"
      for d in definition sandbox; do
        if [ -d ".factory-trusted/.factory/$d" ]; then cp -R ".factory-trusted/.factory/$d" "$RUNNER_TEMP/bsf-trusted/.factory/"; fi
      done
      echo "BSF_TRUSTED_ROOT=$RUNNER_TEMP/bsf-trusted" >> "$GITHUB_ENV"
      rm -rf .factory-trusted
      echo "$RUNNER_TEMP/bsf" >> "$GITHUB_PATH"
      chmod +x "$RUNNER_TEMP/bsf/"*
      "$RUNNER_TEMP/bsf/bsf" --version
  # The conventions this repository writes down for agents: AGENTS.md,
  # CLAUDE.md, .claude/skills/ and anything policy.yaml declares. Resolved on
  # every run rather than recorded at setup, so a file the owners added today
  # is read today. Listed, not inlined — the role reads the ones it needs, so
  # a long file costs that role rather than every role.
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
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-hardener-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
      PIPELINE: ${{ inputs.pipeline }}
      MODEL: ${{ inputs.model }}
    run: bsf budget reserve --key "$BUDGET_KEY" --pipeline "$PIPELINE" --role hardener --model "$MODEL" --cap 300 --detection-model claude-haiku-5-5 --detection-cap 50
  # Read-only, for the steps that fetch this item's data before the agent
  # starts. Minted here rather than handed to the agent: step outputs never
  # reach the agent's sandbox.
  - name: Mint a read-only token for the factory's data
    id: read-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: read
      permission-actions: read
      # Scoped to this repository: an App token otherwise reaches every repo
      # the installation covers.
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  # The frozen sandbox, as the manifest on the default branch declares it:
  # its services, its closed environment, its install. It used to be a script
  # run from the workspace, which on a retry is the PR branch — code from the
  # change under judgement, running before the agent did.
  - name: Start the sandbox
    shell: bash
    env:
      FACTORY_SANDBOX_ENV: ${{ secrets.FACTORY_SANDBOX_ENV }}
    run: bsf sandbox start
  - name: Fetch the correction or failure, the candidates and the ledger
    shell: bash
    env:
      GH_TOKEN: ${{ steps.read-token.outputs.token }}
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf harden-context "$WORK_ITEM" --out /tmp/gh-aw/agent/bsf/harden.json

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
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-hardener-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
      MODEL: ${{ inputs.model }}
      DETECTION_ARTIFACT: ${{ needs.activation.outputs.artifact_prefix }}detection
      PIPELINE: ${{ inputs.pipeline }}
    run: bsf budget measure --key "$BUDGET_KEY" --pipeline "$PIPELINE" --model "$MODEL" --detection-artifact "$DETECTION_ARTIFACT" --out /tmp/gh-aw/bsf-budget/measure.json
  - name: Upload the budget measure
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: budget-${{ inputs.budget_key || format('{0}-{1}-x', github.run_id, github.run_attempt) }}
      path: /tmp/gh-aw/bsf-budget/measure.json
      if-no-files-found: ignore
  # Write access, only after the agent has exited, for the steps that store
  # what it produced on the factory's data ref.
  - name: Mint a token to store this step's results
    id: write-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-contents: write
      permission-actions: read
      # Scoped to this repository: an App token otherwise reaches every repo
      # the installation covers.
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Write the StepReport with memex
    shell: bash
    env:
      GH_TOKEN: ${{ steps.write-token.outputs.token }}
      ROLE: hardener
      ATTEMPT: ${{ inputs.attempt }}
      MODEL: ${{ inputs.model }}
    run: bsf step-report --role "$ROLE" --attempt "$ATTEMPT" --model "$MODEL" --out /tmp/gh-aw/agent/bsf/step-report.json
  # The run record is made from these: model, tokens and cost for each role.
  - name: Upload the StepReport
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: step-report-hardener
      path: /tmp/gh-aw/agent/bsf/step-report.json
      if-no-files-found: ignore
---

# Hardener

You are the hardener for `${{ github.repository }}`. Someone corrected the
factory (a review comment, a change request, a fix they pushed to a branch, or
something they said to an agent in a local session), or the scheduled review
routed a failure to you. Your job is to make that
whole *class* of mistake impossible, not to fix the one instance.

## The factory's own rules

Read these before anything else, and keep to them:

- `/tmp/gh-aw/agent/bsf/repo-prose.md` — the conventions **this repository** writes
  down for agents, and where they are. Read the files it lists first: they are the
  owners' own statement of how work here is done, they are kept current, and
  everything below supplements them rather than replacing them.
- `.factory/definition/context/practices.md` — practices the owners stated to
  the factory, for what has no home in the codebase
- `.factory/definition/policy.yaml` — what this pipeline may change, and what is protected
- `.factory/guardrails/` — the static rules every change is gated on


`/tmp/gh-aw/agent/bsf/harden.json` has the correction or failure, the existing
`candidates.json`, and the ledger. Read `fundamentals.md` and `history.md`.

If the input file has `standing_goals`, a person has asked the factory to focus
somewhere for a while ("harden auth this month"). Use them to decide what to
generalize first when a correction could be read several ways. They never
relax a rule or widen what you may change.

## 1. Generalize

Turn the instance into a problem class. "This PR called `fetch` directly in
`src/export`" becomes "network calls bypass `apiClient`". State it in one line.

**Check for an existing rule or candidate first.** If one already covers this,
the answer is not a new rule — it is that the existing one does not catch this
case, or it exists and was not run.

## 2. Choose how the codebase changes

Every correction ends as a change to the codebase, in this PR. There are four
ways to do it. The first three are equal: none is a fallback for another, and
you are not working down a list. Pick the one that most reliably stops this
class of mistake coming back, and say in the PR why you picked it over the
others.

- **A new static rule.** A script tells right from wrong without running the
  code. Prefer extending a tool the repo already runs over adding a new one.
- **A stronger verification requirement.** Running the code checks it: a
  required test, a verification scenario added to the runbook, a higher
  coverage floor, a tighter baseline.
- **A refactor that eliminates the class of problem.** The code changes so the
  mistake cannot be written: an API that cannot be misused, a type that
  forbids the bad shape, one module that owns the thing people kept
  getting wrong. When this is the best answer, choose it. Do not drop to a rule
  because a rule is smaller.

A correction about product intent, UX taste or where things live is usually not
an exception. Encode it the same way where you can: a test that fails when the
intent is broken, a type or API that makes the wrong shape impossible, a rule
on where the code may live.

### The fourth: write the practice down

Some corrections have no mechanical home. Vernacular ("we say *members*, not
*users*"), register, what this product refuses to do, which of two acceptable
patterns this team prefers. A rule for one of those is either unwriteable or
so crude it fires on everything, and pretending otherwise produces a rule
somebody disables within the week.

For those, write it into the conventions **this repository already keeps for
agents** — the files `/tmp/gh-aw/agent/bsf/repo-prose.md` lists. Every role
reads them on every run, so a line there reaches all of this factory's work
and the repo's own contributors too.

This lever is not equal to the other three, for one reason: **it cannot prove
itself.** A rule fails on the bad example and passes on the good one. A test
goes red, then green. A refactor makes the wrong shape impossible to write.
A paragraph does none of that — nothing can be run against it, and a reviewer
has only your word that it was worth adding to every future run's context. So
it comes with three conditions, and the gates enforce all three:

1. **Say why the other three cannot carry it.** Name the rule you would have
   written and what it would have fired on wrongly, or the test you would have
   written and why it cannot tell right from wrong here. "It is about taste" is
   not a reason by itself; most taste can be encoded.
2. **Show at least two instances.** Under a heading `## Why a practice`, list
   the separate occasions this came up, each with its date and a link or quote.
   One instance is one person's passing remark, and a factory that turns that
   into a standing instruction has started overfitting to whoever commented
   last — in a file everyone who works here then inherits.
3. **Replace, do not accumulate.** Those files are read on every run, so every
   line is paid for on every run, for as long as the repo exists. If the file
   is near its budget, consolidate: merge lines that overlap, delete what no
   longer holds, move a grown section into a file read on demand. A practice
   that supersedes an existing line deletes that line in the same PR and quotes
   it in the body. The gate fails a file over budget, so appending past the cap
   will not land.

Never write prose into `.factory/`. That is the text that governs you — the
policy that says what this pipeline may change, the guardrails every change is
gated on, these instructions. A hardener that edits its own constraints is not
hardening anything. `practices.md` is for practices a person states through
`/practice`, and it is not yours either.

## 3. Verify the check itself

The new rule or test **must fail on the original bad example and pass on the
correct pattern.** Show both in the PR. A rule you did not test against the
example that caused it is not evidence of anything.

A written practice has nothing to run, which is exactly why §2 asks for the
instances instead. Do not dress one up as verified; say plainly that it is a
practice, and let the two instances and the superseded line be the evidence.

## 4. Fix the existing violations

- **25 or fewer, across 20 or fewer files** → fix them in this PR.
- **More** → record a baseline and seed gardening items, most violations first.

## The PR

A reviewer is answering one question: *is this a change we want?* So give them:
the change in plain language, why you chose this lever over the other three, a
link to the correction that led to it (the work item's source link, in the PR
body), proof it catches the bad example and passes the good one, and what it
costs: how many violations exist and whether they are fixed or baselined.

For a written practice, instead of that proof: the `## Why a practice` heading
with its two or more instances, and the line it supersedes if it supersedes
one.

They are not reviewing your rule's code. Do not make them read it to find out
what it does.

## Do not

- Do not weaken anything. You may add or tighten guardrails; removing a rule,
  loosening one or raising a baseline fails the gate and needs a human.
- Do not write prose into `.factory/`. It is not yours to change.
- Do not choose the refactor, or the rule, out of habit. Compare all three.
- Do not reach for the written practice because it is the quickest thing to
  type. It is the only lever that cannot prove itself, so it is the one to
  justify hardest, and §2's three conditions are gates, not advice.
- Do not append a practice to a file that is already near its budget. Those
  files cost every run; consolidate instead.
- Do not fix the single instance and call it hardening.
