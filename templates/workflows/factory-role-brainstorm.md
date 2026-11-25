---
# Brainstorm role. Compiled by `gh aw compile` into factory-role-brainstorm.lock.yml.
#
# The conversation held with the author before anything is built, as one job
# that stays alive. A turn used to be a whole workflow run — a comment woke
# intake, intake requeued the item, a role started from scratch and built a
# sandbox it never used in order to ask one question. Three to five minutes a
# turn, which is correspondence rather than conversation. Here the agent asks
# with `bsf brainstorm say` and blocks on `bsf brainstorm wait`, so a turn
# costs the model call and nothing else.
#
# It is a separate workflow from triage for two reasons, and the second is the
# one that settles it. Triage starts the sandbox because it reproduces bugs,
# and a conversation never needs a running app. And the sandbox needs
# FACTORY_SANDBOX_ENV, which is deliberately held in a pre-agent step and out
# of the agent's own environment; a role that does not start a sandbox should
# never be handed that secret at all, which is why it is not in this file.
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
        default: product_work
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

github-app:
  client-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
  private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}

engine:
  id: claude
  model: ${{ inputs.model }}
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    # How `bsf brainstorm` reaches GitHub from inside the agent's container.
    # The engine's env rather than $GITHUB_ENV, so the token is scoped to the
    # agent step instead of being readable by every later step in the job.
    GH_TOKEN: ${{ steps.talk-token.outputs.token }}
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
  # The same list as every other role. A conversation installs nothing, so a
  # shorter list is tempting — but the harness itself fetches from these, and a
  # role that cannot start is worse than a role with egress it does not use.
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


# A ceiling on one conversation. The default is 360, and a job blocked on
# `wait` would hold a runner for six hours at a person's whim; `wait` gives up
# long before this, so reaching it means something is wrong.
sandbox:
  # The agent's own container, not the app's. `bsf sandbox start` — the Docker
  # services and the install — is what a conversation does not need, and that
  # pre-agent step is gone. This block is the isolation the agent itself runs
  # in, and every role has it.
  agent:
    id: awf
    mounts:
      - ${{ github.workspace }}:/workspace:rw

timeout-minutes: 25
# A ceiling per run, in gh-aw AI credits (1 credit = $0.01). A normal run is
# well under it; it stops a runaway before it costs a week's budget.
# A conversation is cheap: a question and a reply, several times over. Well
# under a build, and it stops a loop that will not end from costing real money.
max-ai-credits: 15

tools:
  bash: [":*"]

safe-outputs:
  # A conversation comments and nothing else. It does not label an item, close
  # one or upload anything: a question is not a verdict, and the verdicts
  # belong to triage.
  add-comment:
    target: "*"
    staged: ${{ inputs.staged }}
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
        # Overrides the role engine's GH_TOKEN, which gh-aw copies into this
        # job as well. `steps.talk-token` exists only in the agent job, so
        # inherited here the expression dangles and the compiler warns about
        # it in every repo that compiles this file. Empty is also the right
        # value: detection reads one diff and one transcript off disk and has
        # no business reaching GitHub.
        GH_TOKEN: ""
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
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-brainstorm-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
      PIPELINE: ${{ inputs.pipeline }}
      MODEL: ${{ inputs.model }}
    run: bsf budget reserve --key "$BUDGET_KEY" --pipeline "$PIPELINE" --role brainstorm --model "$MODEL" --cap 15 --detection-model claude-haiku-5-5 --detection-cap 50
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
  # A conversation is the one thing that cannot be batched into a conclusion
  # job. Every other role proposes its writes as safe outputs and a trusted job
  # performs them after the agent exits; a question posted after the run has
  # ended is not a question. So this role gets a token during the run — and
  # only this one, scoped to exactly what a conversation needs.
  #
  # contents:write is for the conversation log on the factory's data ref, not
  # for the repository's own files: every ref the runner writes is under
  # refs/factory/, and the gates refuse a change to tracked files from this
  # pipeline.
  #
  # The agent never posts a comment itself. It calls `bsf brainstorm say`,
  # which is trusted code from the default branch, and that redacts the text
  # and strips the factory's own markers before anything is sent. Same shape as
  # a safe output: the agent proposes words, trusted code performs the write.
  - name: Mint a token for the conversation
    id: talk-token
    uses: actions/create-github-app-token@d72941d797fd3113feb6b93fd0dec494b13a2547 # v1
    with:
      app-id: ${{ vars.FACTORY_APP_CLIENT_ID }}
      private-key: ${{ secrets.FACTORY_APP_PRIVATE_KEY }}
      permission-issues: write
      permission-contents: write
      owner: ${{ github.repository_owner }}
      repositories: ${{ github.event.repository.name }}
  - name: Fetch the work item
    shell: bash
    env:
      GH_TOKEN: ${{ steps.read-token.outputs.token }}
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf fetch-work-item "$WORK_ITEM" --out /tmp/gh-aw/agent/bsf/work-item.json
  - name: Fetch the conversation so far
    shell: bash
    env:
      GH_TOKEN: ${{ steps.read-token.outputs.token }}
      WORK_ITEM: ${{ inputs.work_item }}
    run: bsf brainstorm "$WORK_ITEM" --out /tmp/gh-aw/agent/bsf/brainstorm.txt

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
      BUDGET_KEY: ${{ inputs.budget_key || format('{0}-{1}-brainstorm-{2}', github.run_id, github.run_attempt, inputs.attempt) }}
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
      ROLE: brainstorm
      ATTEMPT: ${{ inputs.attempt }}
      MODEL: ${{ inputs.model }}
    run: bsf step-report --role "$ROLE" --attempt "$ATTEMPT" --model "$MODEL" --out /tmp/gh-aw/agent/bsf/step-report.json
  # The run record is made from these: model, tokens and cost for each role.
  - name: Upload the StepReport
    if: always()
    uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
    with:
      name: step-report-brainstorm
      path: /tmp/gh-aw/agent/bsf/step-report.json
      if-no-files-found: ignore
---

# The conversation

You are talking to the author of a request for `${{ github.repository }}`,
before anything is built. Your job is to understand what they actually want
well enough that the spec stage has something real to work from.

This is a conversation, not a form. **You stay in this session for the whole
of it** — you ask, you wait, they answer, you ask again. Nothing resets
between turns, so a fourth question should obviously follow from the first
three answers.

## The factory's own rules

Read these before anything else, and keep to them:

- `/tmp/gh-aw/agent/bsf/repo-prose.md` — the conventions **this repository** writes
  down for agents, and where they are. Read the files it lists first: they are the
  owners' own statement of how work here is done, they are kept current, and
  everything below supplements them rather than replacing them.
- `.factory/definition/context/fundamentals.md` — what this product is for
- `.factory/definition/context/feature-map.md` — what exists and where
- `.factory/definition/context/practices.md` — practices the owners stated to
  the factory, for what has no home in the codebase

And read the request and the conversation so far:

- `/tmp/gh-aw/agent/bsf/work-item.json` — the request
- `/tmp/gh-aw/agent/bsf/brainstorm.txt` — what has already been said, if anything

## How to talk

One question at a time. Always one. Two questions in a comment get one answer
and you will not know which.

Open before narrow. "What would you be able to do that you cannot now?" earns
a real answer; "should the button be blue or green?" earns a shrug and tells
you nothing you could not have guessed. Narrow questions are for the end,
when only a detail is left.

Ask about the problem, not your solution. If you find yourself asking whether
they want it done the way you were about to do it, you have stopped listening.

Build on the last answer. Quote the part you are following up on, so they can
see you read it.

Short. A sentence or two. They are answering on their phone.

Never ask what you can read. The codebase, the context files and the
conversation are all in front of you. A question whose answer is in
`feature-map.md` wastes their time and tells them you did not look.

## How it ends

The conversation is over when you can write down what they are asking for
**with nothing left to fill in** — no "presumably", no "some kind of", no
placeholder. That is the test. Not a number of turns.

Play it back before you finish. Say what you now believe they want, in your
own words, and mark anything you are assuming. They correct it or they agree;
either is useful. This is their last cheap chance to stop you building the
wrong thing, and it costs them one read.

**Do not write a spec.** Nobody filing a request wants to review a document
about it. The spec stage reads this conversation and does its own research;
your job is to understand, not to design.

**If several questions have not got you there**, the request probably needs a
person more than it needs another question. Say so plainly, say what you do
and do not understand, and stop.

## The commands

Three, and they are the only way you talk to them:

```bash
# Ask. One comment on the issue, one turn in the log, both or neither.
bsf brainstorm say "$WORK_ITEM" --issue <N> --text "your question"

# Wait for the answer. Blocks. Prints what they said, or prints "quiet" on the
# first line if they have gone away.
bsf brainstorm wait "$WORK_ITEM" --issue <N> --author <their login>

# End it, with what you understood.
bsf brainstorm close "$WORK_ITEM" --understood "what they are asking for"
```

The issue number and the author's login are in the work item.

`wait` blocks for up to five minutes. **If it prints `quiet`, stop.** Do not
ask another question into the silence and do not call `wait` again: they have
gone, the log is saved, and their next comment starts a fresh conversation
exactly where this one left off. Ending there costs nothing; holding a runner
open for somebody who has closed their laptop costs real money.

Do not post comments any other way. `say` is what redacts the text and keeps
the log and the issue in step; a comment you write by hand is a turn the next
conversation cannot see.

## What to do

1. Read everything above.
2. If the conversation is empty, ask your first question with `say`. If it is
   not, read it and carry on from where it stopped.
3. `wait` for the answer.
4. If you got one: is there anything left you genuinely cannot write down
   without guessing? If yes, ask the next question and `wait` again. If no,
   play back your understanding with `say`, `wait` once for a correction, and
   then `close`.
5. If you got `quiet`: stop. Say nothing more.
